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
import { prisma, normalizePhoneNumber, phoneNumberVariants } from '@ace/database';
import { ChannelType, MessageSender } from '@ace/database';
import { AceLogger } from '../config/logger';

const log = new AceLogger('ElevenLabsWebhook');

/**
 * Delivers the selfie link to a caller immediately after the call ends.
 *
 * Delivery priority:
 *   1. ElevenLabs WhatsApp outbound message — uses POST /v1/convai/whatsapp/outbound-message.
 *      Requires: (a) a WhatsApp Business Account imported in the ElevenLabs dashboard
 *      at elevenlabs.io/app/agents/whatsapp, (b) a Meta-approved message template named
 *      "plaschema_selfie_request" with body params [name, link], and (c)
 *      ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID set in .env (copied from ElevenLabs dashboard).
 *      WhatsApp requires an approved template for the FIRST outbound message to any user;
 *      once they reply, free-form messages are allowed in the 24-h window.
 *   2. Twilio SMS fallback — uses the same Twilio credentials already in use for
 *      telephony. Works on paid Twilio accounts; trial accounts only reach verified numbers.
 *
 * Fire-and-forget: called from ingestCall() after the call log is written.
 */
async function sendPostCallLink(
  contactId: string,
  toPhone: string,
  firstName: string,
  organizationId: string,
  correlationId: string
): Promise<void> {
  // Retrieve the pending selfie request for this contact
  const selfieReq = await prisma.selfieRequest.findFirst({
    where: { contactId, status: 'PENDING' },
    orderBy: { createdAt: 'desc' },
    select: { id: true, uploadUrl: true },
  }).catch(() => null);

  if (!selfieReq?.uploadUrl) {
    log.info('post_call_link_no_pending_selfie', { correlationId, contactId });
    return;
  }

  const uploadUrl = selfieReq.uploadUrl;

  // ── Option 1: ElevenLabs WhatsApp outbound message ───────────────────────
  // Endpoint: POST /v1/convai/whatsapp/outbound-message
  // Docs: https://elevenlabs.io/docs/eleven-agents/api-reference/whats-app/outbound-message
  //
  // Prerequisites:
  //  • WhatsApp Business Account imported at elevenlabs.io/app/agents/whatsapp
  //  • ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID set in .env (from the ElevenLabs dashboard)
  //  • Meta-approved template "plaschema_selfie_request" (create in WhatsApp Manager)
  //
  // WhatsApp only allows template messages for the first contact with a user.
  // Once the user replies, 24-hour free-form window opens.
  const elApiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const waPhoneNumberId = process.env.ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID;

  if (elApiKey && agentId && waPhoneNumberId) {
    const waDelivered = await sendViaElevenLabsWhatsApp(
      elApiKey, agentId, waPhoneNumberId, toPhone, firstName, uploadUrl, correlationId, contactId
    );
    if (waDelivered) return; // WhatsApp succeeded — no need for SMS fallback
  } else {
    log.info('post_call_whatsapp_skipped', {
      correlationId, contactId,
      reason: 'ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID not set — import account at elevenlabs.io/app/agents/whatsapp',
    });
  }

  // ── Option 2: Twilio SMS fallback ────────────────────────────────────────
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    log.info('post_call_link_no_twilio', { correlationId, contactId });
    return;
  }

  const smsBody =
    `Hi ${firstName}, your PLASCHEMA registration is confirmed! ✅\n\n` +
    `Complete your profile by uploading a selfie here:\n${uploadUrl}\n\n` +
    `Helpline: 0700-700-1111`;

  try {
    const params = new URLSearchParams({ To: toPhone, From: from, Body: smsBody });
    const authHeader = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      }
    );
    const resp: any = await res.json().catch(() => ({}));
    if (res.ok) {
      log.info('post_call_selfie_sms_sent', { correlationId, contactId, to: toPhone, sid: resp.sid, uploadUrl });
    } else {
      log.warn('post_call_selfie_sms_failed', { correlationId, contactId, status: res.status, code: resp.code, message: resp.message });
    }
  } catch (err: any) {
    log.warn('post_call_selfie_sms_exception', { correlationId, contactId, error: err?.message });
  }
}

/**
 * Sends the selfie link via ElevenLabs' WhatsApp channel integration.
 *
 * ElevenLabs acts as the WhatsApp Business API gateway — once a WhatsApp
 * Business number is connected in the ElevenLabs dashboard (Conversational AI
 * → Sarah → Channels → WhatsApp), this sends an outbound WhatsApp message
 * through that connected number.
 *
 * Returns true if the message was accepted, false if no WhatsApp channel is
 * configured or the send failed (triggers SMS fallback in the caller).
 */
