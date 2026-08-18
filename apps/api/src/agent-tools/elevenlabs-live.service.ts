/**
 * The live view of conversations the ElevenLabs agent is having right now.
 *
 * ── What is actually possible, and what is not ──────────────────────────────
 *
 * ElevenLabs does not push anything mid-conversation. Their webhook event types
 * are `transcript`, `audio`, `call_initiation_failure` and the unredacted
 * variants — every one of them fires AFTER the call ends. `getSignedUrl` and
 * `getWebrtcToken` exist, but they are for a client joining a conversation as
 * the user, not for a third party watching one.
 *
 * So there is no stream to subscribe to. What there is: `conversations.list`
 * returns conversations whose status is still `in-progress`, and
 * `conversations.get` returns the transcript so far. A live console is
 * therefore POLLED, and this file is honest about being a poller rather than
 * dressing it up as a stream.
 *
 * ── Snapshots, not deltas ───────────────────────────────────────────────────
 *
 * Every emit carries the whole transcript so far plus a turn count. That costs
 * a few hundred bytes and buys three things a delta feed would have to earn the
 * hard way: a console that connects mid-call is correct on the next tick, a
 * duplicate emit is visually a no-op, and two pods polling the same tenant
 * cannot interleave into a garbled transcript. With a polling source and a
 * multi-pod Socket.IO fan-out, that is the difference between "occasionally
 * wrong in a way nobody can reproduce" and "always right".
 *
 * ── Polling only what someone is watching ───────────────────────────────────
 *
 * A tenant with nobody at the console generates no ElevenLabs traffic at all.
 * Watchers register on connect and drop off on disconnect; the timer stops when
 * the last one leaves. An always-on poller across every tenant would spend a
 * rate limit budget on an empty room.
 */
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { prisma } from '@ace/database';
import { ElevenLabsApi } from './elevenlabs-client';

/** How often a watched organization is polled. */
export const POLL_INTERVAL_MS = 4_000;

/**
 * A conversation is only interesting while it is still happening. `processing`
 * is included because the transcript is complete by then but the post-call
 * webhook has not necessarily landed — the console should not blank out in the
 * gap.
 */
const LIVE_STATUSES = new Set(['initiated', 'in-progress', 'processing']);

export interface LiveTurn {
  role: 'agent' | 'user';
  message: string;
  timeInCallSecs: number;
}

export interface LiveConversation {
  conversationId: string;
  agentId: string;
  status: string;
  startedAt: string;
  durationSecs: number;
  channel: 'voice' | 'whatsapp' | 'other';
  /** The customer's number, when the channel gives us one. */
  customerNumber: string | null;
  turns: LiveTurn[];
  /** Monotonic within a conversation. A snapshot with a lower count is stale. */
  turnCount: number;
}

/** What the gateway needs from us without importing it (and creating a cycle). */
export interface LiveSink {
  emitLiveConversations(organizationId: string, conversations: LiveConversation[]): void;
  emitConversationEnded(organizationId: string, conversationId: string): void;
}

@Injectable()
export class ElevenLabsLiveService implements OnModuleDestroy {
  private readonly log = new Logger('ElevenLabsLive');

  /** organizationId → number of console sockets currently watching. */
  private readonly watchers = new Map<string, number>();

  /** Conversations we have already reported, so an ending can be announced once. */
  private readonly seen = new Map<string, Set<string>>();

  private timer: NodeJS.Timeout | null = null;
  private sink: LiveSink | null = null;

  constructor(private readonly api: ElevenLabsApi) {}

  /**
   * Where snapshots go. Set by the gateway at construction rather than injected
   * the other way round — the gateway already depends on nothing, and a service
   * importing a gateway that imports the service is a cycle Nest resolves at
   * runtime by handing one of them `undefined`.
   */
  attach(sink: LiveSink): void {
    this.sink = sink;
  }

  onModuleDestroy(): void {
    this.stopTimer();
  }

  // ── Who is watching ────────────────────────────────────────────────────────

  watch(organizationId: string): void {
    this.watchers.set(organizationId, (this.watchers.get(organizationId) ?? 0) + 1);
    this.startTimer();
  }

  unwatch(organizationId: string): void {
    const count = (this.watchers.get(organizationId) ?? 0) - 1;
    if (count > 0) {
      this.watchers.set(organizationId, count);
      return;
    }
    this.watchers.delete(organizationId);
    this.seen.delete(organizationId);
    if (this.watchers.size === 0) this.stopTimer();
  }

