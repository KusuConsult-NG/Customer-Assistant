import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { CallDirection, CallStatus, TelephonyProviderType } from '@ace/shared-types';
import { ElevenLabsApi } from '../agent-tools/elevenlabs-client';

/**
 * Dialling OUT on the agency's own SIP trunk.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A State's toll-free number already in service cannot be handed to Twilio, so
 * it reaches this platform over a SIP trunk from the carrier that holds it.
 * That gave us inbound and nothing else: `SipTrunkProvider.initiateCall`
 * refuses, correctly, because this platform holds no SIP stack and cannot
 * originate on a trunk itself.
 *
 * Which meant a promised callback could never be placed on the one number the
 * agency publishes. The callback would fail honestly — recorded with the
 * reason, never marked complete — but it would fail.
 *
 * ElevenLabs already holds the trunk: the import sends `outboundTrunkConfig`
 * alongside the inbound side, and the SDK exposes
 * `conversationalAi.sipTrunk.outboundCall`. So the agent that ANSWERS the
 * number can also PLACE calls on it. One number, both directions, and no SIP
 * stack here — the thing we would otherwise have had to build and operate.
 *
 * ── The trap in the response ────────────────────────────────────────────────
 *
 * `POST /v1/convai/sip-trunk/outbound-call` returns 200 with a body carrying
 * its OWN `success` flag. A 200 therefore does not mean the phone rang. Taking
 * HTTP 200 as success is how a callback gets marked COMPLETED for a call that
 * never happened, which is the single thing this platform must not do — so the
 * body is checked, and a `success: false` is a failure carrying the provider's
 * own message.
 */
@Injectable()
export class SipTrunkOriginationService {
  private readonly log = new Logger('SipTrunkOrigination');

  constructor(private readonly api: ElevenLabsApi) {}

  private baseUrl(): string {
    return (process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  }

  /** True when this tenant can actually originate on its trunk. */
  async canOriginate(organizationId: string): Promise<boolean> {
    const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId } });
    return Boolean(config?.isActive && config.agentId && config.phoneNumberId);
  }

  /**
   * Place a call from the agency's trunk number to a citizen.
   *
   * Returns the same shape the carrier providers return, so the caller writes
   * one CallLog either way and nothing downstream has to know which carrier
   * placed it.
   */
  async placeCall(
    organizationId: string,
    toNumber: string,
    opts: { fromNumber: string; dynamicVariables?: Record<string, unknown>; firstMessage?: string }
  ): Promise<{ callId: string; conversationId?: string }> {
    const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId } });

    if (!config || !config.isActive) {
      throw new BadRequestException(
        'No active hosted agent is configured for this agency, so there is nothing to place the call with. ' +
        'Provision the agent under Agent Provisioning first.'
      );
    }
    if (!config.agentId) {
      // Sending a null agent id would either be rejected or, worse, routed
      // somewhere by default — this agency's citizen talking to another
      // agency's agent.
      throw new BadRequestException(
        'This agency has no provisioned ElevenLabs agent yet — run a sync before placing calls.'
      );
    }
    if (!config.phoneNumberId) {
      throw new BadRequestException(
        'This agency\'s SIP trunk number has not been imported into ElevenLabs, so there is no number to call from. ' +
        'Import it under Agent Provisioning → Numbers before placing calls.'
      );
    }

    const apiKey = this.api.keyFor(organizationId, config.apiKey);

    // Snake case, deliberately: this is the REST body, not an SDK payload. The
    // SDK converts camelCase itself, and mixing the two conventions is how a
    // field gets silently dropped.
    const body: Record<string, unknown> = {
      agent_id: config.agentId,
      agent_phone_number_id: config.phoneNumberId,
      to_number: toNumber,
    };

    const dynamic = { ...(opts.dynamicVariables ?? {}) };
    if (Object.keys(dynamic).length > 0 || opts.firstMessage) {
      body.conversation_initiation_client_data = {
        ...(Object.keys(dynamic).length > 0 ? { dynamic_variables: dynamic } : {}),
        ...(opts.firstMessage
          ? { conversation_config_override: { agent: { first_message: opts.firstMessage } } }
          : {}),
        source_info: { source: 'sip_trunk' },
      };
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/v1/convai/sip-trunk/outbound-call`, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      // Nothing was delivered. Say that, and say it is not the key — the
      // message is stored against a callback and read by an officer
      // explaining to a citizen why nobody rang.
      const cause = err?.cause?.code || err?.cause?.message || err?.message || 'network error';
      const host = this.baseUrl().replace(/^https?:\/\//, '');
      this.log.error(`sip_outbound_unreachable org=${organizationId} host=${host} error=${cause}`);
      throw new ServiceUnavailableException(
        `Could not reach ${host} to place the call (${cause}). The call was NOT placed, ` +
        `so this is not a rejected key — check outbound network access to ${host}:443.`
      );
    }

    const text = await res.text();
    if (!res.ok) {
      this.log.error(
        `sip_outbound_rejected org=${organizationId} status=${res.status} body=${text.slice(0, 400)}`
      );
      throw new ServiceUnavailableException(
        `ElevenLabs rejected the call (HTTP ${res.status}): ${text.slice(0, 300)}`
      );
    }

    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ServiceUnavailableException('ElevenLabs returned a response that was not JSON.');
    }

    // THE TRAP. A 200 with success:false means the call did not happen.
    if (parsed.success === false) {
      const why = String(parsed.message || 'the provider gave no reason').slice(0, 300);
      this.log.error(`sip_outbound_refused org=${organizationId} reason=${why}`);
      throw new ServiceUnavailableException(`The call was not placed: ${why}`);
    }

    const callId = parsed.sip_call_id || parsed.conversation_id;
    if (!callId) {
      // No identifier means nothing to reconcile the call against later. An
      // invented one would make a missing call look like a completed one.
      throw new ServiceUnavailableException(
        'ElevenLabs accepted the call but returned no call identifier, so it cannot be tracked.'
      );
    }

    this.log.log(
      `sip_outbound_placed org=${organizationId} from=${opts.fromNumber} call=${callId}`
    );

    return { callId, conversationId: parsed.conversation_id };
  }

  /** The shape TelephonyService records, built from a placed call. */
  asCallRecord(
    organizationId: string,
    placed: { callId: string },
    opts: { fromNumber: string; toNumber: string }
  ) {
    return {
      callId: placed.callId,
      organizationId,
      from: opts.fromNumber,
      to: opts.toNumber,
      direction: CallDirection.OUTBOUND,
      status: CallStatus.QUEUED,
      startTime: new Date(),
      provider: TelephonyProviderType.SIP_TRUNK,
    };
  }
}
