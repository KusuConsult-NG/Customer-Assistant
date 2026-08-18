import { Injectable, BadRequestException } from '@nestjs/common';
import { prisma, withTelephonyCredentials } from '@ace/database';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WorkflowTriggerService } from '../workflows/workflow-trigger.service';
import { TelephonyFactory } from '@ace/telephony-sdk';
import { TelephonyProviderType, CallDirection, CallStatus } from '@ace/shared-types';
import { AceLogger, generateCorrelationId } from '../config/logger';
import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify } from 'crypto';

const log = new AceLogger('TelephonyService');

/**
 * Public base URL of this API, e.g. https://ace-api.onrender.com
 *
 * This is the single source of truth for the callback and media-stream URLs handed
 * to carriers. It reads API_BASE_URL — the name that is actually provisioned in
 * .env / .env.example / render.yaml.
 *
 * Previously this file read `process.env.API_URL`, which is defined nowhere, so:
 *   - Twilio signature verification hashed the literal "https://your-api-domain.com",
 *     never matched, and every authenticated inbound call was answered with
 *     "This call could not be authenticated. Goodbye.";
 *   - the <Stream> URL fell back to ws://localhost:4000, which Twilio cannot reach,
 *     so no production call ever established a media stream.
 * API_URL is still honoured as a fallback so existing deployments that set it keep working.
 */
function apiBaseUrl(): string {
  return (process.env.API_BASE_URL || process.env.API_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

/**
 * Verifies Twilio's X-Twilio-Signature header.
 *
 * Twilio signs every webhook POST using HMAC-SHA1 over
 * (callbackUrl + sorted_form_params_concatenated) with the auth token as key.
 *
 * Why: Without this, any attacker who learns your webhook URL can
 * simulate incoming calls, trigger AI sessions, and create fake call logs.
 *
 * Ref: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
function verifyTwilioSignature(
  authToken: string,
  signature: string | undefined,
  callbackUrl: string,
  params: Record<string, string>
): boolean {
  if (!signature || !authToken) return false;
  try {
    // Sort params alphabetically and concatenate key+value pairs
    const sortedKeys = Object.keys(params).sort();
    const paramString = sortedKeys.map((k) => `${k}${params[k]}`).join('');
    const computed = createHmac('sha1', authToken)
      .update(callbackUrl + paramString)
      .digest('base64');
    const sigBuf = Buffer.from(signature, 'utf8');
    const compBuf = Buffer.from(computed, 'utf8');
    if (sigBuf.length !== compBuf.length) return false;
    return timingSafeEqual(sigBuf, compBuf);
  } catch {
    return false;
  }
}

/**
 * Verifies Telnyx's Ed25519 webhook signature (timestamp|rawBody, RFC 8410 key,
 * 5-minute replay window). Node verifies Ed25519 natively — the raw 32-byte
 * key just needs a SPKI DER envelope.
 */
function verifyTelnyxSignature(
  publicKeyBase64: string,
  signatureBase64: string | undefined,
  timestamp: string | undefined,
  rawBody: Buffer
): boolean {
  if (!signatureBase64 || !timestamp || !publicKeyBase64) return false;
  try {
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
    const rawKey = Buffer.from(publicKeyBase64, 'base64');
    if (rawKey.length !== 32) return false;
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]);
    const keyObject = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    const message = Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]);
    return cryptoVerify(null, message, keyObject, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Verifies Africa's Talking HMAC signature.
 * AT signs with HMAC-SHA256 using the API key.
 */
function verifyAfricasTalkingSignature(
  apiKey: string,
  signature: string | undefined,
  rawBody: Buffer
): boolean {
  if (!signature || !apiKey) return false;
  try {
    const computed = createHmac('sha256', apiKey).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'utf8');
    const compBuf = Buffer.from(computed, 'utf8');
    if (sigBuf.length !== compBuf.length) return false;
    return timingSafeEqual(sigBuf, compBuf);
  } catch {
    return false;
  }
}

@Injectable()
export class TelephonyService {
  constructor(
    private webhookDispatcher: WebhookDispatcherService,
    private workflows: WorkflowTriggerService
  ) {}

