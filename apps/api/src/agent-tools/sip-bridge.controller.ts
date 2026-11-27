import { Body, Controller, ForbiddenException, Header, HttpCode, Logger, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { timingSafeEqual } from 'crypto';
import { organizationForDialledNumber } from '../common/dialled-number';
import { CALLER_VARIABLE_DEFAULTS } from './caller-profile';
import { AgentToolsService } from './agent-tools.service';

/** The order the dialplan reads them in: `ok|status|name|profile|missing|welcome`. */
export const BRIDGE_FIELDS = ['sip_callerstatus', 'sip_callername', 'sip_callerprofile', 'sip_callermissing', 'sip_welcome'] as const;

/** A value safe to put in a SIP header and to split on `|`: one line, printable, bounded. */
export function headerSafe(value: unknown): string {
  return String(value ?? '')
    .replace(/[\r\n\t|]+/g, ' ')
    .replace(/[^\x20-\x7E -ɏ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/**
 * Who is calling, asked by the SIP bridge (Asterisk CURL) as a call arrives,
 * BEFORE it is passed to the ElevenLabs agent. The bridge sends the answer on
 * as X- SIP headers, which ElevenLabs exposes as `{{sip_…}}` variables in the
 * first message and the prompt (see CALLER_VARIABLE_DEFAULTS).
 *
 * Why the bridge and not ElevenLabs' conversation-start webhook: with that
 * webhook on, the live line refused every call ("all circuits are busy") and
 * it is switched off. Here a slow or failed answer costs only the
 * recognition: the dialplan gives up after a few seconds and the call goes on
 * exactly as before, with the defaults.
 *
 * It answers with the same lookup the webhook used (conversationStart: the
 * time budget, withheld numbers, the agency's own numbers), so the two cannot
 * disagree about who is new and who is returning.
 */
@Throttle({ default: { limit: 600, ttl: 60_000 } })
@Controller('api/sip-bridge')
export class SipBridgeController {
  private readonly log = new Logger(SipBridgeController.name);

  constructor(private readonly tools: AgentToolsService) {}

  private secretMatches(given: string | undefined): boolean {
    const want = process.env.SIP_BRIDGE_SECRET?.trim();
    if (!want || !given) return false;
    const a = Buffer.from(want);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  @Post('caller')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain')
  @Header('Cache-Control', 'no-store')
  async caller(@Body() body: { secret?: string; from?: string; to?: string }): Promise<string> {
    if (!this.secretMatches(body?.secret)) throw new ForbiddenException('not-recognised');
    const from = (body?.from ?? '').trim();
    const to = (body?.to ?? '').trim();
    const organizationId = await organizationForDialledNumber(to, process.env.SIP_BRIDGE_ORGANIZATION_SLUG).catch(() => null);
    if (!organizationId) {
      this.log.warn(`sip_bridge_unknown_number to=${to}`);
      return ['unknown', ...BRIDGE_FIELDS.map((f) => headerSafe(CALLER_VARIABLE_DEFAULTS[f]))].join('|');
    }
    const reply = await this.tools.conversationStart(organizationId, { caller_id: from, called_number: to });
    const vars: Record<string, string> = { ...CALLER_VARIABLE_DEFAULTS, ...reply.dynamic_variables };
    this.log.log(`sip_bridge_caller org=${organizationId} status=${vars.sip_callerstatus}`);
    return ['ok', ...BRIDGE_FIELDS.map((f) => headerSafe(vars[f]))].join('|');
  }
}
