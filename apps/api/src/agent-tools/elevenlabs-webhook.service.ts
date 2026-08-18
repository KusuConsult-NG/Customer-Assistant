/**
 * Turning a finished ElevenLabs conversation into records in this platform.
 *
 * When the agent answers a call or a WhatsApp thread, the conversation happens
 * entirely on ElevenLabs' side — we see it only through tool calls, which show
 * what was DONE but not what was SAID. The post-call webhook is the only thing
 * that puts the transcript, the summary and the duration where staff can read
 * them. Without it, a customer's complaint about what the AI told them has no
 * evidence on our side at all.
 *
 * ── Which tenant this belongs to ────────────────────────────────────────────
 *
 * The payload carries an `agent_id` and nothing else that identifies us, so the
 * tenant is resolved from HostedAgentConfig by that id — and if no organization
 * claims it, the delivery is DROPPED with a loud log. There is no fallback to
 * "the first organization", which is how a stranger's call transcript ends up
 * in someone's CRM. `agentId` is unique in the schema so the lookup cannot be
 * ambiguous in the first place.
 *
 * ── Redelivery ─────────────────────────────────────────────────────────────
 *
 * Webhook delivery is at-least-once everywhere, and there is no reason to think
 * this one is different. Both writes are therefore idempotent by construction
 * rather than by checking first:
 *
 *   - a call upserts on CallLog.callSid, which is unique
 *   - each transcript turn is inserted with a deterministic Message.externalId
 *     (`<conversation_id>:<index>`), which is unique
 *
 * A finished transcript does not change, so replaying a delivery writes nothing
 * new. A check-then-insert would not close this: two retries can be in flight
 * at once and both would pass the check.
 */
import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { ChannelType, MessageSender } from '@ace/database';
import { AceLogger } from '../config/logger';

const log = new AceLogger('ElevenLabsWebhook');

/**
 * The post-call payload, in the shape it arrives on the wire.
 *
 * snake_case deliberately: the SDK converts to camelCase for ITS callers, but
 * a webhook body is not an SDK response — it is raw JSON, and it is snake_case.
 * The field names below are taken from GetConversationResponseModel, which is
 * the same object the conversations API returns.
 */
export interface PostCallPayload {
  type?: string;
  event_timestamp?: number;
  data?: {
    agent_id?: string;
    conversation_id?: string;
    status?: string;
    transcript?: Array<{
      role?: string;
      message?: string | null;
      time_in_call_secs?: number;
    }>;
    metadata?: {
      start_time_unix_secs?: number;
      call_duration_secs?: number;
      termination_reason?: string;
      phone_call?: {
        type?: string;
        direction?: string;
        call_sid?: string;
        agent_number?: string;
        external_number?: string;
        phone_number_id?: string;
      };
      whatsapp?: {
        direction?: string;
        whatsapp_user_id?: string;
        whatsapp_phone_number_id?: string;
      };
    };
    analysis?: {
      transcript_summary?: string;
      call_successful?: string;
      call_summary_title?: string;
    };
  };
}

export type IngestOutcome =
  | { handled: true; kind: 'voice' | 'whatsapp'; organizationId: string; reference: string }
  | { handled: false; reason: string };

