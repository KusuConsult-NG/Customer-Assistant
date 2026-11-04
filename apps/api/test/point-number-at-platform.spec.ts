/**
 * Asking Twilio to send a number's calls here.
 *
 * This is the one thing the readiness report cannot see. Every check in it can
 * be green — line saved, credentials stored, speech configured, agent
 * provisioned — while the number still rings to whatever its Voice webhook
 * points at, which on a fresh Twilio number is a demo TwiML bin. Readiness
 * knows what WE hold; it does not know what Twilio will do with a call.
 *
 * Twilio is stubbed at `fetch`, deliberately: the assertions are about what is
 * SENT to it and what is believed from its reply. The behaviour that matters
 * is that the outcome is read back from Twilio's own response — the same
 * act-then-announce rule the voice handoff follows, because a confirmation
 * nobody verified is the bug invariant 1 exists for.
 */
import { INestApplication, BadRequestException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { prisma, encryptSecret } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { VoiceReadinessService } from '../src/telephony/voice-readiness.service';

describe('pointing a number at the platform', () => {
  let app: INestApplication;
  let readiness: VoiceReadinessService;
  let orgId: string;

  jest.setTimeout(60000);

  const BASE = 'https://api.point.example';
  const SID = 'ACpoint00000000000000000000000000';
  const TOKEN = 'point_auth_token_0123456789abcd';
  const NUMBER = '+17372212163';
  const NUMBER_SID = 'PNpoint0000000000000000000000000';

  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  let calls: Array<{ url: string; method: string; body?: string }> = [];
  let realFetch: typeof globalThis.fetch;

  /** Twilio's shape: a list endpoint keyed by number, then an update by sid. */
  const stubTwilio = (opts: {
    found?: boolean;
    listStatus?: number;
    updateStatus?: number;
    previousVoiceUrl?: string | null;
    /** What Twilio claims the webhook is AFTER the update. */
    echoVoiceUrl?: string;
    networkError?: boolean;
  }) => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (opts.networkError) throw new Error('getaddrinfo ENOTFOUND api.twilio.com');

      if (url.includes('/IncomingPhoneNumbers.json?')) {
        if (opts.listStatus && opts.listStatus !== 200) {
          return new Response('{"message":"Authenticate"}', { status: opts.listStatus });
        }
        const body = opts.found === false
          ? { incoming_phone_numbers: [] }
          : {
              incoming_phone_numbers: [
                { sid: NUMBER_SID, voice_url: opts.previousVoiceUrl ?? 'https://demo.twilio.com/welcome/voice/' },
              ],
            };
        return new Response(JSON.stringify(body), { status: 200 });
      }

      if (opts.updateStatus && opts.updateStatus !== 200) {
        return new Response('{"message":"Url is not a valid URL"}', { status: opts.updateStatus });
      }
      return new Response(
        JSON.stringify({
          voice_url: opts.echoVoiceUrl ?? `${BASE}/api/telephony/inbound/twilio`,
          status_callback: `${BASE}/api/telephony/status/twilio`,
        }),
        { status: 200 }
      );
    }) as any;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    app = await createTestApp();
    readiness = app.get(VoiceReadinessService);
    realFetch = globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await app.close();
  });

  beforeEach(async () => {
    calls = [];
    setEnv('API_BASE_URL', BASE);
    const org = await prisma.organization.create({
      data: { name: 'Point Agency', slug: `point-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
  });

  const withLine = (overrides: Record<string, unknown> = {}) =>
    prisma.telephonyConfig.create({
      data: {
        organizationId: orgId,
        provider: 'TWILIO',
        phoneNumber: NUMBER,
        accountSid: SID,
        authToken: encryptSecret(TOKEN),
        isDefault: true,
        ...overrides,
      },
    });

  it('refuses when API_BASE_URL is not reachable from Twilio', async () => {
    setEnv('API_BASE_URL', 'http://localhost:4000');
    await withLine();
    stubTwilio({});
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toThrow(/cannot reach that/i);
    // Nothing was sent. Pointing a real number at localhost takes the line out
    // of service, so this must refuse BEFORE touching Twilio.
    expect(calls).toHaveLength(0);
  });

  it('refuses without the confirmation, naming where calls would go', async () => {
    await withLine();
    stubTwilio({});
    await expect(
      readiness.pointNumberAtPlatform(orgId, {})
    ).rejects.toThrow(/Re-send with confirmRepointsCarrierWebhook/);
    expect(calls).toHaveLength(0);
  });

  it('refuses when the agency has no Twilio line', async () => {
    stubTwilio({});
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toThrow(/no Twilio line/);
    expect(calls).toHaveLength(0);
  });

  it('makes the caller name the line when there are several', async () => {
    await withLine();
    await withLine({ phoneNumber: '+17372219999', isDefault: false });
    stubTwilio({});
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toThrow(/Say which one with phoneNumber/);
    // Choosing for them would silently move one agency number's calls and
    // leave the rest pointed elsewhere.
    expect(calls).toHaveLength(0);
  });

  it('refuses a line with no stored credentials', async () => {
    await withLine({ accountSid: null, authToken: null });
    stubTwilio({});
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toThrow(/no stored Twilio credentials/);
    expect(calls).toHaveLength(0);
  });

  it('sends the right request, with the decrypted token', async () => {
    await withLine();
    stubTwilio({ previousVoiceUrl: 'https://demo.twilio.com/welcome/voice/' });

    const result = await readiness.pointNumberAtPlatform(orgId, {
      confirmRepointsCarrierWebhook: true,
    });

    expect(calls).toHaveLength(2);
    // Looked up by number, then updated by the number's own sid — Twilio
    // addresses a number by sid, not by the number itself.
    expect(calls[0].url).toContain(`/Accounts/${SID}/IncomingPhoneNumbers.json?PhoneNumber=`);
    expect(calls[1].url).toContain(`/IncomingPhoneNumbers/${NUMBER_SID}.json`);
    expect(calls[1].method).toBe('POST');

    const sent = new URLSearchParams(calls[1].body!);
    expect(sent.get('VoiceUrl')).toBe(`${BASE}/api/telephony/inbound/twilio`);
    expect(sent.get('VoiceMethod')).toBe('POST');
    expect(sent.get('StatusCallback')).toBe(`${BASE}/api/telephony/status/twilio`);

    expect(result.pointedHere).toBe(true);
    // What it REPLACED is reported, so the change is reversible by somebody
    // who did not make it.
    expect(result.previousVoiceUrl).toBe('https://demo.twilio.com/welcome/voice/');
  });

  it('does NOT claim success when Twilio echoes a different webhook', async () => {
    await withLine();
    // Twilio answered 200 but reports something else — a rejected value
    // silently ignored, a racing change, an account-level override.
    stubTwilio({ echoVoiceUrl: 'https://somewhere.else/voice' });

    const result = await readiness.pointNumberAtPlatform(orgId, {
      confirmRepointsCarrierWebhook: true,
    });

    // THE assertion. The outcome is read from Twilio's reply, not from the
    // request. Reporting success here would be the fabrication the voice
    // handoff rule exists to prevent — and the caller would reach whatever
    // that other URL answers with.
    expect(result.pointedHere).toBe(false);
    expect(result.voiceUrl).toBe('https://somewhere.else/voice');
  });

  it('says the number is on a different account when Twilio does not know it', async () => {
    await withLine();
    stubTwilio({ found: false });
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toThrow(/not on the Twilio account these credentials belong to/);
    // The useful failure: credentials and number belong to different accounts,
    // which no amount of webhook configuration would fix.
    expect(calls).toHaveLength(1);
  });

  it('reports a refused credential as a credential problem', async () => {
    await withLine();
    stubTwilio({ listStatus: 401 });
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toThrow(/refused the credential check/);
  });

  it("reports Twilio's own reason when it refuses the change", async () => {
    await withLine();
    stubTwilio({ updateStatus: 400 });
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toThrow(/not a valid URL/);
  });

  it('reports an unreachable Twilio as unreachable, not as done', async () => {
    await withLine();
    stubTwilio({ networkError: true });
    await expect(
      readiness.pointNumberAtPlatform(orgId, { confirmRepointsCarrierWebhook: true })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
