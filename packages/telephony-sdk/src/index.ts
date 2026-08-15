import {
  CallInitiateOptions,
  CallTransferOptions,
  CallRecord,
  CallStatus,
  CallDirection,
  TelephonyProviderType,
} from '@ace/shared-types';

export interface TelephonyProvider {
  type: TelephonyProviderType;
  initiateCall(options: CallInitiateOptions): Promise<CallRecord>;
  transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }>;
  endCall(callId: string): Promise<boolean>;
  generateInboundWebhookResponse(promptText: string, streamUrl: string): string;
  verifyCallerId(phoneNumber: string): Promise<boolean>;
  /**
   * False when the provider cannot actually place a call from this process — either
   * because it has no API integration yet, or because its credentials are missing.
   * Callers must check this instead of assuming every provider can dial out.
   */
  canPlaceOutboundCalls(): boolean;
}

/**
 * Thrown when a provider cannot place a call.
 *
 * Every provider in this file used to swallow failures and return a locally-minted
 * fake identifier (`CA_TW_1699…`, `PL_…`, `AT_…`). The caller then wrote a CallLog
 * row and reported success to the dashboard for a call that was never placed, and no
 * status webhook would ever arrive to correct it. Failing loudly is the only honest
 * option: a fabricated call ID is worse than an error.
 */
export class TelephonyNotAvailableError extends Error {
  constructor(provider: TelephonyProviderType, reason: string) {
    super(`${provider} cannot place outbound calls: ${reason}`);
    this.name = 'TelephonyNotAvailableError';
  }
}

/** Public base URL of the ACE API, used for carrier callbacks. */
function apiBaseUrl(): string {
  return (process.env.API_BASE_URL || process.env.API_URL || 'http://localhost:4000').replace(/\/+$/, '');
}

export class TwilioProvider implements TelephonyProvider {
  type = TelephonyProviderType.TWILIO;

  constructor(
    private accountSid?: string,
    private authToken?: string
  ) {}

  private credentials() {
    return {
      sid: this.accountSid || process.env.TWILIO_ACCOUNT_SID,
      token: this.authToken || process.env.TWILIO_AUTH_TOKEN,
    };
  }

  canPlaceOutboundCalls(): boolean {
    const { sid, token } = this.credentials();
    return Boolean(sid && token);
  }

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    const { sid, token } = this.credentials();

    if (!sid || !token) {
      throw new TelephonyNotAvailableError(
        this.type,
        'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not configured for this organization.'
      );
    }

    const params = new URLSearchParams({
      To: options.toNumber,
      From: options.fromNumber,
      Url: `${apiBaseUrl()}/api/telephony/inbound/twilio?orgId=${encodeURIComponent(options.organizationId)}`,
      StatusCallback: `${apiBaseUrl()}/api/telephony/status/twilio`,
      StatusCallbackMethod: 'POST',
    });
    // Twilio wants repeated StatusCallbackEvent params, not a comma-joined value.
    for (const event of ['initiated', 'ringing', 'answered', 'completed']) {
      params.append('StatusCallbackEvent', event);
    }

