import { Injectable, BadRequestException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { TelephonyFactory } from '@ace/telephony-sdk';
import { TelephonyProviderType, CallDirection, CallStatus } from '@ace/shared-types';
import { AceLogger, generateCorrelationId } from '../config/logger';
import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify } from 'crypto';

const log = new AceLogger('TelephonyService');

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
 * Verifies Telnyx's Ed25519 webhook signature.
 *
 * Telnyx signs `${timestamp}|${rawBody}` with Ed25519; the signature arrives
 * base64-encoded in `telnyx-signature-ed25519` with the timestamp in
 * `telnyx-timestamp`. The account's public key (base64, from the Telnyx
 * portal) is provided via TELNYX_PUBLIC_KEY.
 *
 * Node's crypto verifies Ed25519 natively — the raw 32-byte key just needs
 * wrapping in a SPKI DER envelope.
 *
 * Ref: https://developers.telnyx.com/docs/development/webhooks
 */
function verifyTelnyxSignature(
  publicKeyBase64: string,
  signatureBase64: string | undefined,
  timestamp: string | undefined,
  rawBody: Buffer
): boolean {
  if (!signatureBase64 || !timestamp || !publicKeyBase64) return false;
  try {
    // Reject stale timestamps (> 5 min skew) to block replay attacks
    const ts = parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

    const rawKey = Buffer.from(publicKeyBase64, 'base64');
    if (rawKey.length !== 32) return false;
    // SPKI DER prefix for an Ed25519 public key (RFC 8410)
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
  constructor(private webhookDispatcher: WebhookDispatcherService) {}

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
    let config = await prisma.telephonyConfig.findFirst({
      where: { phoneNumber: toNumber },
      include: { organization: true },
    });

    if (!config && toNumber === 'UNKNOWN') {
      config = await prisma.telephonyConfig.findFirst({
        include: { organization: true },
      });
    }

    if (!config) {
      log.warn('No telephony config found for number', { phoneNumber: toNumber });
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not currently configured. Please try again later.</Say></Response>`;
    }

    const organizationId = config?.organizationId ?? (await this.getFallbackOrgId(correlationId));

    // ── 2. HMAC Signature Verification (per provider) ─────────────────────────
    if (providerType === TelephonyProviderType.TWILIO) {
      const authToken = config?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
      const twilioSig = headers['x-twilio-signature'] as string | undefined;
      // API_URL with API_BASE_URL fallback: the rest of the codebase uses
      // API_BASE_URL — using only API_URL here meant a correctly-configured
      // deployment could still verify against the wrong callback URL and
      // reject every legitimate Twilio call.
      const apiBase = process.env.API_URL || process.env.API_BASE_URL || 'https://your-api-domain.com';
      const callbackUrl = `${apiBase}/api/telephony/inbound/twilio`;

      if (authToken) {
        // When an auth token IS configured, a missing signature header is a
        // REJECTION, not a skip — otherwise an attacker bypasses verification
        // by simply omitting the header (real Twilio always sends it).
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
      // Ed25519 verification — previously the signature header was only LOGGED
      // ("signature_received"), never verified: any request was accepted.
      const telnyxPublicKey = process.env.TELNYX_PUBLIC_KEY;
      if (telnyxPublicKey) {
        const telnyxSig = headers['telnyx-signature-ed25519'] as string | undefined;
        const telnyxTs = headers['telnyx-timestamp'] as string | undefined;
        const isValid = !!rawBody && verifyTelnyxSignature(telnyxPublicKey, telnyxSig, telnyxTs, rawBody);
        if (!isValid) {
          log.warn('telephony_telnyx_invalid_signature', {
            correlationId,
            callSid,
            signatureProvided: !!telnyxSig,
          });
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
        // Same bypass-hardening as Twilio: when a key IS configured, a missing
        // signature header (or missing rawBody) is a rejection — omitting the
        // header must not skip verification.
        const isValid = !!atSig && !!rawBody && verifyAfricasTalkingSignature(apiKey, atSig, rawBody);
        if (!isValid) {
          log.warn('telephony_at_invalid_signature', { correlationId, callSid, signatureProvided: !!atSig });
          return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
        }
      }
    }

    // ── 3. Record call log ─────────────────────────────────────────────────────
    const callLog = await prisma.callLog.create({
      data: {
        organizationId,
        telephonyConfigId: config?.id,
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

    // ── 4. Generate provider-specific webhook response ────────────────────────
    const provider = TelephonyFactory.createProvider(providerType, {
      accountSid: config?.accountSid,
      authToken:  config?.authToken,
      apiKey:     config?.apiKey,
    });

    const welcomeMsg = config?.organization?.welcomeMessage
      ?? 'Hello! Thank you for calling. How may I assist you today?';

    const wsBaseUrl = (process.env.API_URL || process.env.API_BASE_URL)?.replace(/^http/, 'ws') ?? 'ws://localhost:4000';
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
    // Default TWILIO: it is the only provider that can actually ORIGINATE an
    // outbound call. The old default (NIGERIA_CARRIER_FORWARD) is a passive
    // forwarding setup — its SDK used to fabricate a QUEUED record for calls
    // that never happened, and now honestly throws instead.
    providerType: TelephonyProviderType = TelephonyProviderType.TWILIO
  ) {
    const correlationId = generateCorrelationId();
    const timer = log.startTimer();

    const config = await prisma.telephonyConfig.findFirst({
      where: { organizationId, isDefault: true },
    });

    const fromNumber = config?.phoneNumber || process.env.DEFAULT_FROM_NUMBER || '+2348030000000';

    log.info('telephony_outbound_call_initiating', {
      correlationId,
      organizationId,
      toNumber: toNumber.slice(-4).padStart(toNumber.length, '*'),
      providerType,
    });

    const provider = TelephonyFactory.createProvider(providerType, {
      accountSid: config?.accountSid,
      authToken:  config?.authToken,
      apiKey:     config?.apiKey,
    });

    const isVerified = await provider.verifyCallerId(fromNumber);
    if (!isVerified) {
      log.warn('telephony_caller_id_verification_failed', {
        correlationId,
        providerType,
        fromNumberSuffix: fromNumber.slice(-4),
      });
    }

    let record;
    try {
      record = await provider.initiateCall({
        organizationId,
        fromNumber,
        toNumber,
        provider: providerType,
      });
    } catch (err: any) {
      // Surface provider failures as a clear 400 with the real reason —
      // previously the SDK swallowed failures and returned a fabricated
      // QUEUED record, so the dashboard showed calls that never existed.
      log.warn('telephony_outbound_call_failed', {
        correlationId,
        organizationId,
        providerType,
        error: err?.message,
      });
      throw new BadRequestException(err?.message ?? 'Outbound call could not be placed');
    }

    const callLog = await prisma.callLog.create({
      data: {
        organizationId,
        callSid:     record.callId,
        fromNumber,
        toNumber,
        direction:   CallDirection.OUTBOUND,
        status:      CallStatus.QUEUED,
        provider:    providerType as any,
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

  private async getFallbackOrgId(correlationId: string): Promise<string> {
    const org = await prisma.organization.findFirst();
    if (org) return org.id;

    log.warn('telephony_no_org_found_creating_default', { correlationId });
    try {
      const newOrg = await prisma.organization.create({
        data: { name: 'Default Organization', slug: 'default-org' },
      });
      return newOrg.id;
    } catch (err: any) {
      // P2002: two concurrent unmatched calls both tried to create the fixed
      // 'default-org' slug — the other request won; use its organization.
      if (err.code === 'P2002') {
        const existing = await prisma.organization.findUnique({ where: { slug: 'default-org' } });
        if (existing) return existing.id;
      }
      throw err;
    }
  }
}
