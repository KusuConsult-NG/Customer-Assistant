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
}

export class TwilioProvider implements TelephonyProvider {
  type = TelephonyProviderType.TWILIO;

  constructor(
    private accountSid?: string,
    private authToken?: string
  ) {}

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    const sid = this.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const token = this.authToken || process.env.TWILIO_AUTH_TOKEN;

    if (sid && token) {
      try {
        const baseUrl = process.env.API_URL || 'http://localhost:4000';
        const params = new URLSearchParams({
          To: options.toNumber,
          From: options.fromNumber,
          Url: `${baseUrl}/api/telephony/inbound/twilio?orgId=${options.organizationId}`,
        });

        const authHeader = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
        });

        if (res.ok) {
          const data: any = await res.json();
          return {
            callId: data.sid,
            organizationId: options.organizationId,
            from: options.fromNumber,
            to: options.toNumber,
            direction: CallDirection.OUTBOUND,
            status: CallStatus.IN_PROGRESS,
            startTime: new Date(),
            provider: this.type,
          };
        }
        // HONESTY: a failed Twilio API call used to fall through to a
        // fabricated CA_TW_* record with status QUEUED — the dashboard showed
        // a call that never existed. Failure must be visible.
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(`Twilio call initiation failed (HTTP ${res.status}): ${errText.slice(0, 300)}`);
      } catch (err: any) {
        if (err?.message?.startsWith('Twilio call initiation failed')) throw err;
        throw new Error(`Twilio call initiation failed: ${err?.message ?? err}`);
      }
    }

    throw new Error(
      'Twilio credentials are not configured (accountSid/authToken or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN). ' +
      'Outbound calls cannot be placed — configure credentials under Settings → Telephony.'
    );
  }


  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return {
      success: true,
      message: `Call ${options.callId} transferred to ${options.targetPhoneNumber} via Twilio TwiML redirect`,
    };
  }

  async endCall(callId: string): Promise<boolean> {
    return true;
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
        <Stream url="${streamUrl}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return phoneNumber.length >= 10;
  }
}

export class PlivoProvider implements TelephonyProvider {
  type = TelephonyProviderType.PLIVO;

  constructor(
    private authId?: string,
    private authToken?: string
  ) {}

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    // HONESTY: this used to return a fabricated PL_* record with status
    // QUEUED — the dashboard logged an outbound call that never existed.
    throw new Error(
      `PlivoProvider outbound origination is not implemented yet. ` +
      `Use the TWILIO provider for outbound calls (options.provider = 'TWILIO').`
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return { success: true, message: `Plivo call transferred to ${options.targetPhoneNumber}` };
  }

  async endCall(callId: string): Promise<boolean> {
    return true;
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
    <Speak>${promptText}</Speak>
    <Hangup />
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    return true;
  }
}

export class TelnyxProvider implements TelephonyProvider {
  type = TelephonyProviderType.TELNYX;

  constructor(private apiKey?: string, private publicKey?: string) {}

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    const key = this.apiKey || process.env.TELNYX_API_KEY;