async function sendViaElevenLabsWhatsApp(
  apiKey: string,
  agentId: string,
  toPhone: string,
  firstName: string,
  uploadUrl: string,
  correlationId: string,
  contactId: string
): Promise<boolean> {
  try {
    // Fetch connected WhatsApp phone numbers from ElevenLabs workspace
    const numbersResp = await fetch(
      `https://api.elevenlabs.io/v1/convai/agents/${agentId}/channels`,
      { headers: { 'xi-api-key': apiKey } }
    );
    const channels = await numbersResp.json().catch(() => ({ results: [] }));
    const waChannel = (channels.results || []).find((ch: any) => ch.type === 'whatsapp' || ch.id === 'whatsapp');

    if (!waChannel) {
      log.info('post_call_whatsapp_no_channel', { correlationId, contactId, hint: 'Connect a WhatsApp Business number in the ElevenLabs dashboard → Channels' });
      return false;
    }

    const waPhoneNumberId = waChannel.phone_number_id || waChannel.id;

    // Send an outbound WhatsApp message via ElevenLabs
    // ElevenLabs routes this through the connected WhatsApp Business number
    const msgBody = {
      to: toPhone,
      agent_id: agentId,
      message: {
        type: 'text',
        text: {
          body:
            `Hi ${firstName}! 👋 Your PLASCHEMA registration is confirmed! ✅\n\n` +
            `To complete your health coverage enrollment, please upload your photo here:\n${uploadUrl}\n\n` +
            `This link is valid for 48 hours. Once uploaded, our team will activate your coverage within 2 working days.\n\n` +
            `Questions? Call the PLASCHEMA Helpline: *0700-700-1111*`,
        },
      },
    };

    const sendResp = await fetch(
      `https://api.elevenlabs.io/v1/convai/whatsapp/send`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(msgBody),
      }
    );

    if (sendResp.ok) {
      const r = await sendResp.json().catch(() => ({}));
      log.info('post_call_selfie_whatsapp_sent', { correlationId, contactId, to: toPhone, uploadUrl, messageId: (r as any)?.message_id });
      return true;
    }

    const errBody = await sendResp.json().catch(() => ({}));
    log.info('post_call_whatsapp_send_failed', { correlationId, contactId, status: sendResp.status, error: JSON.stringify(errBody).substring(0, 200) });
    return false;
  } catch (err: any) {
    log.info('post_call_whatsapp_exception', { correlationId, contactId, error: err?.message });
    return false;
  }
}

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
   * `verifiedFor` names the workspace whose secret actually verified this
   * request: an organization id for a per-tenant workspace, or null for the
   * shared one signed by ELEVENLABS_WEBHOOK_SECRET. It is checked against the
   * tenant the payload resolves to, because a valid signature only proves WHO
   * SENT the delivery, never who it may be filed against — and this whole file
   * writes transcripts and phone numbers into a CRM on the strength of an
   * `agent_id` in the body.
   *
   * Never throws for a payload we cannot use — an unknown agent or an event
   * type we do not handle is a reported non-outcome, not an error, because the
   * caller has already ACKed and an exception would only be logged twice.
   */
  async ingest(
    payload: PostCallPayload,
    correlationId: string,
    verifiedFor: string | null = null
  ): Promise<IngestOutcome> {
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
      select: { organizationId: true, apiKey: true },
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

    // ── The signature says who sent this; it does not say who it is about ─────
    //
    // Two ways those come apart, both of which would file one tenant's call
    // transcript and the caller's phone number into another tenant's CRM:
    //
    //   1. A per-tenant delivery naming somebody else's agent. The URL selected
    //      whose secret to check, so the signature is genuinely valid — for the
    //      wrong tenant.
    //   2. A shared-workspace delivery naming an agent that belongs to a tenant
    //      who has since moved into a workspace of their own. Its transcripts
    //      are no longer the shared workspace's to send.
    //
    // Neither is a rejection at the HTTP layer, because the sender is who they
    // claim to be. It is a refusal to attribute, which is a different thing.
    const attributedTo = verifiedFor ?? null;
    if (attributedTo && attributedTo !== organizationId) {
      log.error(
        'elevenlabs_webhook_cross_tenant_attribution',
        new Error('A workspace delivered a conversation belonging to another organization'),
        { correlationId, agentId, conversationId, verifiedFor: attributedTo, organizationId }
      );
      return {
        handled: false,
        reason: `agent ${agentId} belongs to a different organization than the workspace that signed this delivery`,
      };
    }
    if (!attributedTo && configs[0].apiKey) {
      log.error(
        'elevenlabs_webhook_shared_secret_for_dedicated_tenant',
        new Error('The shared workspace secret verified a delivery for a tenant that has its own'),
        { correlationId, agentId, conversationId, organizationId }
      );
      return {
        handled: false,
        reason: `agent ${agentId} belongs to an organization with its own workspace — its deliveries must arrive on that organization's own webhook URL`,
      };
    }

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

    // Fire-and-forget: if a selfie request was created during this call's
    // register-enrollee tool call, send the link via SMS now that the call
    // is confirmed ended and the phone number is verified.
    if (contact) {
      const firstName = contact.fullName?.split(' ')[0] || 'there';
      sendPostCallLink(contact.id, customerNumber, firstName, organizationId, correlationId).catch(() => {});
    }

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
    const existing = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
    });
    if (existing) return existing;
    try {
      return await prisma.contact.create({
        data: {
          organizationId,
          phoneNumber: normalizePhoneNumber(phoneNumber),
          fullName: `Caller (···${phoneNumber.slice(-4)})`,
        },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const contact = await prisma.contact.findFirst({
          where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
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