  async handleInboundCall(
    providerType: TelephonyProviderType,
    body: any,
    query: any,
    headers: Record<string, string | string[] | undefined>,
    rawBody?: Buffer
  ): Promise<string> {
    const correlationId = generateCorrelationId();
    const timer = log.startTimer();

    const payload = body?.data?.payload || body;
    const fromNumber = payload.From || payload.from || query.from || 'UNKNOWN';
    const toNumber   = payload.To   || payload.to   || query.to   || 'UNKNOWN';
    const callSid    = payload.CallSid || payload.call_control_id || payload.call_id || payload.sessionId || `CALL_${Date.now()}`;

    log.info('telephony_inbound_call_received', {
      correlationId,
      providerType,
      fromNumber: fromNumber.slice(-4).padStart(fromNumber.length, '*'),
      toNumber,
      callSid,
    });

    // ── 1. Resolve organization from the dialled number ───────────────────────
    //
    // The dialled number is the only tenant identifier a carrier gives us, so it has
    // to resolve exactly. `orgId` may also be supplied as a query param on outbound
    // calls we placed ourselves.
    const orgIdHint = typeof query?.orgId === 'string' ? query.orgId : undefined;

    // withTelephonyCredentials on every read: the carrier credentials are
    // encrypted at rest, and handing Twilio a `v1.…` ciphertext looks like a
    // revoked auth token rather than a decryption bug.
    let config = withTelephonyCredentials(
      await prisma.telephonyConfig.findFirst({
        where: {
          phoneNumber: toNumber,
          ...(orgIdHint ? { organizationId: orgIdHint } : {}),
        },
        include: { organization: true },
      })
    );

    if (!config && orgIdHint) {
      config = withTelephonyCredentials(
        await prisma.telephonyConfig.findFirst({
          where: { organizationId: orgIdHint },
          include: { organization: true },
        })
      );
    }

    if (!config) {
      // Never guess. Answering an unrecognised number with "the first telephony
      // config in the database" served one tenant's AI persona, knowledge base and
      // booking calendar to another tenant's caller.
      log.warn('telephony_no_config_for_number', { correlationId, phoneNumber: toNumber, providerType });
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not currently configured. Please try again later.</Say><Hangup/></Response>`;
    }

    const organizationId = config.organizationId;

    // ── 2. HMAC Signature Verification (per provider) ─────────────────────────
    if (providerType === TelephonyProviderType.TWILIO) {
      const authToken = config?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
      const twilioSig = headers['x-twilio-signature'] as string | undefined;
      // Twilio signs the exact URL it requested, query string included.
      const rawQuery = new URLSearchParams(query ?? {}).toString();
      const callbackUrl =
        `${apiBaseUrl()}/api/telephony/inbound/twilio` + (rawQuery ? `?${rawQuery}` : '');

      if (authToken) {
        // A missing signature header with a configured token is a REJECTION,
        // not a skip — real Twilio always sends it; omitting it must not
        // bypass verification.
        const isValid = !!twilioSig && verifyTwilioSignature(authToken, twilioSig, callbackUrl, body as Record<string, string>);
        if (!isValid) {
          log.warn('telephony_twilio_invalid_signature', {
            correlationId,
            event: 'signature_rejected',
            signatureProvided: !!twilioSig,
            callSid,
          });
          return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This call could not be authenticated. Goodbye.</Say>
  <Hangup/>
</Response>`;
        }
        log.info('telephony_twilio_signature_verified', { correlationId, callSid });
      } else {
        log.warn('telephony_twilio_signature_skipped', {
          correlationId,
          reason: 'TWILIO_AUTH_TOKEN_not_configured',
          callSid,
        });
      }
    }

    if (providerType === TelephonyProviderType.TELNYX) {
      // Ed25519 verification — the previous block only LOGGED the header and
      // accepted every request. With TELNYX_PUBLIC_KEY set, a missing, forged,
      // or replayed (>5 min) signature is rejected.
      const telnyxPublicKey = process.env.TELNYX_PUBLIC_KEY;
      if (telnyxPublicKey) {
        const telnyxSig = headers['telnyx-signature-ed25519'] as string | undefined;
        const telnyxTs = headers['telnyx-timestamp'] as string | undefined;
        const isValid = !!rawBody && verifyTelnyxSignature(telnyxPublicKey, telnyxSig, telnyxTs, rawBody);
        if (!isValid) {
          log.warn('telephony_telnyx_invalid_signature', { correlationId, callSid, signatureProvided: !!telnyxSig });
          return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
        }
        log.info('telephony_telnyx_signature_verified', { correlationId, callSid });
      } else {
        log.warn('telephony_telnyx_signature_skipped', { correlationId, reason: 'TELNYX_PUBLIC_KEY_not_configured', callSid });
      }
    }

    if (providerType === TelephonyProviderType.AFRICAS_TALKING) {
      const apiKey = config?.apiKey ?? process.env.AT_API_KEY;
      const atSig = headers['x-africastalking-signature'] as string | undefined;
      if (apiKey) {
        // When a key IS configured, a missing header is a rejection — otherwise
        // an attacker bypasses verification by simply omitting it.
        const isValid = !!atSig && !!rawBody && verifyAfricasTalkingSignature(apiKey, atSig, rawBody);
        if (!isValid) {
          log.warn('telephony_at_invalid_signature', { correlationId, callSid, signatureProvided: !!atSig });
          return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
        }
      }
    }

    // ── 3. Record call log ─────────────────────────────────────────────────────
    //
    // callSid is @unique. Carriers retry webhooks on timeout or 5xx, and Twilio also
    // re-POSTs the voice URL after a <Redirect>, so a plain create() threw P2002 and
    // returned a 500 — which made the carrier retry again. upsert makes the handler
    // idempotent.
    const callLog = await prisma.callLog.upsert({
      where:  { callSid },
      update: { status: CallStatus.IN_PROGRESS },
      create: {
        organizationId,
        telephonyConfigId: config.id,
        callSid,
        fromNumber,
        toNumber,
        direction: CallDirection.INBOUND,
        status:    CallStatus.IN_PROGRESS,
        provider:  providerType as any,
      },
    });

    this.webhookDispatcher.dispatch(organizationId, 'call.started', {
      callSid,
      direction: CallDirection.INBOUND,
    }).catch(() => {});

    log.info('telephony_call_log_created', {
      correlationId,
      callLogId: callLog.id,
      callSid,
      organizationId,
    });

    // ── 4. Route: ElevenLabs hosted agent (priority) OR media-stream (fallback) ─
    //
    // When a tenant has imported their Twilio number into ElevenLabs, ElevenLabs
    // owns the call from this point — it intercepts the Twilio webhook before we
    // do, answers with its own TwiML, and the call never reaches our media-stream
    // handler. In that state, returning our own media-stream TwiML would cause
    // both to race for the call.
    //
    // When `hostedAgentConfig.phoneNumberId` is set, the cutover has happened:
    // we return a minimal no-op TwiML and let ElevenLabs drive. If the agent id
    // is missing (not yet provisioned) we fall back to the media-stream path so
    // the caller is never left in silence during setup.
    const hostedAgent = await prisma.hostedAgentConfig.findUnique({
      where: { organizationId },
      select: { agentId: true, phoneNumberId: true, isActive: true },
    });

    const elevenLabsActive =
      hostedAgent?.isActive &&
      hostedAgent?.agentId &&
      hostedAgent?.phoneNumberId;

    if (elevenLabsActive) {
      log.info('telephony_elevenlabs_routing', {
        correlationId,
        organizationId,
        callSid,
        agentId: hostedAgent.agentId,
        reason: 'ElevenLabs hosted agent owns this number — deferring to it',
      }, timer);

      // ElevenLabs has already taken the call. Return an empty TwiML response
      // so Twilio doesn't hear silence from us — ElevenLabs' own webhook already
      // answered with its TwiML before this webhook fired.
      return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
    }

    // ── Fallback: media-stream path (Deepgram STT + ElevenLabs TTS) ───────────
    // Used when: no hosted agent configured, agent not provisioned, or number
    // not yet imported into ElevenLabs. Keeps callers connected during setup.
    log.info('telephony_mediastream_routing', {
      correlationId,
      organizationId,
      callSid,
      reason: elevenLabsActive === false
        ? 'ElevenLabs agent inactive'
        : !hostedAgent?.agentId
          ? 'ElevenLabs agent not yet provisioned — using media-stream fallback'
          : 'No hosted agent configured — using media-stream fallback',
    });

    const provider = TelephonyFactory.createProvider(providerType, {
      accountSid: config?.accountSid,
      authToken:  config?.authToken,
      apiKey:     config?.apiKey,
    });

    const welcomeMsg = config?.organization?.welcomeMessage
      ?? 'Hello! Thank you for calling. How may I assist you today?';

    const wsBaseUrl = apiBaseUrl().replace(/^http/, 'ws');
    // Embed org/from/to so TwilioMediaStreamHandler can identify the session
    // without a DB lookup inside the WS upgrade handler.
    const streamParams = new URLSearchParams({
      orgId: organizationId,
      from:  fromNumber,
      to:    toNumber,
    });
    const websocketStreamUrl = `${wsBaseUrl}/telephony/stream/${callSid}?${streamParams}`;

    const response = provider.generateInboundWebhookResponse(welcomeMsg, websocketStreamUrl);

    log.info('telephony_inbound_handled', {
      correlationId,
      providerType,
      callSid,
      organizationId,
    }, timer);

    return response;
  }

  async initiateOutboundCall(
    organizationId: string,
    toNumber: string,
    providerType?: TelephonyProviderType
  ) {
    const correlationId = generateCorrelationId();
    const timer = log.startTimer();

    // Fall back to *any* config for the org, not just isDefault.
    // OrganizationsService.updateTelephonyConfig never writes isDefault, so an
    // isDefault-only lookup returned null for every org configured through the
    // dashboard and outbound calls were placed from the placeholder number
    // +2348030000000 — which no carrier would accept as a verified caller ID.
    const config = withTelephonyCredentials(
      (await prisma.telephonyConfig.findFirst({ where: { organizationId, isDefault: true } })) ??
        (await prisma.telephonyConfig.findFirst({
          where: { organizationId },
          orderBy: { createdAt: 'asc' },
        }))
    );

    if (!config?.phoneNumber) {
      throw new BadRequestException(
        'No outbound phone number is configured for this organization. ' +
        'Add one under Settings → Voice & Telephony before placing calls.'
      );
    }

    const fromNumber = config.phoneNumber;
    const resolvedProvider = providerType ?? (config.provider as TelephonyProviderType);

    log.info('telephony_outbound_call_initiating', {
      correlationId,
      organizationId,
      toNumber: toNumber.slice(-4).padStart(toNumber.length, '*'),
      providerType: resolvedProvider,
    });

    const provider = TelephonyFactory.createProvider(resolvedProvider, {
      accountSid: config.accountSid,
      authToken:  config.authToken,
      apiKey:     config.apiKey,
    });

    const isVerified = await provider.verifyCallerId(fromNumber);
    if (!isVerified) {
      // The caller ID is what the carrier will reject, so failing here gives the
      // operator an actionable error instead of a CallLog row for a call that the
      // carrier silently dropped.
      throw new BadRequestException(
        `"${fromNumber}" is not a valid caller ID for the ${resolvedProvider} provider. ` +
        `Verify the number with your carrier and update Settings → Voice & Telephony.`
      );
    }

    const record = await provider.initiateCall({
      organizationId,
      fromNumber,
      toNumber,
      provider: resolvedProvider,
    });

    const callLog = await prisma.callLog.create({
      data: {
        organizationId,
        callSid:     record.callId,
        fromNumber,
        toNumber,
        direction:   CallDirection.OUTBOUND,
        status:      CallStatus.QUEUED,
        provider:    resolvedProvider as any,
      },
    });

    this.webhookDispatcher.dispatch(organizationId, 'call.started', {
      callSid: record.callId,
      direction: CallDirection.OUTBOUND,
    }).catch(() => {});

    log.info('telephony_outbound_call_initiated', {
      correlationId,
      callLogId: callLog.id,
      callSid:   record.callId,
    }, timer);

    return record;
  }

  async updateCallStatus(callSid: string, status: CallStatus, duration?: number) {
    const correlationId = generateCorrelationId();
    const callLog = await prisma.callLog.findFirst({ where: { callSid } });

    if (!callLog) {
      log.warn('telephony_call_status_update_not_found', { correlationId, callSid, status });
      return null;
    }

    const updated = await prisma.callLog.update({
      where: { id: callLog.id },
      data: {
        status,
        ...(status === CallStatus.COMPLETED || status === CallStatus.FAILED
          ? { endedAt: new Date(), durationSeconds: duration }
          : {}),
      },
    });

    if (status === CallStatus.COMPLETED) {
      this.webhookDispatcher.dispatch(callLog.organizationId, 'call.completed', {
        callSid,
        durationSeconds: duration,
      }).catch(() => {});

      this.workflows.emitAsync(callLog.organizationId, 'CALL_ENDED', {
        callSid,
        durationSeconds: duration ?? 0,
        direction: callLog.direction,
        fromNumber: callLog.fromNumber,
        contactId: callLog.contactId ?? undefined,
        contact: { phoneNumber: callLog.fromNumber },
      });
    }

    log.info('telephony_call_status_updated', {
      correlationId,
      callLogId: callLog.id,
      callSid,
      newStatus: status,
      duration,
    });

    return updated;
  }

  async getCallLogs(organizationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.callLog.findMany({
        where: { organizationId },
        orderBy: { startedAt: 'desc' },
        take: limit,
        skip,
        include: { contact: true },
      }),
      prisma.callLog.count({ where: { organizationId } }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}