    const authHeader = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new TelephonyNotAvailableError(this.type, `Twilio API returned ${res.status}: ${detail.slice(0, 300)}`);
    }

    const data: any = await res.json();
    if (!data?.sid) {
      throw new TelephonyNotAvailableError(this.type, 'Twilio accepted the request but returned no call SID.');
    }

    return {
      callId: data.sid,
      organizationId: options.organizationId,
      from: options.fromNumber,
      to: options.toNumber,
      direction: CallDirection.OUTBOUND,
      status: CallStatus.QUEUED,
      startTime: new Date(),
      provider: this.type,
    };
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    const { sid, token } = this.credentials();
    if (!sid || !token) {
      return { success: false, message: 'Twilio credentials are not configured — call was not transferred.' };
    }

    // Redirect the live call to TwiML that dials the target number.
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      (options.announceMessage ? `<Say>${escapeXml(options.announceMessage)}</Say>` : '') +
      `<Dial>${escapeXml(options.targetPhoneNumber)}</Dial>` +
      `</Response>`;

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(options.callId)}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Twiml: twiml }).toString(),
      }
    );

    return res.ok
      ? { success: true, message: `Call ${options.callId} transferred to ${options.targetPhoneNumber}.` }
      : { success: false, message: `Twilio rejected the transfer (HTTP ${res.status}).` };
  }

  async endCall(callId: string): Promise<boolean> {
    const { sid, token } = this.credentials();
    if (!sid || !token) return false;

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls/${encodeURIComponent(callId)}.json`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ Status: 'completed' }).toString(),
      }
    ).catch(() => null);

    return Boolean(res?.ok);
  }

  /**
   * Generates TwiML that opens a Twilio Media Stream to our raw WebSocket handler.
   *
   * IMPORTANT — NO <Say> before <Connect>:
   *   Previously this response contained a <Say voice="Polly.Amy-Neural"> which played
   *   a welcome greeting via Amazon Polly BEFORE the stream opened. This caused two problems:
   *     1. Voice inconsistency: caller heard Polly for the greeting, ElevenLabs for everything else.
   *     2. Race condition: the stream wasn't open yet when the welcome played, so the AI pipeline
   *        missed the start of the call.
   *   Now the TwiML opens the stream immediately and our TwilioMediaStreamHandler plays the
   *   welcome message through ElevenLabs on the 'start' event — same voice, no race.
   *
   * track="both_tracks":
   *   Twilio captures BOTH inbound (caller→us) and outbound (us→caller) audio.
   *   Inbound goes to Deepgram for STT. Outbound is what we inject via media events.
   *   Without this attribute, Twilio defaults to inbound only and our audio events
   *   would be silently discarded.
   *
   * The promptText parameter is now passed as a URL query param (welcomeMsg=...)
   * by TelephonyService so TwilioMediaStreamHandler can read and voice it via ElevenLabs.
   */
  generateInboundWebhookResponse(_promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${escapeXml(streamUrl)}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  /** E.164: leading +, country code, then 6–14 more digits. */
  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return isE164(phoneNumber);
  }
}

export class PlivoProvider implements TelephonyProvider {
  type = TelephonyProviderType.PLIVO;

  constructor(
    private authId?: string,
    private authToken?: string
  ) {}

  /** No Plivo REST integration exists in this package yet. */
  canPlaceOutboundCalls(): boolean {
    return false;
  }

  async initiateCall(_options: CallInitiateOptions): Promise<CallRecord> {
    throw new TelephonyNotAvailableError(
      this.type,
      'Outbound calling via Plivo is not implemented. Use the Twilio or Telnyx provider, ' +
      'or route your Plivo number through a Twilio SIP domain.'
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return { success: false, message: 'Plivo call transfer is not implemented in this build.' };
  }

  async endCall(_callId: string): Promise<boolean> {
    return false;
  }

  /**
   * Plivo AudioSocket (their Media Streams equivalent) uses a different binary
   * framing protocol from Twilio Media Streams — linear16 PCM over WebSocket
   * instead of Twilio's base64-wrapped mulaw JSON events.
   *
   * Our TwilioMediaStreamHandler speaks the Twilio protocol only. Plivo calls
   * will connect to the WS endpoint but immediately fail the protocol handshake.
   *
   * To support Plivo with real-time AI, a separate PlivoAudioSocketHandler is
   * needed that speaks linear16 PCM and sends it directly to Deepgram as
   * encoding=linear16&sample_rate=16000. This is tracked as a future enhancement.
   *
   * For now, Plivo calls fall back to a static text-to-speech response via the
   * Plivo XML API (no real-time conversation — caller hears a message and hangs up).
   */
  generateInboundWebhookResponse(promptText: string, _streamUrl: string): string {
    return `<Response>
    <Speak>${escapeXml(promptText)}</Speak>
    <Hangup />
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return isE164(phoneNumber);
  }
}

export class TelnyxProvider implements TelephonyProvider {
  type = TelephonyProviderType.TELNYX;

  constructor(private apiKey?: string, private publicKey?: string) {}

  private key(): string | undefined {
    return this.apiKey || process.env.TELNYX_API_KEY;
  }

  canPlaceOutboundCalls(): boolean {
    return Boolean(this.key() && process.env.TELNYX_CONNECTION_ID);
  }

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    const key = this.key();
    if (!key) {
      throw new TelephonyNotAvailableError(this.type, 'TELNYX_API_KEY is not configured.');
    }

    // 'default' is not a valid Telnyx connection id — sending it produced a 422 that
    // the old code swallowed, returning a fabricated TL_… id for a call never placed.
    const connectionId = process.env.TELNYX_CONNECTION_ID;
    if (!connectionId) {
      throw new TelephonyNotAvailableError(
        this.type,
        'TELNYX_CONNECTION_ID is not set. Copy the Call Control Application ID from the Telnyx portal.'
      );
    }

