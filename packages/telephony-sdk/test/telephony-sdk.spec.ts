import {
  TelephonyFactory,
  TwilioProvider,
  PlivoProvider,
  AfricasTalkingProvider,
  NigeriaCarrierForwardProvider,
  TelephonyNotAvailableError,
  isE164,
  isNigerianMsisdn,
  escapeXml,
} from '../src/index';
import { TelephonyProviderType, CallDirection } from '@ace/shared-types';

describe('Telephony SDK', () => {
  describe('Caller ID validation', () => {
    it('accepts Nigerian numbers in local and international form', async () => {
      const provider = TelephonyFactory.createProvider(TelephonyProviderType.NIGERIA_CARRIER_FORWARD);
      expect(provider.type).toBe(TelephonyProviderType.NIGERIA_CARRIER_FORWARD);

      await expect(provider.verifyCallerId('+2348031234567')).resolves.toBe(true);
      await expect(provider.verifyCallerId('08129876543')).resolves.toBe(true);
      await expect(provider.verifyCallerId('12345')).resolves.toBe(false);
    });

    it('validates E.164 rather than just counting characters', async () => {
      const twilio = new TwilioProvider('AC_test', 'token_test');

      await expect(twilio.verifyCallerId('+14155552671')).resolves.toBe(true);
      await expect(twilio.verifyCallerId('+2348031234567')).resolves.toBe(true);

      // Regression guard: verifyCallerId used to be `phoneNumber.length >= 10`, which
      // accepted any ten characters at all.
      await expect(twilio.verifyCallerId('abcdefghijk')).resolves.toBe(false);
      await expect(twilio.verifyCallerId('08031234567')).resolves.toBe(false); // no +
      await expect(twilio.verifyCallerId('+0123456789')).resolves.toBe(false); // 0 country code
    });

    it('exposes the shared helpers', () => {
      expect(isE164('+2348031234567')).toBe(true);
      expect(isE164('2348031234567')).toBe(false);
      expect(isNigerianMsisdn('08031234567')).toBe(true);
      expect(isNigerianMsisdn('+14155552671')).toBe(false);
    });
  });

  describe('TwiML generation', () => {
    it('opens a media stream with both tracks and no <Say>', () => {
      const twilio = new TwilioProvider('AC_test', 'token_test');
      const xml = twilio.generateInboundWebhookResponse('Welcome to ApexCare', 'wss://api.apexcare.ng/stream');

      // The greeting is intentionally NOT in the TwiML: TwilioMediaStreamHandler
      // speaks it through ElevenLabs once the stream is open, so the whole call uses
      // one voice. (The old test asserted the opposite and had been failing silently
      // because no package had a `test` script wired up.)
      expect(xml).not.toContain('Welcome to ApexCare');
      expect(xml).toContain('<Stream url="wss://api.apexcare.ng/stream" track="both_tracks" />');
    });

    it('escapes the query string in the stream URL so the XML stays well-formed', () => {
      const twilio = new TwilioProvider('AC_test', 'token_test');
      const xml = twilio.generateInboundWebhookResponse(
        '',
        'wss://api.example.com/telephony/stream/CA123?orgId=abc&from=%2B234&to=%2B1'
      );

      // A bare '&' inside an XML attribute is malformed.
      expect(xml).toContain('orgId=abc&amp;from=%2B234&amp;to=%2B1');
      expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    });

    it('escapes untrusted text in providers that do speak a prompt', () => {
      const at = new AfricasTalkingProvider();
      const xml = at.generateInboundWebhookResponse('Tom & Jerry <script>', '');
      expect(xml).toContain('Tom &amp; Jerry &lt;script&gt;');
    });

    it('escapeXml handles every reserved character', () => {
      expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
    });
  });

  describe('Outbound calling honesty', () => {
    it('reports that providers without a REST integration cannot dial out', () => {
      expect(new PlivoProvider().canPlaceOutboundCalls()).toBe(false);
      expect(new AfricasTalkingProvider().canPlaceOutboundCalls()).toBe(false);
      expect(new NigeriaCarrierForwardProvider().canPlaceOutboundCalls()).toBe(false);
    });

    it('throws instead of returning a fabricated call id', async () => {
      // Regression guard: each of these used to return
      // `{ callId: 'PL_1699…', status: QUEUED }` for a call that was never placed,
      // which the API then wrote to CallLog and showed in the dashboard as real.
      for (const provider of [
        new PlivoProvider(),
        new AfricasTalkingProvider(),
        new NigeriaCarrierForwardProvider(),
      ]) {
        await expect(
          provider.initiateCall({
            organizationId: 'org_1',
            fromNumber: '+2348031234567',
            toNumber: '+2348039876543',
            provider: provider.type,
          })
        ).rejects.toBeInstanceOf(TelephonyNotAvailableError);
      }
    });

    it('throws when Twilio credentials are absent rather than inventing a CA_TW_ id', async () => {
      const priorSid = process.env.TWILIO_ACCOUNT_SID;
      const priorToken = process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;

      try {
        const twilio = new TwilioProvider();
        expect(twilio.canPlaceOutboundCalls()).toBe(false);

        await expect(
          twilio.initiateCall({
            organizationId: 'org_1',
            fromNumber: '+2348031234567',
            toNumber: '+2348039876543',
            provider: TelephonyProviderType.TWILIO,
          })
        ).rejects.toBeInstanceOf(TelephonyNotAvailableError);
      } finally {
        if (priorSid) process.env.TWILIO_ACCOUNT_SID = priorSid;
        if (priorToken) process.env.TWILIO_AUTH_TOKEN = priorToken;
      }
    });

    it('reports failure rather than success for unimplemented transfers', async () => {
      const result = await new PlivoProvider().transferCall({
        callId: 'x',
        targetPhoneNumber: '+2348031234567',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('Factory', () => {
    it('builds every provider type declared in shared-types', () => {
      for (const type of Object.values(TelephonyProviderType)) {
        const provider = TelephonyFactory.createProvider(type);
        expect(provider.type).toBe(type);
      }
    });
  });
});
