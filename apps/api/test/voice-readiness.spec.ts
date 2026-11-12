/**
 * GET /api/telephony/voice-readiness
 *
 * Four separate misconfigurations each produce a call that CONNECTS and goes
 * nowhere, and Twilio reports every one of them as answered and completed:
 *
 *   - No `ELEVENLABS_API_KEY`: the inbound TwiML is `<Connect><Stream/>` and
 *     nothing else (`generateInboundWebhookResponse` discards the promptText
 *     it is handed), so the greeting is spoken over the socket. With no TTS
 *     the caller hears pure silence for the whole call.
 *   - No `DEEPGRAM_API_KEY`: the caller is never transcribed. They hear the
 *     greeting, speak, and nothing answers.
 *   - An `API_BASE_URL` that does not match the URL Twilio requested, byte for
 *     byte: the signature is computed over it, so every call is refused with
 *     "This call could not be authenticated" — which reads as a bad auth
 *     token and sends the operator to look at the wrong thing.
 *   - No auth token stored: signature verification is skipped with a warning,
 *     and outbound, transfers and status callbacks all fail.
 *
 * So the one thing this endpoint must never do is report a call as workable
 * when it is not. These tests assert the verdict against a deliberately
 * broken environment, because a readiness report that is optimistic is worse
 * than none: it is the thing an operator believes instead of the silence.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma, encryptSecret } from '@ace/database';

import { AppModule } from '../src/app.module';

describe('voice readiness', () => {
  let app: INestApplication;
  let orgId: string;
  let ownerToken: string;
  let operatorToken: string;
  let agentToken: string;

  jest.setTimeout(60000);

  const envBefore: Record<string, string | undefined> = {};
  const setEnv = (key: string, value: string | undefined) => {
    if (!(key in envBefore)) envBefore[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  // Captured at module load, before any stub replaces it.
  const realFetch: typeof globalThis.fetch = globalThis.fetch;
  /**
   * Twilio is stubbed for the whole suite.
   *
   * The report asks the carrier now, so without this every test with a line
   * would make a real outbound request — slow, flaky, and dependent on an
   * account nobody owns. `carrier()` sets what Twilio claims; the default is
   * the happy case so the existing assertions keep meaning what they meant.
   */
  const carrier = (opts: { holds?: boolean; voiceUrl?: string; fail?: boolean } = {}) => {
    globalThis.fetch = (async () => {
      if (opts.fail) throw new Error('ENOTFOUND api.twilio.com');
      const holds = opts.holds !== false;
      return new Response(
        JSON.stringify({
          incoming_phone_numbers: holds
            ? [{ sid: 'PN1', voice_url: opts.voiceUrl ?? 'https://api.readiness.example/api/telephony/inbound/twilio' }]
            : [],
        }),
        { status: 200 }
      );
    }) as any;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    const org = await prisma.organization.create({
      data: {
        name: 'Readiness Agency',
        slug: `readiness-${randomBytes(4).toString('hex')}`,
        industry: 'GOVERNMENT',
        welcomeMessage: 'You have reached the Readiness Agency.',
      },
    });
    orgId = org.id;

    const mkUser = async (role: 'OWNER' | 'AGENT', isPlatformAdmin = false) => {
      const email = `${role.toLowerCase()}.${randomBytes(4).toString('hex')}@readiness.test`;
      const password = 'ReadinessPassw0rd!';
      await prisma.user.create({
        data: {
          organizationId: orgId, email, fullName: `${role} tester`, role,
          passwordHash: await bcrypt.hash(password, 10), isPlatformAdmin,
        },
      });
      const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
      expect(login.body.accessToken).toBeTruthy();
      return login.body.accessToken as string;
    };
    ownerToken = await mkUser('OWNER');
    // The full report is for platform operators; an agency owner gets plain
    // wording (see agency-audience.ts and the last test below).
    operatorToken = await mkUser('OWNER', true);
    agentToken = await mkUser('AGENT');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(envBefore)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    carrier();
    await prisma.telephonyConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.callbackRequest.deleteMany({ where: { organizationId: orgId } });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const get = (token = operatorToken) =>
    request(app.getHttpServer()).get('/api/telephony/voice-readiness').set('Authorization', `Bearer ${token}`);

  const check = (body: any, id: string) => body.checks.find((c: any) => c.id === id);

  const workingLine = () =>
    prisma.telephonyConfig.create({
      data: {
        organizationId: orgId, provider: 'TWILIO', phoneNumber: '+2348030005555',
        accountSid: 'AC_readiness', authToken: encryptSecret('a'.repeat(32)),
        forwardingNumber: '+2348030006666', isDefault: true,
      },
    });

  const fullyConfiguredEnv = () => {
    setEnv('API_BASE_URL', 'https://api.readiness.example');
    setEnv('API_URL', undefined);
    setEnv('ELEVENLABS_API_KEY', 'el_readiness_key');
    setEnv('DEEPGRAM_API_KEY', 'dg_readiness_key');
    setEnv('OPENAI_API_KEY', 'sk_readiness_key');
  };

  it('is OWNER/ADMIN only', async () => {
    await workingLine();
    expect((await get(agentToken)).status).toBe(403);
    expect((await get(ownerToken)).status).toBe(200);
  });

  it('reports ready only when everything a call needs is present', async () => {
    await workingLine();
    fullyConfiguredEnv();

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.state).toBe('ready');
    expect(body.checks.every((c: any) => c.state === 'ready')).toBe(true);
  });

  it('is BLOCKED, not ready, when the caller would hear silence', async () => {
    await workingLine();
    fullyConfiguredEnv();
    setEnv('ELEVENLABS_API_KEY', undefined);

    const { body } = await get();
    // The whole point. A call with no TTS connects, Twilio marks it completed,
    // and the caller hears nothing at all — so this must never read "ready".
    expect(body.state).toBe('blocked');
    expect(check(body, 'tts').state).toBe('blocked');
    expect(check(body, 'tts').consequence).toMatch(/SILENCE/i);
    expect(body.summary).toMatch(/Text to speech/);
  });

  it('is BLOCKED when the caller could not be transcribed', async () => {
    await workingLine();
    fullyConfiguredEnv();
    setEnv('DEEPGRAM_API_KEY', undefined);

    const { body } = await get();
    expect(body.state).toBe('blocked');
    expect(check(body, 'stt').state).toBe('blocked');
  });

  it('is BLOCKED on a local API_BASE_URL, because the signature is computed over it', async () => {
    await workingLine();
    fullyConfiguredEnv();
    setEnv('API_BASE_URL', 'http://localhost:4000');

    const { body } = await get();
    expect(body.state).toBe('blocked');
    expect(check(body, 'api_base_url').state).toBe('blocked');
    expect(check(body, 'api_base_url').consequence).toMatch(/could not be authenticated/i);
  });

  it('hands over the exact webhook URL the signature will be verified against', async () => {
    await workingLine();
    fullyConfiguredEnv();

    const { body } = await get();
    // Generated from the same expression telephony.service.ts uses. If an
    // operator pastes this and calls are still refused, API_BASE_URL is wrong
    // — which this report also says out loud.
    expect(body.twilio.voiceWebhook).toEqual({
      method: 'POST',
      url: 'https://api.readiness.example/api/telephony/inbound/twilio',
    });
    expect(body.twilio.statusCallback.url).toBe('https://api.readiness.example/api/telephony/status/twilio');
    expect(body.twilio.mediaStream).toBe('wss://api.readiness.example/telephony/stream/<callSid>');
  });

  /**
   * A caller who needs a person is queued for a CALLBACK, not transferred, so
   * a line needs no forwarding number. The old check called a missing one
   * DEGRADED — under this design that is the intended state, and a report
   * that flags the intended state on every run teaches an operator to stop
   * reading it. What can actually be wrong now is a queue nobody works.
   */
  describe('when a caller needs a person', () => {
    const line = () =>
      prisma.telephonyConfig.create({
        data: {
          organizationId: orgId, provider: 'TWILIO', phoneNumber: '+2348030007777',
          accountSid: 'AC_readiness', authToken: encryptSecret('b'.repeat(32)), isDefault: true,
        },
      });
    const owed = async (dueMinutesAgo: number) => {
      const contact = await prisma.contact.create({
        data: { organizationId: orgId, fullName: 'Citizen', phoneNumber: `+23480${Math.floor(Math.random() * 1e8)}` },
      });
      return prisma.callbackRequest.create({
        data: {
          organizationId: orgId, contactId: contact.id, phoneNumber: contact.phoneNumber,
          reason: 'Asked for a person', promisedText: 'As soon as an officer is free',
          dueAt: new Date(Date.now() - dueMinutesAgo * 60_000), status: 'DUE' as any,
        },
      });
    };

    it('does NOT flag a line with no forwarding number', async () => {
      fullyConfiguredEnv();
      await line();
      const { body } = await get();
      expect(check(body, 'forwarding')).toBeUndefined();
      expect(check(body, 'handoff').state).toBe('ready');
      expect(check(body, 'handoff').detail).toMatch(/callback/i);
    });

    it('counts what is owed, and flags callbacks over an hour late', async () => {
      fullyConfiguredEnv();
      await line();
      await owed(5);
      await owed(90);
      const { body } = await get();
      const c = check(body, 'handoff');
      expect(c.detail).toMatch(/2 open, 1 more than an hour overdue/);
      // Each of those citizens was told an officer would ring.
      expect(c.state).toBe('degraded');
      expect(c.consequence).toMatch(/nobody has/i);
    });

    it('stays ready when everything owed is recent', async () => {
      fullyConfiguredEnv();
      await line();
      await owed(5);
      const { body } = await get();
      expect(check(body, 'handoff').state).toBe('ready');
    });
  });

  it('is BLOCKED with no line at all, and says what the caller hears', async () => {
    fullyConfiguredEnv();
    const { body } = await get();
    expect(body.state).toBe('blocked');
    expect(check(body, 'telephony_config').state).toBe('blocked');
    expect(check(body, 'telephony_config').consequence).toMatch(/not currently configured/);
  });

  it('names which engine will answer once the number is cut over', async () => {
    await workingLine();
    fullyConfiguredEnv();
    await prisma.hostedAgentConfig.create({
      data: { organizationId: orgId, agentId: 'agent_x', phoneNumberId: 'pn_x', isActive: true },
    });

    const { body } = await get();
    // After the import, ElevenLabs answers Twilio directly and the
    // media-stream path is bypassed — so an operator debugging silence needs
    // to know which engine they are debugging.
    expect(check(body, 'engine').detail).toMatch(/ElevenLabs hosted agent owns this number/);
  });

  it('never returns a credential value', async () => {
    await workingLine();
    fullyConfiguredEnv();

    const raw = JSON.stringify((await get()).body);
    // The stored token, and the env-held keys, must not appear anywhere.
    expect(raw).not.toContain('a'.repeat(32));
    expect(raw).not.toContain('el_readiness_key');
    expect(raw).not.toContain('dg_readiness_key');
    expect(raw).not.toContain('sk_readiness_key');
    // A ciphertext must not leak either: masking the stored value instead of
    // the decrypted one shows four characters of base64 that match nothing.
    expect(raw).not.toContain('v1.');
  });

  describe('what the carrier will actually do', () => {
    it('is BLOCKED when the account does not hold the number', async () => {
      await workingLine();
      fullyConfiguredEnv();
      // The exact state of the live deployment: valid credentials, and an
      // account with no numbers.
      carrier({ holds: false });

      const { body } = await get();
      const c = check(body, 'carrier:+2348030005555');
      expect(c.state).toBe('blocked');
      expect(c.consequence).toMatch(/No call can arrive/);
      // And it must drag the VERDICT down. The report claimed "A call will
      // connect and be answered" on exactly this configuration.
      expect(body.state).toBe('blocked');
    });

    it('is BLOCKED when the number rings somewhere else', async () => {
      await workingLine();
      fullyConfiguredEnv();
      carrier({ voiceUrl: 'https://demo.twilio.com/welcome/voice/' });

      const { body } = await get();
      const c = check(body, 'carrier:+2348030005555');
      expect(c.state).toBe('blocked');
      expect(c.detail).toMatch(/demo\.twilio\.com/);
      expect(body.state).toBe('blocked');
    });

    it('is UNKNOWN, not ready, when Twilio cannot be asked', async () => {
      await workingLine();
      fullyConfiguredEnv();
      carrier({ fail: true });

      const { body } = await get();
      const c = check(body, 'carrier:+2348030005555');
      // Not knowing is not the same as working. Treating a failed check as
      // success is how this report came to claim a call would be answered on
      // an account with no numbers.
      expect(c.state).toBe('degraded');
      expect(c.detail).toMatch(/Could not ask Twilio/);
    });

    it('is READY only when Twilio says the number is here', async () => {
      await workingLine();
      fullyConfiguredEnv();
      carrier({ voiceUrl: 'https://api.readiness.example/api/telephony/inbound/twilio' });

      const { body } = await get();
      expect(check(body, 'carrier:+2348030005555').state).toBe('ready');
      // Nothing is left reduced: this is the only configuration in which the
      // report may say a call will connect and be answered.
      expect(body.state).toBe('ready');
    });
  });

  // The deployment's configuration is not the agency's business: an agency
  // owner sees every check in the same state, in plain words, with no server
  // variable names, internal URLs or log event names.
  it('gives an agency owner the same states without the platform internals', async () => {
    process.env.API_BASE_URL = 'http://localhost:4000';
    delete process.env.ELEVENLABS_API_KEY;
    const operator = (await get(operatorToken)).body;
    const owner = (await get(ownerToken)).body;
    expect(owner.state).toBe(operator.state);
    expect(owner.checks.map((c: any) => [c.id, c.state])).toEqual(operator.checks.map((c: any) => [c.id, c.state]));
    const platform = owner.checks.filter((c: any) => ['api_base_url', 'tts', 'stt', 'synthesis', 'engine', 'deployment_carrier'].includes(c.id));
    expect(JSON.stringify(platform)).not.toMatch(/[A-Z]{3,}_[A-Z_]{3,}|localhost|TwiML/);
    expect(owner.note).toBeUndefined();
    expect(JSON.stringify(operator)).toMatch(/API_BASE_URL|ELEVENLABS_API_KEY/);
  });
});
