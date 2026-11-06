import { Injectable, BadRequestException } from '@nestjs/common';
import { prisma, withTelephonyCredentials, ensureContactForPhone, phoneNumberVariants } from '@ace/database';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WorkflowTriggerService } from '../workflows/workflow-trigger.service';
import { SipTrunkOriginationService } from './sip-trunk-origination.service';
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
    private workflows: WorkflowTriggerService,
    private sipOrigination: SipTrunkOriginationService
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
    // Each carrier names these differently, and the dialled number is the ONLY
    // tenant identifier a carrier gives us — so a name this list does not know
    // resolves to no configuration and the caller hears "this number is not
    // currently configured" however correctly it was set up.
    //
    // Africa's Talking sends `callerNumber`/`destinationNumber` and was missing
    // from here entirely: its route, its provider enum and its HMAC
    // verification all existed, and every call to it answered "not
    // configured" before reaching any of them.
    const fromNumber =
      payload.From || payload.from || payload.callerNumber || query.from || 'UNKNOWN';
    const toNumber =
      payload.To || payload.to || payload.destinationNumber || query.to || 'UNKNOWN';
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
    // Matched across every shape the number might be SAVED in, not just the
    // exact string the carrier sent.
    //
    // Twilio sends E.164 (`+2348031234567`). An operator setting the line up
    // types what is printed on the agency's letterhead — `08031234567`, or
    // `0803 123 4567`. An exact match then finds nothing and every citizen who
    // rings the number hears "This number is not currently configured",
    // with the dashboard showing a line that looks correctly set up. It is the
    // same mismatch that made one citizen three contacts, and the same
    // helper fixes it.
    const dialledVariants = phoneNumberVariants(toNumber);
    let config = withTelephonyCredentials(
      await prisma.telephonyConfig.findFirst({
        where: {
          phoneNumber: { in: dialledVariants },
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

    if (providerType === TelephonyProviderType.NIGERIA_CARRIER_FORWARD) {
      // ── This provider has no signature scheme, so it gets a shared secret ──
      //
      // A carrier forwarding calls over plain HTTP signs nothing. Every other
      // branch here verifies a real provider signature and SKIPS with a
      // warning when the secret is unset, because for those an unset secret
      // is a misconfiguration of an otherwise-authenticated channel.
      //
      // That reasoning does not transfer. With nothing to verify, "skip"
      // means this route is permanently unauthenticated — and it resolves a
      // tenant from the dialled number and then drives the AI, which answers
      // the caller and can write bookings and tickets. Anyone who learned the
      // URL and one configured number had that.
      //
      // So the default is REFUSE, not skip. A deployment that wants this
      // channel sets `apiSecret` on the TelephonyConfig and has the carrier
      // send it as `x-carrier-secret`. Nothing uses this provider today, so
      // closing it breaks no integration.
      const expected = config?.apiSecret;
      const presented = headers['x-carrier-secret'] as string | undefined;

      if (!expected) {
        log.warn('telephony_carrier_forward_no_shared_secret', {
          correlationId,
          callSid,
          reason: 'apiSecret_not_configured',
        });
        return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This number is not configured for forwarded calls. Please try again later.</Say><Hangup/></Response>`;
      }

      const expectedBuf = Buffer.from(expected, 'utf8');
      const presentedBuf = Buffer.from(presented ?? '', 'utf8');
      const ok =
        !!presented &&
        expectedBuf.length === presentedBuf.length &&
        timingSafeEqual(expectedBuf, presentedBuf);

      if (!ok) {
        log.warn('telephony_carrier_forward_bad_secret', {
          correlationId,
          callSid,
          secretProvided: !!presented,
        });
        return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>This call could not be authenticated. Goodbye.</Say><Hangup/></Response>`;
      }
      log.info('telephony_carrier_forward_authenticated', { correlationId, callSid });
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

    // ── 2b. The citizen's own record ──────────────────────────────────────────
    //
    // Created when the call is ANSWERED, not when some tool first needs one.
    //
    // Contacts used to be made lazily, deep inside a tool call, so a citizen
    // who rang, heard the greeting and hung up left a CallLog and nothing on
    // Citizens & Contacts — invisible to an officer, and with no record to
    // ring back. That is precisely the caller a care line most needs to reach.
    //
    // Best-effort on purpose: a contact write must never stop the call being
    // answered. A failure here is logged and the caller is still served.
    //
    // The agency's OWN numbers are passed so that a forwarded call is not
    // attributed to a person. A local toll-free number forwarded to this line
    // is how a Nigerian citizen reaches a service whose carrier number is
    // foreign, and many carriers forward without passing the original calling
    // line identity: what arrives as the caller is the dialled number or the
    // trunk. Unguarded, every citizen on that line becomes the SAME contact,
    // and their appointments and cases are filed under one another.
    const agencyNumbers = [
      config.phoneNumber,
      config.forwardingNumber,
      toNumber,
      ...(await prisma.telephonyConfig
        .findMany({ where: { organizationId }, select: { phoneNumber: true, forwardingNumber: true } })
        .then((rows) => rows.flatMap((r) => [r.phoneNumber, r.forwardingNumber]))
        .catch(() => [])),
    ];

    const callerContact = await ensureContactForPhone(prisma, organizationId, fromNumber, undefined, agencyNumbers).catch(
      (err) => {
        log.warn('telephony_contact_create_failed', {
          correlationId,
          callSid,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    );
    if (callerContact) {
      log.info('telephony_caller_contact_ready', {
        correlationId,
        callSid,
        contactId: callerContact.id,
      });
    }

    // ── 3. Record call log ─────────────────────────────────────────────────────
    //
    // callSid is @unique. Carriers retry webhooks on timeout or 5xx, and Twilio also
    // re-POSTs the voice URL after a <Redirect>, so a plain create() threw P2002 and
    // returned a 500 — which made the carrier retry again. upsert makes the handler
    // idempotent.
    const callLog = await prisma.callLog.upsert({
      where:  { callSid },
      // The contact goes ON THE ROW, not only in the log line above.
      //
      // `getCallLogs` includes `contact: true`, so every inbound call came
      // back with contact: null — the Telephone Service screen could not name
      // who rang, and `CALL_ENDED` carried no contactId for a workflow to act
      // on. The record was created two statements earlier and nothing pointed
      // at it. Set on update too, so a carrier retry after a failed first
      // contact write still links the call.
      update: {
        status: CallStatus.IN_PROGRESS,
        ...(callerContact ? { contactId: callerContact.id } : {}),
      },
      create: {
        organizationId,
        telephonyConfigId: config.id,
        callSid,
        fromNumber,
        toNumber,
        contactId: callerContact?.id ?? null,
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
    providerType?: TelephonyProviderType,
    /**
     * The citizen this call is for, when the caller knows — a promised
     * callback does. Without it the CallLog has no contact, so the call
     * history cannot name who was rung and `CALL_ENDED` carries nobody for a
     * workflow to act on. Resolved from the number when it is not supplied.
     */
    contactId?: string
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

    // ── A SIP trunk originates through the agent that answers it ────────────
    //
    // This platform holds no SIP stack, so `SipTrunkProvider.initiateCall`
    // refuses — correctly. But ElevenLabs already holds the trunk (the import
    // sends `outboundTrunkConfig` with the inbound side), so the agent that
    // ANSWERS the agency's number can also place calls on it.
    //
    // That is what makes one number work in both directions, which matters
    // most for a State toll-free already in service: it cannot be handed to
    // Twilio, and without this a promised callback could never be placed on
    // the only number the agency publishes.
    if (resolvedProvider === TelephonyProviderType.SIP_TRUNK) {
      const placed = await this.sipOrigination.placeCall(organizationId, toNumber, {
        fromNumber,
      });
      const record = this.sipOrigination.asCallRecord(organizationId, placed, {
        fromNumber,
        toNumber,
      });

      const callLog = await prisma.callLog.create({
        data: {
          organizationId,
          callSid:   record.callId,
          fromNumber,
          toNumber,
          contactId: contactId ?? (await this.contactIdForNumber(organizationId, toNumber)),
          direction: CallDirection.OUTBOUND,
          status:    CallStatus.QUEUED,
          provider:  resolvedProvider as any,
        },
      });

      log.info('telephony_outbound_call_placed_via_sip_trunk', {
        correlationId,
        organizationId,
        callLogId: callLog.id,
        callSid: record.callId,
      }, timer);

      this.webhookDispatcher.dispatch(organizationId, 'call.started', {
        callSid: record.callId,
        fromNumber,
        toNumber,
        direction: 'OUTBOUND',
      });

      return { ...record, id: callLog.id, callSid: record.callId };
    }

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
        contactId:   contactId ?? (await this.contactIdForNumber(organizationId, toNumber)),
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

  /**
   * The citizen a number belongs to, if this agency already has one.
   *
   * Matches every stored shape, like every other lookup here — an outbound
   * call to a number saved by WhatsApp without the plus would otherwise find
   * nobody and the call history would show a number with no name beside it.
   */
  private async contactIdForNumber(organizationId: string, phoneNumber: string): Promise<string | null> {
    const contact = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
      select: { id: true },
    });
    return contact?.id ?? null;
  }

  /**
   * Is this status callback really from the carrier that holds the call?
   *
   * ── What was wrong ────────────────────────────────────────────────────────
   *
   * Nothing checked. The INBOUND routes verify a signature before they do
   * anything; the status callbacks — ringing, answered, busy, no-answer —
   * verified nothing at all, so anyone who could reach the URL could POST a
   * CallSid and a status and rewrite the agency's call history.
   *
   * It stopped being merely corruption the day these callbacks began settling
   * promised callbacks: COMPLETED here is what records that a citizen was
   * actually REACHED. An unauthenticated stranger could mark an agency's
   * promises kept with no call placed, which is the fabrication the platform's
   * first invariant exists to forbid.
   *
   * The tenant is taken from the call log the SID names — a SID this platform
   * has no record of is refused outright, since there is nothing to verify it
   * against and nothing to update. Verification then uses THAT agency's own
   * carrier credentials, so one tenant's callback cannot speak for another's.
   */
  async verifyStatusCallback(input: {
    callSid: string;
    provider: 'TWILIO' | 'TELNYX';
    headers: Record<string, string>;
    params: Record<string, string>;
    rawBody?: Buffer;
    path: string;
  }): Promise<'ok' | 'unknown_call' | 'rejected'> {
    const callLog = await prisma.callLog.findFirst({
      where: { callSid: input.callSid },
      select: { organizationId: true },
    });
    if (!callLog) return 'unknown_call';

    if (input.provider === 'TELNYX') {
      // Telnyx signs with a workspace key held in the environment, not per
      // tenant. With no key configured there is nothing to verify, and a
      // skipped check is how an unverified route stays unverified.
      const publicKey = process.env.TELNYX_PUBLIC_KEY;
      if (!publicKey) return 'rejected';
      const ok = verifyTelnyxSignature(
        publicKey,
        input.headers['telnyx-signature-ed25519'],
        input.headers['telnyx-timestamp'],
        input.rawBody ?? Buffer.from('')
      );
      if (!ok) {
        log.warn('telephony_status_signature_rejected', {
          callSid: input.callSid,
          organizationId: callLog.organizationId,
          provider: 'TELNYX',
          signatureProvided: Boolean(input.headers['telnyx-signature-ed25519']),
        });
      }
      return ok ? 'ok' : 'rejected';
    }

    const config = withTelephonyCredentials(
      await prisma.telephonyConfig.findFirst({
        where: { organizationId: callLog.organizationId, provider: 'TWILIO' as any },
        orderBy: { createdAt: 'asc' },
      })
    );
    const authToken = config?.authToken;
    // No token stored means this agency's callbacks cannot be verified. Refuse
    // rather than trust: an unverifiable status is not a status.
    if (!authToken) return 'rejected';

    const callbackUrl = `${apiBaseUrl()}${input.path}`;
    const ok = verifyTwilioSignature(
      authToken,
      input.headers['x-twilio-signature'],
      callbackUrl,
      input.params
    );
    if (!ok) {
      // Named, because the likeliest cause is not an attack. Twilio signs over
      // the EXACT callback URL it was configured with, so a number whose
      // status callback was set by hand in the Twilio console to a different
      // spelling — a trailing slash, a query string, http where this is https
      // — fails here forever and silently stops the call history updating.
      log.warn('telephony_status_signature_rejected', {
        callSid: input.callSid,
        organizationId: callLog.organizationId,
        signatureProvided: Boolean(input.headers['x-twilio-signature']),
        expectedCallbackUrl: callbackUrl,
      });
    }
    return ok ? 'ok' : 'rejected';
  }

  async updateCallStatus(callSid: string, status: CallStatus, duration?: number) {
    const correlationId = generateCorrelationId();
    const callLog = await prisma.callLog.findFirst({ where: { callSid } });

    if (!callLog) {
      log.warn('telephony_call_status_update_not_found', { correlationId, callSid, status });
      return null;
    }

    // Every status that ends a call closes the record. BUSY and NO_ANSWER were
    // missing — they could not previously arrive here, because the Twilio
    // callback flattened them into FAILED, so a call log for an engaged line
    // would have sat with no `endedAt` and read as still in progress.
    const TERMINAL = [
      CallStatus.COMPLETED,
      CallStatus.FAILED,
      CallStatus.BUSY,
      CallStatus.NO_ANSWER,
    ];
    const updated = await prisma.callLog.update({
      where: { id: callLog.id },
      data: {
        status,
        ...(TERMINAL.includes(status)
          ? { endedAt: new Date(), durationSeconds: duration }
          : {}),
      },
    });

    if (status === CallStatus.COMPLETED) {
      this.webhookDispatcher.dispatch(callLog.organizationId, 'call.ended', {
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