  watchedOrganizations(): string[] {
    return [...this.watchers.keys()];
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollAll();
    }, POLL_INTERVAL_MS);
    // Never hold the process open for a console nobody is looking at.
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  /**
   * One round for every watched organization.
   *
   * Each tenant is isolated: one tenant's expired key or rate limit must not
   * stop everyone else's console updating, so a failure is logged and the loop
   * continues.
   */
  async pollAll(): Promise<void> {
    for (const organizationId of this.watchedOrganizations()) {
      try {
        const conversations = await this.fetchLive(organizationId);
        this.emit(organizationId, conversations);
      } catch (err: any) {
        // Deliberately not escalated: a console that stops updating is bad, a
        // console that stops updating for every tenant because one key expired
        // is worse.
        this.log.warn(
          `live_poll_failed org=${organizationId} error=${err?.message ?? 'unknown'}`
        );
      }
    }
  }

  private emit(organizationId: string, conversations: LiveConversation[]): void {
    const previous = this.seen.get(organizationId) ?? new Set<string>();
    const current = new Set(conversations.map((c) => c.conversationId));

    this.sink?.emitLiveConversations(organizationId, conversations);

    // Announce endings explicitly. A console that only ever receives the live
    // list has to infer an ending from an absence, and an absence is also what
    // a failed poll looks like.
    for (const id of previous) {
      if (!current.has(id)) this.sink?.emitConversationEnded(organizationId, id);
    }
    this.seen.set(organizationId, current);
  }

  /**
   * Everything this organization's agent is saying right now.
   *
   * Public so the console can fetch a snapshot on load rather than waiting a
   * poll interval to see anything.
   */
  async fetchLive(organizationId: string): Promise<LiveConversation[]> {
    const config = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { agentId: true, apiKey: true },
    });
    // No agent means nothing to watch. Not an error — most tenants are here.
    if (!config?.agentId) return [];

    const client = this.api.for(this.api.keyFor(organizationId, config.apiKey));

    let page;
    try {
      // Scoped to this tenant's agent. The workspace may hold other tenants'
      // conversations, and a console must never show them.
      page = await client.conversationalAi.conversations.list({
        agentId: config.agentId,
        pageSize: 30,
      });
    } catch (err) {
      this.api.fail('the live conversation list', err);
    }

    const live = (page.conversations ?? []).filter((c: any) => LIVE_STATUSES.has(c.status));
    if (live.length === 0) return [];

    const details = await Promise.all(
      live.map(async (summary: any) => {
        try {
          const full = await client.conversationalAi.conversations.get(summary.conversationId);
          return this.describe(full, summary);
        } catch (err: any) {
          // One unreadable conversation must not blank the whole console, so
          // it degrades to what the list already told us — a real conversation
          // with no transcript yet, which is also what a call that just
          // connected looks like.
          this.log.warn(
            `live_conversation_unreadable org=${organizationId} conversation=${summary.conversationId} error=${err?.message}`
          );
          return this.describe(null, summary);
        }
      })
    );

    return details;
  }

  /**
   * Build a snapshot from the conversation detail, falling back to the list
   * summary when the detail could not be read.
   */
  private describe(full: any | null, summary: any): LiveConversation {
    const meta = full?.metadata ?? {};
    const phone = meta.phone_call ?? meta.phoneCall;
    const whatsapp = meta.whatsapp;

    const turns: LiveTurn[] = (full?.transcript ?? [])
      .map((t: any) => ({
        role: t.role === 'user' ? ('user' as const) : ('agent' as const),
        message: (t.message ?? '').trim(),
        timeInCallSecs: t.time_in_call_secs ?? t.timeInCallSecs ?? 0,
      }))
      // Tool-call-only turns carry no text. Showing them as blank bubbles makes
      // the console look broken.
      .filter((t: LiveTurn) => t.message.length > 0);

    const startSecs =
      meta.start_time_unix_secs ?? meta.startTimeUnixSecs ?? summary.startTimeUnixSecs ?? 0;

    return {
      conversationId: full?.conversationId ?? summary.conversationId,
      agentId: full?.agentId ?? summary.agentId,
      status: full?.status ?? summary.status,
      startedAt: new Date(startSecs * 1000).toISOString(),
      durationSecs:
        meta.call_duration_secs ?? meta.callDurationSecs ?? summary.callDurationSecs ?? 0,
      channel: phone ? 'voice' : whatsapp ? 'whatsapp' : 'other',
      customerNumber:
        phone?.external_number ??
        phone?.externalNumber ??
        whatsapp?.whatsapp_user_id ??
        whatsapp?.whatsappUserId ??
        null,
      turns,
      turnCount: turns.length,
    };
  }
}
