import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { prisma } from '@ace/database';
import { ElevenLabsApi } from './elevenlabs-client';
import { ElevenLabsWebhookService, type PostCallPayload } from './elevenlabs-webhook.service';

/**
 * Finished ElevenLabs conversations, PULLED into the platform.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A finished call reached the database only if ElevenLabs POSTed it to the
 * post-call webhook — and that is a setting in the ElevenLabs workspace, not
 * in this code. On the live deployment it pointed somewhere that never
 * arrived: the toll-free line took real calls, ElevenLabs recorded every one,
 * and the dashboard showed "0 calls" and "No activity yet". Nothing failed
 * loudly, because nothing on our side was ever asked to do anything.
 *
 * So the platform no longer depends on being told. Every two minutes it asks
 * ElevenLabs for each agency's recent conversations — with that agency's own
 * key, scoped to that agency's own agent, exactly as the live console does —
 * and feeds any it has not stored through the SAME `ingest()` the webhook
 * uses. One ingestion path, so a call cannot be recorded two different ways.
 *
 * The webhook still works and is still preferred when configured (it arrives
 * the moment a call ends). This makes it an optimisation rather than the only
 * way a call is ever recorded. Ingestion is idempotent (CallLog upserts on
 * callSid, messages carry a deterministic externalId), so the two can overlap.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * It never attributes a conversation to anyone but the organization whose
 * agent it belongs to: it lists by that agent id, and passes the organization
 * as `verifiedFor`, so `ingest()`'s cross-tenant refusal still applies.
 */
const SYNC_INTERVAL_MS = 2 * 60 * 1000;
/** How far back each sweep looks. Old enough to cover a missed sweep or a restart. */
const LOOKBACK_SECS = 24 * 60 * 60;
const PAGE_SIZE = 30;
const MAX_PAGES = 4;
const FINISHED = new Set(['done', 'failed']);

export interface SyncResult {
  organizationId: string;
  seen: number;
  stored: number;
  alreadyStored: number;
  skipped: Array<{ conversationId: string; reason: string }>;
}

/**
 * The SDK's camelCase conversation → the snake_case post-call payload
 * `ingest()` reads. Explicit, field by field: a generic case converter would
 * also rewrite keys inside free-form maps (dynamic variables, tool params).
 */
export function toPostCallPayload(c: any): PostCallPayload {
  const meta = c?.metadata ?? {};
  const pc = meta.phoneCall;
  const wa = meta.whatsapp;
  return {
    type: 'post_call_transcription',
    data: {
      agent_id: c?.agentId,
      conversation_id: c?.conversationId,
      status: c?.status,
      transcript: (c?.transcript ?? []).map((t: any) => ({
        role: t?.role,
        message: t?.message ?? null,
        time_in_call_secs: t?.timeInCallSecs,
      })),
      metadata: {
        start_time_unix_secs: meta.startTimeUnixSecs,
        call_duration_secs: meta.callDurationSecs,
        termination_reason: meta.terminationReason,
        ...(pc
          ? {
              phone_call: {
                type: pc.type,
                direction: pc.direction,
                call_sid: pc.callSid,
                agent_number: pc.agentNumber,
                external_number: pc.externalNumber,
                phone_number_id: pc.phoneNumberId,
              },
            }
          : {}),
        ...(wa
          ? {
              whatsapp: {
                direction: wa.direction,
                whatsapp_user_id: wa.whatsappUserId,
                whatsapp_phone_number_id: wa.whatsappPhoneNumberId,
              },
            }
          : {}),
      },
      analysis: c?.analysis
        ? {
            transcript_summary: c.analysis.transcriptSummary,
            call_successful: c.analysis.callSuccessful,
            call_summary_title: c.analysis.callSummaryTitle,
          }
        : undefined,
    },
  };
}

@Injectable()
export class ElevenLabsCallSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ElevenLabsCallSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly api: ElevenLabsApi,
    private readonly webhooks: ElevenLabsWebhookService,
  ) {}

  onModuleInit(): void {
    // Tests drive syncOrganization() directly; a timer would only leak.
    if (process.env.NODE_ENV === 'test' || process.env.ELEVENLABS_CALL_SYNC === 'off') return;
    this.timer = setInterval(() => void this.syncAll(), SYNC_INTERVAL_MS);
    this.timer.unref?.();
    // First sweep shortly after boot, so a restart does not wait two minutes.
    setTimeout(() => void this.syncAll(), 15_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One sweep over every agency with an agent. One agency's failure is contained. */
  async syncAll(): Promise<SyncResult[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const configs = await prisma.hostedAgentConfig.findMany({
        where: { agentId: { not: null }, isActive: true },
        select: { organizationId: true },
      });
      const results: SyncResult[] = [];
      for (const { organizationId } of configs) {
        try {
          const r = await this.syncOrganization(organizationId);
          if (r.stored > 0) {
            this.log.log(`call_sync org=${organizationId} stored=${r.stored} seen=${r.seen}`);
          }
          results.push(r);
        } catch (err: any) {
          this.log.warn(`call_sync_failed org=${organizationId} error=${err?.message}`);
        }
      }
      return results;
    } finally {
      this.running = false;
    }
  }

  async syncOrganization(organizationId: string, nowUnix = Math.floor(Date.now() / 1000)): Promise<SyncResult> {
    const result: SyncResult = { organizationId, seen: 0, stored: 0, alreadyStored: 0, skipped: [] };
    const config = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { agentId: true, apiKey: true },
    });
    if (!config?.agentId) return result;

    const client = this.api.for(this.api.keyFor(organizationId, config.apiKey));
    const since = nowUnix - LOOKBACK_SECS;

    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: any = await client.conversationalAi.conversations.list({
        agentId: config.agentId,
        pageSize: PAGE_SIZE,
        callStartAfterUnix: since,
        ...(cursor ? { cursor } : {}),
      } as any);
      const items: any[] = res?.conversations ?? [];
      for (const summary of items) {
        if (!FINISHED.has(summary?.status)) continue; // still live: the next sweep gets it
        result.seen++;
        await this.syncOne(client, organizationId, summary.conversationId, result);
      }
      if (!res?.hasMore || !res?.nextCursor) break;
      cursor = res.nextCursor;
    }
    return result;
  }

  private async syncOne(client: any, organizationId: string, conversationId: string, result: SyncResult) {
    // Stored already? A WhatsApp thread is keyed `<conversation>:<turn>`; a
    // call is keyed on the carrier's call SID, which only the detail carries.
    const waStored = await prisma.message.findFirst({
      where: { externalId: { startsWith: `${conversationId}:` }, conversation: { organizationId } },
      select: { id: true },
    });
    if (waStored) {
      result.alreadyStored++;
      return;
    }

    const full = await client.conversationalAi.conversations.get(conversationId);
    const payload = toPostCallPayload(full);
    const callSid = payload.data?.metadata?.phone_call?.call_sid || conversationId;
    if (payload.data?.metadata?.phone_call) {
      const exists = await prisma.callLog.findUnique({ where: { callSid }, select: { organizationId: true } });
      if (exists) {
        result.alreadyStored++;
        return;
      }
    }

    const outcome = await this.webhooks.ingest(payload, `sync:${conversationId}`, organizationId);
    if (outcome.handled) result.stored++;
    else result.skipped.push({ conversationId, reason: outcome.reason });
  }
}
