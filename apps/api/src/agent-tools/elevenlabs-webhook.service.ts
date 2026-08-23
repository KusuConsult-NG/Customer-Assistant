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
import { MissedCallFollowUpService } from './missed-call-followup.service';

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
    // WhatsApp failed — fall through to SMS only if it's NOT a template-pending issue.
    // Template-pending errors are transient (Meta approves within hours), so we should
    // NOT burn an SMS on it — the message will be retried when the template is approved.
    // The waDelivered=false case logs a warning with error detail already.
  } else {
    log.info('post_call_whatsapp_skipped', {
      correlationId, contactId,
      reason: 'ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID not set — import account at elevenlabs.io/app/agents/whatsapp',
    });
  }

  // ── Option 2: Twilio SMS fallback ────────────────────────────────────────
  // NOTE: Twilio trial accounts CANNOT send SMS to Nigerian (+234) numbers.
  // They can only SMS to verified numbers on the trial account.
  // To use SMS in production: upgrade to a paid Twilio account.
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !token || !from) {
    log.info('post_call_link_no_twilio', { correlationId, contactId });
    return;
  }

  // Only attempt SMS for non-Nigerian numbers on trial accounts
  // Nigerian numbers start with +234 — trial Twilio rejects them
  const isNigerian = toPhone.startsWith('+234') || toPhone.startsWith('234');
  if (isNigerian) {
    log.warn('post_call_sms_skipped_nigerian', {
      correlationId, contactId, toPhone,
      reason: 'Twilio trial cannot SMS Nigerian (+234) numbers. Upgrade Twilio account or wait for WhatsApp template approval.',
    });
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
 * Sends the selfie-link template message via ElevenLabs' WhatsApp outbound API.
 *
 * Endpoint: POST /v1/convai/whatsapp/outbound-message
 * Docs: https://elevenlabs.io/docs/eleven-agents/api-reference/whats-app/outbound-message
 *
 * WhatsApp REQUIRES a Meta-approved template for the first message to any user.
 * Template "plaschema_selfie_request" must be created in WhatsApp Manager with
 * two named body variables: {{name}} and {{link}}.
 *
 * whatsapp_user_id must be digits-only E.164 without the leading + (per ElevenLabs docs).
 *   +2348033445566 → "2348033445566"
 *
 * Returns true if the API accepted the message, false to trigger SMS fallback.
 */
async function sendViaElevenLabsWhatsApp(
  apiKey: string,
  agentId: string,
  waPhoneNumberId: string,
  toPhone: string,
  firstName: string,
  uploadUrl: string,
  correlationId: string,
  contactId: string
): Promise<boolean> {
  try {
    // whatsapp_user_id: digits-only, country code, no leading + (ElevenLabs docs requirement)
    const waUserId = toPhone.replace(/^\+/, '').replace(/\D/g, '');

    const payload = {
      agent_id: agentId,
      whatsapp_phone_number_id: waPhoneNumberId,
      whatsapp_user_id: waUserId,
      // Template must be pre-approved in WhatsApp Manager (business.facebook.com)
      template_name: process.env.ELEVENLABS_WHATSAPP_TEMPLATE_NAME ?? 'plaschema_selfie_request',
      template_language_code: process.env.ELEVENLABS_WHATSAPP_TEMPLATE_LANG ?? 'en',
      // template_params: positional parameters matching {{1}}, {{2}} in the template body.
      // Meta ONLY accepts {{1}}, {{2}} numbering — named variables ({{name}}) are rejected.
      // {{1}} = firstName, {{2}} = uploadUrl (must match the order in the template body)
      template_params: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: firstName },   // maps to {{1}} in template body
            { type: 'text', text: uploadUrl },    // maps to {{2}} in template body
          ],
        },
      ],
    };

    const res = await fetch('https://api.elevenlabs.io/v1/convai/whatsapp/outbound-message', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body: any = await res.json().catch(() => ({}));

    if (res.ok) {
      log.info('post_call_selfie_whatsapp_sent', {
        correlationId, contactId, to: toPhone, waUserId, uploadUrl,
        messageId: body?.message_id ?? body?.id,
      });
      return true;
    }

    log.warn('post_call_whatsapp_send_failed', {
      correlationId, contactId, waUserId, status: res.status,
      error: JSON.stringify(body).substring(0, 300),
      hint: res.status === 404
        ? 'Import WhatsApp Business Account at elevenlabs.io/app/agents/whatsapp and set ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID'
        : res.status === 400
          ? 'Template not approved or parameter names mismatch — check WhatsApp Manager'
          : undefined,
    });
    return false;
  } catch (err: any) {
    log.warn('post_call_whatsapp_exception', { correlationId, contactId, error: err?.message });
    return false;
  }
}