    const res = await fetch('https://api.telnyx.com/v2/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        to: options.toNumber,
        from: options.fromNumber,
        connection_id: connectionId,
        webhook_url: `${apiBaseUrl()}/api/telephony/status/telnyx`,
      }),
    });

    const data: any = await res.json().catch(() => null);
    const callControlId = data?.data?.call_control_id;

    if (!res.ok || !callControlId) {
      throw new TelephonyNotAvailableError(
        this.type,
        `Telnyx API returned ${res.status}: ${JSON.stringify(data?.errors ?? data).slice(0, 300)}`
      );
    }

    return {
      callId: callControlId,
      organizationId: options.organizationId,
      from: options.fromNumber,
      to: options.toNumber,
      direction: CallDirection.OUTBOUND,
      status: CallStatus.QUEUED,
      startTime: new Date(),
      provider: this.type,
    };
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    const key = this.key();
    if (!key) return { success: false, message: 'Telnyx API key is not configured — call was not transferred.' };

    const res = await fetch(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(options.callId)}/actions/transfer`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ to: options.targetPhoneNumber }),
      }
    ).catch(() => null);

    return res?.ok
      ? { success: true, message: `Telnyx call transferred to ${options.targetPhoneNumber}.` }
      : { success: false, message: `Telnyx rejected the transfer (HTTP ${res?.status ?? 'network error'}).` };
  }

  async endCall(callId: string): Promise<boolean> {
    const key = this.key();
    if (!key) return false;
    const res = await fetch(
      `https://api.telnyx.com/v2/calls/${encodeURIComponent(callId)}/actions/hangup`,
      { method: 'POST', headers: { Authorization: `Bearer ${key}` } }
    ).catch(() => null);
    return Boolean(res?.ok);
  }

  generateInboundWebhookResponse(promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
  </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return true;
  }
}

export class AfricasTalkingProvider implements TelephonyProvider {
  type = TelephonyProviderType.AFRICAS_TALKING;

  constructor(
    private username?: string,
    private apiKey?: string
  ) {}

  canPlaceOutboundCalls(): boolean {
    return false;
  }

  async initiateCall(_options: CallInitiateOptions): Promise<CallRecord> {
    throw new TelephonyNotAvailableError(
      this.type,
      "Outbound calling via Africa's Talking is not implemented. Forward the number to a " +
      'Twilio SIP domain and place the call through the Twilio provider instead.'
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return { success: false, message: "Africa's Talking call transfer is not implemented in this build." };
  }

  async endCall(_callId: string): Promise<boolean> {
    return false;
  }

  /**
   * Africa's Talking does NOT support persistent WebSocket media streaming.
   * Their voice API is purely webhook-based: each action (say, gather digits, record)
   * is a separate HTTP request/response cycle — there is no open stream to push audio into.
   *
   * Real-time AI conversation is therefore NOT supported for Africa's Talking calls.
   * The webhook response below plays a static TTS message (via AT's built-in TTS engine)
   * and collects digits. For full AI conversations on African carrier numbers, the
   * recommended path is: Africa's Talking → SIP trunk forward → Twilio SIP Domain
   * → our Twilio Media Streams handler. This gives you a Nigerian carrier number
   * (cheaper inbound rates) with full real-time AI capability.
   */
  generateInboundWebhookResponse(promptText: string, _streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <GetDigits timeout="30" finishOnKey="#">
        <Say>${escapeXml(promptText)} Press any key to continue or hash to end.</Say>
    </GetDigits>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return true;
  }
}

/**
 * Special Provider for Nigerian Carriers (MTN, Airtel, Glo, 9mobile).
 * Enables seamless forwarding from native Nigerian business numbers to gateway SIP trunks
 * and verified outbound caller ID mapping.
 *
 * This provider generates Twilio-compatible TwiML because Nigerian carrier numbers are
 * forwarded into a Twilio SIP Domain before reaching our handler. The call flow is:
 *   Nigerian carrier number → MTN/Airtel forwarding → Twilio SIP trunk → our API
 * This means the TwilioMediaStreamHandler handles these calls identically to native Twilio calls.
 */
export class NigeriaCarrierForwardProvider implements TelephonyProvider {
  type = TelephonyProviderType.NIGERIA_CARRIER_FORWARD;

  /**
   * Nigerian carrier SIP forwarding is an *inbound* routing arrangement: the carrier forwards calls into a
   * Twilio SIP domain, which then hits our Twilio webhook. There is no REST API on
   * this side to originate a call, so outbound dialling must go through the Twilio
   * provider. Returning a synthetic call id here (as this used to) recorded calls
   * in the dashboard that were never placed.
   */
  canPlaceOutboundCalls(): boolean {
    return false;
  }