@Injectable()
export class ElevenLabsWebhookService {
  /**
   * Persist one delivery.
   *
   * Never throws for a payload we cannot use — an unknown agent or an event
   * type we do not handle is a reported non-outcome, not an error, because the
   * caller has already ACKed and an exception would only be logged twice.
   */
  async ingest(payload: PostCallPayload, correlationId: string): Promise<IngestOutcome> {
    const type = payload?.type ?? 'unknown';
    const data = payload?.data;

    // Audio and call-initiation-failure events are real event types we have not
    // built handling for. Saying so beats logging them as errors.
    if (type !== 'post_call_transcription') {
      log.info('elevenlabs_webhook_ignored_type', { correlationId, type });
      return { handled: false, reason: `unhandled event type "${type}"` };
    }

    const agentId = data?.agent_id;
    const conversationId = data?.conversation_id;
    if (!agentId || !conversationId) {
      log.warn('elevenlabs_webhook_missing_identifiers', {
        correlationId,
        hasAgentId: Boolean(agentId),
        hasConversationId: Boolean(conversationId),
      });
      return { handled: false, reason: 'payload has no agent_id or conversation_id' };
    }

    // findMany, not findFirst: if two organizations somehow claim the same
    // agent, "the first one" is a coin flip that files a stranger's transcript
    // — and the caller's phone number — into someone else's CRM. An ambiguous
    // delivery is dropped and shouted about instead.
    const configs = await prisma.hostedAgentConfig.findMany({
      where: { agentId },
      select: { organizationId: true },
      take: 2,
    });
    if (configs.length === 0) {
      log.warn('elevenlabs_webhook_unknown_agent', { correlationId, agentId, conversationId });
      return { handled: false, reason: `no organization is configured for agent ${agentId}` };
    }
    if (configs.length > 1) {
      log.error(
        'elevenlabs_webhook_ambiguous_agent',
        new Error('More than one organization claims this agent id'),
        { correlationId, agentId, conversationId }
      );
      return {
        handled: false,
        reason: `agent ${agentId} is claimed by more than one organization — refusing to guess`,
      };
    }

    const organizationId = configs[0].organizationId;
    const meta = data?.metadata ?? {};

    if (meta.phone_call) {
      return this.ingestCall(organizationId, data!, correlationId);
    }
    if (meta.whatsapp) {
      return this.ingestWhatsApp(organizationId, data!, correlationId);
    }

    // No phone number and no WhatsApp id means nothing to attach the
    // conversation to. Recording it against a placeholder contact would invent
    // a customer who does not exist.
    log.info('elevenlabs_webhook_no_channel_identity', {
      correlationId,
      organizationId,
      conversationId,
    });
    return { handled: false, reason: 'conversation carries no phone or WhatsApp identity' };
  }

  // ── Voice ──────────────────────────────────────────────────────────────────

  private async ingestCall(
    organizationId: string,
    data: NonNullable<PostCallPayload['data']>,
    correlationId: string
  ): Promise<IngestOutcome> {
    const meta = data.metadata!;
    const call = meta.phone_call!;
    const outbound = call.direction === 'outbound';

    // The customer's number is whichever end is not ours.
    const customerNumber = call.external_number ?? '';
    const agentNumber = call.agent_number ?? '';

    // Prefer the carrier's own id so this row lines up with Twilio's records;
    // fall back to the ElevenLabs conversation id, which is equally unique and
    // equally stable across redelivery.
    const callSid = call.call_sid || data.conversation_id!;

    const startedAt = meta.start_time_unix_secs
      ? new Date(meta.start_time_unix_secs * 1000)
      : new Date();
    const durationSeconds = Math.max(0, Math.round(meta.call_duration_secs ?? 0));

    const contact = customerNumber
      ? await this.contactFor(organizationId, customerNumber)
      : null;

    const transcript = this.renderTranscript(data.transcript ?? []);
    const common = {
      organizationId,
      contactId: contact?.id ?? null,
      fromNumber: outbound ? agentNumber : customerNumber,
      toNumber: outbound ? customerNumber : agentNumber,
      direction: outbound ? ('OUTBOUND' as const) : ('INBOUND' as const),
      status: this.callStatus(data.status),
      durationSeconds,
      transcript: transcript || null,
      summary: data.analysis?.transcript_summary || null,
      startedAt,
      endedAt: new Date(startedAt.getTime() + durationSeconds * 1000),
      // The carrier really is Twilio — ElevenLabs answers the number using the
      // tenant's own Twilio credentials, it does not replace the carrier.
      provider: 'TWILIO' as const,
    };

    // Upsert rather than create: a redelivery must not raise, and a CallLog may
    // already exist for this SID if anything else touched the call first.
    await prisma.callLog.upsert({
      where: { callSid },
      create: { callSid, ...common },
      update: common,
    });

    log.info('elevenlabs_call_ingested', {
      correlationId,
      organizationId,
      callSid,
      durationSeconds,
      turns: data.transcript?.length ?? 0,
    });

    return { handled: true, kind: 'voice', organizationId, reference: callSid };
  }

