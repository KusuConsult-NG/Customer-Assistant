import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { TelephonyFactory } from '@ace/telephony-sdk';
import { TelephonyProviderType, CallDirection, CallStatus } from '@ace/shared-types';
import { AceLogger, generateCorrelationId } from '../config/logger';
import { createHmac, timingSafeEqual } from 'crypto';

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

  async handleInboundCall(
    providerType: TelephonyProviderType,
    body: any,
    query: any,
    headers: Record<string, string | string[] | undefined>,
    rawBody?: Buffer
  ): Promise<string> {
    const correlationId = generateCorrelationId();
    const timer = log.startTimer();

    const fromNumber = body.From || body.from || query.from || 'UNKNOWN';
    const toNumber   = body.To   || body.to   || query.to   || 'UNKNOWN';
    const callSid    = body.CallSid || body.call_id || body.sessionId || `CALL_${Date.now()}`;

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

    if (!config) {
      log.warn('telephony_config_not_found_using_first_org', {
        correlationId,
        toNumber,
        action: 'falling_back_to_first_telephony_config',
      });
      config = await prisma.telephonyConfig.findFirst({
        include: { organization: true },
      });
    }

    const organizationId = config?.organizationId ?? (await this.getFallbackOrgId(correlationId));

    // ── 2. HMAC Signature Verification (per provider) ─────────────────────────
    if (providerType === TelephonyProviderType.TWILIO) {
      const authToken = config?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
      const twilioSig = headers['x-twilio-signature'] as string | undefined;
      const callbackUrl = `${process.env.API_URL || 'https://your-api-domain.com'}/api/telephony/inbound/twilio`;

      if (authToken && twilioSig) {
        const isValid = verifyTwilioSignature(authToken, twilioSig, callbackUrl, body as Record<string, string>);
        if (!isValid) {
          log.warn('telephony_twilio_invalid_signature', {
            correlationId,
            event: 'signature_rejected',
            callSid,
          });
          // Return a 403-equivalent TwiML rejection
          return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>This call could not be authenticated. Goodbye.</Say>
  <Hangup/>
</Response>`;
        }
        log.info('telephony_twilio_signature_verified', { correlationId, callSid });
      } else {
        // If no auth token configured yet, log a security warning but allow through
        // This allows initial setup before credentials are configured
        log.warn('telephony_twilio_signature_skipped', {
          correlationId,
          reason: authToken ? 'missing_twilio_signature_header' : 'TWILIO_AUTH_TOKEN_not_configured',
          callSid,
        });
      }
    }

    if (providerType === TelephonyProviderType.AFRICAS_TALKING) {
      const apiKey = config?.apiKey ?? process.env.AT_API_KEY;
      const atSig = headers['x-africastalking-signature'] as string | undefined;
      if (apiKey && atSig && rawBody) {
        const isValid = verifyAfricasTalkingSignature(apiKey, atSig, rawBody);
        if (!isValid) {
          log.warn('telephony_at_invalid_signature', { correlationId, callSid });
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
        provider:  providerType,
      },
    });

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

    const wsBaseUrl = process.env.API_URL?.replace(/^http/, 'ws') ?? 'ws://localhost:4000';
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
    providerType: TelephonyProviderType = TelephonyProviderType.NIGERIA_CARRIER_FORWARD
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

    const record = await provider.initiateCall({
      organizationId,
      fromNumber,
      toNumber,
      provider: providerType,
    });

    const callLog = await prisma.callLog.create({
      data: {
        organizationId,
        callSid:     record.callId,
        fromNumber,
        toNumber,
        direction:   CallDirection.OUTBOUND,
        status:      CallStatus.QUEUED,
        provider:    providerType,
      },
    });

    log.info('telephony_outbound_call_queued', {
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

    log.info('telephony_call_status_updated', {
      correlationId,
      callLogId: callLog.id,
      callSid,
      newStatus: status,
      duration,
    });

    return updated;
  }

  async getCallLogs(organizationId: string) {
    return prisma.callLog.findMany({
      where: { organizationId },
      orderBy: { startedAt: 'desc' },
      take: 100,
      include: { contact: true },
    });
  }

  private async getFallbackOrgId(correlationId: string): Promise<string> {
    const org = await prisma.organization.findFirst();
    if (org) return org.id;

    log.warn('telephony_no_org_found_creating_default', { correlationId });
    const newOrg = await prisma.organization.create({
      data: { name: 'Default Organization', slug: 'default-org' },
    });
    return newOrg.id;
  }
}