  async initiateCall(_options: CallInitiateOptions): Promise<CallRecord> {
    throw new TelephonyNotAvailableError(
      this.type,
      'Nigerian carrier SIP forwarding handles inbound calls only. Select the Twilio provider to place outbound calls '
      + 'from your forwarded number.'
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return {
      success: false,
      message: 'Call transfer must be performed by the underlying Twilio SIP domain, not this provider.',
    };
  }

  async endCall(_callId: string): Promise<boolean> {
    return false;
  }

  /**
   * Same as TwilioProvider — no <Say>, stream-only, track="both_tracks".
   * Welcome message is played by TwilioMediaStreamHandler via ElevenLabs.
   */
  generateInboundWebhookResponse(_promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${escapeXml(streamUrl)}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    // Validates Nigerian MSISDN formats (+234 / 080 / 081 / 070 / 090 / 091)
    return isNigerianMsisdn(phoneNumber);
  }
}

export class MTNEnterpriseSIPProvider implements TelephonyProvider {
  type = TelephonyProviderType.MTN_ENTERPRISE_SIP;

  /**
   * MTN Business SIP trunking is an *inbound* routing arrangement: the carrier forwards calls into a
   * Twilio SIP domain, which then hits our Twilio webhook. There is no REST API on
   * this side to originate a call, so outbound dialling must go through the Twilio
   * provider. Returning a synthetic call id here (as this used to) recorded calls
   * in the dashboard that were never placed.
   */
  canPlaceOutboundCalls(): boolean {
    return false;
  }

  async initiateCall(_options: CallInitiateOptions): Promise<CallRecord> {
    throw new TelephonyNotAvailableError(
      this.type,
      'MTN Business SIP trunking handles inbound calls only. Select the Twilio provider to place outbound calls '
      + 'from your forwarded number.'
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return {
      success: false,
      message: 'Call transfer must be performed by the underlying Twilio SIP domain, not this provider.',
    };
  }

  async endCall(_callId: string): Promise<boolean> {
    return false;
  }

  generateInboundWebhookResponse(_promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${escapeXml(streamUrl)}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return isNigerianMsisdn(phoneNumber);
  }
}

export class AirtelBusinessSIPProvider implements TelephonyProvider {
  type = TelephonyProviderType.AIRTEL_BUSINESS_SIP;

  /**
   * Airtel Business SIP trunking is an *inbound* routing arrangement: the carrier forwards calls into a
   * Twilio SIP domain, which then hits our Twilio webhook. There is no REST API on
   * this side to originate a call, so outbound dialling must go through the Twilio
   * provider. Returning a synthetic call id here (as this used to) recorded calls
   * in the dashboard that were never placed.
   */
  canPlaceOutboundCalls(): boolean {
    return false;
  }

  async initiateCall(_options: CallInitiateOptions): Promise<CallRecord> {
    throw new TelephonyNotAvailableError(
      this.type,
      'Airtel Business SIP trunking handles inbound calls only. Select the Twilio provider to place outbound calls '
      + 'from your forwarded number.'
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return {
      success: false,
      message: 'Call transfer must be performed by the underlying Twilio SIP domain, not this provider.',
    };
  }

  async endCall(_callId: string): Promise<boolean> {
    return false;
  }

  generateInboundWebhookResponse(_promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${escapeXml(streamUrl)}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return isNigerianMsisdn(phoneNumber);
  }
}

export class TelephonyFactory {
  static createProvider(type: TelephonyProviderType, credentials: Record<string, any> = {}): TelephonyProvider {
    switch (type) {
      case TelephonyProviderType.TWILIO:
        return new TwilioProvider(credentials.accountSid, credentials.authToken);
      case TelephonyProviderType.PLIVO:
        return new PlivoProvider(credentials.authId, credentials.authToken);
      case TelephonyProviderType.TELNYX:
        return new TelnyxProvider(credentials.apiKey);
      case TelephonyProviderType.AFRICAS_TALKING:
        return new AfricasTalkingProvider(credentials.username, credentials.apiKey);
      case TelephonyProviderType.NIGERIA_CARRIER_FORWARD:
        return new NigeriaCarrierForwardProvider();
      case TelephonyProviderType.MTN_ENTERPRISE_SIP:
        return new MTNEnterpriseSIPProvider();
      case TelephonyProviderType.AIRTEL_BUSINESS_SIP:
        return new AirtelBusinessSIPProvider();
      default:
        return new TwilioProvider();
    }
  }
}


// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * E.164 validation: a leading '+', a non-zero country code digit, then 7–14 more
 * digits. The previous check (`phoneNumber.length >= 10`) accepted "abcdefghij".
 */
export function isE164(phoneNumber: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test((phoneNumber ?? '').replace(/[\s()-]/g, ''));
}

/**
 * Nigerian MSISDN in either local (0803…) or international (+234803…) form.
 */
export function isNigerianMsisdn(phoneNumber: string): boolean {
  const clean = (phoneNumber ?? '').replace(/[\s()-]/g, '');
  return /^(?:\+234|234|0)[789][01]\d{8}$/.test(clean);
}

/** Escapes a value for safe interpolation into TwiML/XML. */
export function escapeXml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