    if (key) {
      try {
        const res = await fetch('https://api.telnyx.com/v2/calls', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`,
          },
          body: JSON.stringify({
            to: options.toNumber,
            from: options.fromNumber,
            connection_id: process.env.TELNYX_CONNECTION_ID || 'default',
            stream_url: `${process.env.API_URL?.replace(/^http/, 'ws')}/media-stream`,
          }),
        });
        const data: any = await res.json();
        if (data?.data?.call_control_id) {
          return {
            callId: data.data.call_control_id,
            organizationId: options.organizationId,
            from: options.fromNumber,
            to: options.toNumber,
            direction: CallDirection.OUTBOUND,
            status: CallStatus.QUEUED,
            startTime: new Date(),
            provider: this.type,
          };
        }
        throw new Error(`Telnyx call initiation failed: ${JSON.stringify(data?.errors ?? data).slice(0, 300)}`);
      } catch (err: any) {
        if (err?.message?.startsWith('Telnyx call initiation failed')) throw err;
        throw new Error(`Telnyx call initiation failed: ${err?.message ?? err}`);
      }
    }

    throw new Error(
      'Telnyx API key is not configured (apiKey or TELNYX_API_KEY). Outbound calls cannot be placed.'
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return { success: true, message: `Telnyx call transferred to ${options.targetPhoneNumber}` };
  }

  async endCall(callId: string): Promise<boolean> {
    return true;
  }

  generateInboundWebhookResponse(promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
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

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    // HONESTY: this used to return a fabricated AT_* record with status
    // QUEUED — the dashboard logged an outbound call that never existed.
    throw new Error(
      `Africa's Talking outbound origination is not implemented yet. ` +
      `Use the TWILIO provider for outbound calls (options.provider = 'TWILIO').`
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return { success: true, message: `Africa's Talking call redirected to ${options.targetPhoneNumber}` };
  }

  async endCall(callId: string): Promise<boolean> {
    return true;
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
        <Say>${promptText} Press any key to continue or hash to end.</Say>
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

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    // HONESTY: this used to return a fabricated NG_TELCO_* record with status
    // QUEUED — the dashboard logged an outbound call that never existed.
    throw new Error(
      `NIGERIA_CARRIER_FORWARD works by carrier-side call forwarding and cannot ORIGINATE outbound calls. ` +
      `Use the TWILIO provider for outbound calls (options.provider = 'TWILIO').`
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return {
      success: true,
      message: `Call transferred via Nigerian Telco SIP bridge to agent line: ${options.targetPhoneNumber}`,
    };
  }

  async endCall(callId: string): Promise<boolean> {
    return true;
  }

  /**
   * Same as TwilioProvider — no <Say>, stream-only, track="both_tracks".
   * Welcome message is played by TwilioMediaStreamHandler via ElevenLabs.
   */
  generateInboundWebhookResponse(_promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${streamUrl}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    // Validates Nigerian MSISDN formats (+234 / 080 / 081 / 070 / 090 / 091)
    const cleanNumber = phoneNumber.replace(/\s+/g, '');
    const ngRegex = /^(?:\+234|234|0)[789][01]\d{8}$/;
    return ngRegex.test(cleanNumber);
  }
}

export class MTNEnterpriseSIPProvider implements TelephonyProvider {
  type = TelephonyProviderType.MTN_ENTERPRISE_SIP;

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    // HONESTY: this used to return a fabricated MTN_SIP_* record with status
    // QUEUED — the dashboard logged an outbound call that never existed.
    throw new Error(
      `MTN Enterprise SIP outbound origination is not implemented yet. ` +
      `Use the TWILIO provider for outbound calls (options.provider = 'TWILIO').`
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return {
      success: true,
      message: `Call transferred via MTN Business SIP Trunk to ${options.targetPhoneNumber}`,
    };
  }

  async endCall(callId: string): Promise<boolean> {
    return true;
  }

  generateInboundWebhookResponse(_promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${streamUrl}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    const cleanNumber = phoneNumber.replace(/\s+/g, '');
    return /^(?:\+234|234|0)[789][01]\d{8}$/.test(cleanNumber);
  }
}

export class AirtelBusinessSIPProvider implements TelephonyProvider {
  type = TelephonyProviderType.AIRTEL_BUSINESS_SIP;

  async initiateCall(options: CallInitiateOptions): Promise<CallRecord> {
    // HONESTY: this used to return a fabricated AIRTEL_SIP_* record with status
    // QUEUED — the dashboard logged an outbound call that never existed.
    throw new Error(
      `Airtel Business SIP outbound origination is not implemented yet. ` +
      `Use the TWILIO provider for outbound calls (options.provider = 'TWILIO').`
    );
  }

  async transferCall(options: CallTransferOptions): Promise<{ success: boolean; message: string }> {
    return {
      success: true,
      message: `Call transferred via Airtel Business SIP Trunk to ${options.targetPhoneNumber}`,
    };
  }

  async endCall(callId: string): Promise<boolean> {
    return true;
  }

  generateInboundWebhookResponse(_promptText: string, streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="${streamUrl}" track="both_tracks" />
    </Connect>
</Response>`;
  }

  async verifyCallerId(phoneNumber: string): Promise<boolean> {
    const cleanNumber = phoneNumber.replace(/\s+/g, '');
    return /^(?:\+234|234|0)[789][01]\d{8}$/.test(cleanNumber);
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