  private callStatus(status: string | undefined) {
    if (status === 'done') return 'COMPLETED' as const;
    if (status === 'failed') return 'FAILED' as const;
    return 'IN_PROGRESS' as const;
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────────

  private async ingestWhatsApp(
    organizationId: string,
    data: NonNullable<PostCallPayload['data']>,
    correlationId: string
  ): Promise<IngestOutcome> {
    const wa = data.metadata!.whatsapp!;
    const userId = wa.whatsapp_user_id;
    if (!userId) {
      return { handled: false, reason: 'WhatsApp conversation carries no user id' };
    }

    // WhatsApp identifies users by E.164 without the leading "+", which is also
    // exactly what Meta's own webhook gives WhatsappService — so a contact
    // created here and one created by an inbound Meta message are the same row.
    // (Voice contacts keep the carrier's "+" prefix, so the same human can
    // still be two contacts across channels. That split predates this file and
    // is not something to paper over silently here.)
    const contact = await this.contactFor(organizationId, userId);
    const conversation = await this.conversationFor(organizationId, contact.id);

    let written = 0;
    const turns = data.transcript ?? [];
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const content = turn?.message?.trim();
      if (!content) continue; // tool-call-only turns have no text to show

      try {
        await prisma.message.create({
          data: {
            conversationId: conversation.id,
            sender: turn.role === 'user' ? MessageSender.CUSTOMER : MessageSender.AI,
            content,
            // Deterministic, so a redelivery collides with itself instead of
            // duplicating the whole transcript. The insert IS the claim.
            externalId: `${data.conversation_id}:${i}`,
            metadata: {
              elevenLabsConversationId: data.conversation_id,
              timeInCallSecs: turn.time_in_call_secs ?? null,
            },
          },
        });
        written++;
      } catch (err: any) {
        if (err?.code === 'P2002') continue; // already stored by an earlier delivery
        throw err;
      }
    }

    if (written > 0) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });
    }

    log.info('elevenlabs_whatsapp_ingested', {
      correlationId,
      organizationId,
      conversationId: data.conversation_id,
      turns: turns.length,
      written,
    });

    return {
      handled: true,
      kind: 'whatsapp',
      organizationId,
      reference: data.conversation_id!,
    };
  }

  // ── Shared ─────────────────────────────────────────────────────────────────

  private renderTranscript(turns: NonNullable<PostCallPayload['data']>['transcript'] = []): string {
    return turns
      .map((t) => {
        const text = t?.message?.trim();
        if (!text) return null;
        return `${t.role === 'user' ? 'Customer' : 'Agent'}: ${text}`;
      })
      .filter(Boolean)
      .join('\n');
  }

  /** Find or create the customer's contact. Mirrors AgentToolsService.contactFor. */
  private async contactFor(organizationId: string, phoneNumber: string) {
    const existing = await prisma.contact.findFirst({ where: { organizationId, phoneNumber } });
    if (existing) return existing;
    try {
      return await prisma.contact.create({
        data: {
          organizationId,
          phoneNumber,
          fullName: `Caller (···${phoneNumber.slice(-4)})`,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const contact = await prisma.contact.findFirst({
          where: { organizationId, phoneNumber },
        });
        if (contact) return contact;
      }
      throw err;
    }
  }

  private async conversationFor(organizationId: string, contactId: string) {
    const channel = ChannelType.WHATSAPP;
    const existing = await prisma.conversation.findFirst({
      where: { organizationId, contactId, channel },
    });
    if (existing) return existing;
    try {
      return await prisma.conversation.create({ data: { organizationId, contactId, channel } });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const conversation = await prisma.conversation.findFirst({
          where: { organizationId, contactId, channel },
        });
        if (conversation) return conversation;
      }
      throw err;
    }
  }
}