/**
 * Initiates an outbound WhatsApp voice call via ElevenLabs.
 *
 * Endpoint: POST /v1/convai/whatsapp/outbound-call
 * Docs: https://elevenlabs.io/docs/eleven-agents/api-reference/whats-app/outbound-call
 *
 * Meta requires a pre-approved "call permission request" template to be sent first.
 * Create template "plaschema_call_request" in WhatsApp Manager (Category: Utility).
 *
 * Use this to proactively call a patient via WhatsApp without going through Twilio —
 * e.g. follow-up after a missed enrollment, appointment reminders, etc.
 */
export async function initiateWhatsAppCall(
  toPhone: string,
  agentId: string,
  correlationId: string
): Promise<{ success: boolean; conversationId?: string; error?: string }> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const waPhoneNumberId = process.env.ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID;

  if (!apiKey || !waPhoneNumberId) {
    return { success: false, error: 'ELEVENLABS_WHATSAPP_PHONE_NUMBER_ID not configured — import account at elevenlabs.io/app/agents/whatsapp' };
  }

  const waUserId = toPhone.replace(/^\+/, '').replace(/\D/g, '');

  try {
    const payload = {
      agent_id: agentId,
      whatsapp_phone_number_id: waPhoneNumberId,
      whatsapp_user_id: waUserId,
      // Meta requires a pre-approved template to request call permission
      whatsapp_call_permission_request_template_name:
        process.env.ELEVENLABS_WHATSAPP_CALL_TEMPLATE_NAME ?? 'plaschema_call_request',
      whatsapp_call_permission_request_template_language_code:
        process.env.ELEVENLABS_WHATSAPP_CALL_TEMPLATE_LANG ?? 'en',
    };

    const res = await fetch('https://api.elevenlabs.io/v1/convai/whatsapp/outbound-call', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const body: any = await res.json().catch(() => ({}));

    if (res.ok) {
      log.info('whatsapp_outbound_call_initiated', {
        correlationId, to: toPhone, waUserId,
        conversationId: body?.conversation_id,
      });
      return { success: true, conversationId: body?.conversation_id };
    }

    log.warn('whatsapp_outbound_call_failed', {
      correlationId, waUserId, status: res.status,
      error: JSON.stringify(body).substring(0, 300),
    });
    return { success: false, error: JSON.stringify(body) };
  } catch (err: any) {
    log.warn('whatsapp_outbound_call_exception', { correlationId, error: err?.message });
    return { success: false, error: err?.message };
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
  constructor(private readonly followUp: MissedCallFollowUpService) {}

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

    // Audio events are a real event type we have not built handling for.
    // Saying so beats logging them as errors.
    if (type !== 'post_call_transcription' && type !== 'call_initiation_failure') {
      log.info('elevenlabs_webhook_ignored_type', { correlationId, type });
      return { handled: false, reason: `unhandled event type "${type}"` };
    }

    const agentId = data?.agent_id;
    const conversationId = data?.conversation_id;
    // A failed call may never have been assigned a conversation id — the
    // failure is precisely that the conversation did not start — so only the
    // agent is required to attribute one. A transcript without a conversation
    // id has nothing to key its messages on and is still refused below.
    if (!agentId || (type === 'post_call_transcription' && !conversationId)) {
      log.warn('elevenlabs_webhook_missing_identifiers', {
        correlationId,
        type,
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

    if (type === 'call_initiation_failure') {
      return this.ingestCallFailure(organizationId, payload, correlationId);
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

  // ── A call that never happened ─────────────────────────────────────────────

  /**
   * Record a call the platform failed to answer.
   *
   * This is the only signal that a customer tried to reach the helpline and did
   * not get through — most often because every concurrent-conversation slot on
   * the workspace plan was already in use. Until this existed the event was
   * discarded as an unhandled type, so a caller turned away left no trace
   * anywhere: not in the call log, not in the dashboard, not in any number an
   * agency could act on. "How many people could not reach us today?" had no
   * answer, which is the worst possible state for the one number that decides
   * whether to buy more capacity.
   *
   * Stored as a CallLog with status FAILED rather than in a table of its own:
   * it IS a call attempt, staff already look there, and `callSid` is unique so
   * a redelivery updates one row instead of inflating the count. No schema
   * change, so nothing new is required of the deploy path.
   *
   * ── On the payload shape ──────────────────────────────────────────────────
   *
   * The exact field layout of this event is NOT confirmed against a live
   * delivery — the platform has never taken a real call. Every field is
   * therefore read defensively from the places it plausibly appears, nothing is
   * required beyond the agent id, and the keys actually observed are logged so
   * the first genuine delivery settles the question instead of being silently
   * mangled to fit. A guess written confidently into a call log is worse than a
   * row that admits which parts were missing.
   */
  private async ingestCallFailure(
    organizationId: string,
    payload: PostCallPayload,
    correlationId: string
  ): Promise<IngestOutcome> {
    const data: any = payload?.data ?? {};
    const meta: any = data.metadata ?? {};
    const call: any = meta.phone_call ?? data.phone_call ?? {};

    // Log the shape before interpreting it, so a delivery whose layout differs
    // from this reading is diagnosable from one line rather than from absence.
    log.info('elevenlabs_call_initiation_failure_received', {
      correlationId,
      organizationId,
      dataKeys: Object.keys(data),
      metadataKeys: Object.keys(meta),
      phoneCallKeys: Object.keys(call),
    });

    const reason =
      data.reason ??
      data.error ??
      data.failure_reason ??
      meta.termination_reason ??
      data.status ??
      'unknown';

    const customerNumber = call.external_number ?? data.external_number ?? data.from_number ?? '';
    const agentNumber = call.agent_number ?? data.agent_number ?? data.to_number ?? '';
    const outbound = (call.direction ?? data.direction) === 'outbound';

    // Same key as a successful call, for the same reason: it must be stable
    // across redelivery. Falling back to the event timestamp keeps two distinct
    // failures apart when the provider sends neither id.
    const callSid =
      call.call_sid ??
      data.call_sid ??
      data.conversation_id ??
      `initiation-failure:${organizationId}:${payload?.event_timestamp ?? Date.now()}`;

    const startedAt = meta.start_time_unix_secs
      ? new Date(meta.start_time_unix_secs * 1000)
      : payload?.event_timestamp
        ? new Date(payload.event_timestamp * 1000)
        : new Date();

    const contact = customerNumber
      ? await this.contactFor(organizationId, customerNumber)
      : null;

    const row = {
      organizationId,
      contactId: contact?.id ?? null,
      fromNumber: outbound ? agentNumber : customerNumber,
      toNumber: outbound ? customerNumber : agentNumber,
      direction: outbound ? ('OUTBOUND' as const) : ('INBOUND' as const),
      status: 'FAILED' as const,
      durationSeconds: 0,
      // Says what happened in the words the provider used, so staff reading the
      // log see the provider's reason rather than our paraphrase of it.
      summary: `Call could not be connected (${reason}).`,
      startedAt,
      endedAt: startedAt,
      provider: 'TWILIO' as const,
    };

    await prisma.callLog.upsert({
      where: { callSid },
      create: { callSid, ...row },
      update: row,
    });

    log.info('elevenlabs_call_initiation_failure_recorded', {
      correlationId,
      organizationId,
      callSid,
      reason,
      matchedContact: Boolean(contact),
    });

    // Reach back to the person who could not get through. Fire-and-forget on
    // purpose: the call log is the record that matters and this webhook has
    // already been ACKed, so a follow-up that cannot be sent must not turn a
    // recorded failure into an unrecorded one.
    this.followUp
      .followUp({
        organizationId,
        contactId: contact?.id ?? null,
        customerNumber,
        callSid,
        correlationId,
      })
      .catch(() => {});

    return { handled: true, kind: 'voice', organizationId, reference: callSid };
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
