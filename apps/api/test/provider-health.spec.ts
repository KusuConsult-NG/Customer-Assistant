/**
 * Whether each provider ANSWERS, rather than whether a variable is set.
 *
 * Every readiness surface in this codebase reported a provider as working
 * because its key was non-empty. A key that is revoked, mistyped, out of
 * credit, or belongs to a different account looks identical — every screen is
 * green and the first thing that discovers the truth is a citizen on the
 * phone. That exact failure already happened on the carrier: a valid Twilio
 * SID and token beside a number from a different account, with the voice
 * report saying "A call will connect and be answered".
 *
 * So the assertions here are about the three states and the honesty of each:
 * a refusal is reported verbatim, an unreachable provider is a failure and not
 * a pass, "not configured" is distinct from "broken", and no credential value
 * ever appears in a response.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma, encryptSecret } from '@ace/database';
import { createTestApp } from './support/create-test-app';

describe('provider health', () => {
  let app: INestApplication;
  let orgId: string;
  let ownerToken: string;
  let agentToken: string;

  jest.setTimeout(60000);

  const DEEPGRAM = 'dg_live_key_000000000000';
  const ELEVEN = 'el_live_key_000000000000';
  const OPENAI = 'sk_live_key_000000000000';
  const RESEND = 're_live_key_000000000000';
  const SUPABASE = 'sb_service_role_000000000';
  const META = 'EAAmeta_token_0000000000';

  const saved: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };

  let realFetch: typeof globalThis.fetch;
  let seen: string[] = [];

  /**
   * Answers per host. The default is the happy path; `refuse` and `down` set
   * what one named provider does, so each test changes exactly one thing.
   */
  const providersRespond = (opts: { refuse?: string; down?: string; buckets?: any } = {}) => {
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      seen.push(url);
      const host = new URL(url).host;
      if (opts.down && host.includes(opts.down)) throw new Error('ECONNREFUSED');
      if (opts.refuse && host.includes(opts.refuse)) {
        return new Response('{"error":"invalid api key"}', { status: 401 });
      }
      if (url.includes('/storage/v1/bucket')) {
        return new Response(
          JSON.stringify(
            opts.buckets ?? [
              { name: 'knowledge-documents', public: false },
              { name: 'onboarding-selfies', public: false },
            ]
          ),
          { status: 200 }
        );
      }
      return new Response('{"ok":true}', { status: 200 });
    }) as any;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    realFetch = globalThis.fetch;

    app = await createTestApp();

    const org = await prisma.organization.create({
      data: { name: 'Provider Agency', slug: `prov-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;

    const mk = async (role: 'OWNER' | 'AGENT') => {
      const email = `prov.${role.toLowerCase()}.${randomBytes(4).toString('hex')}@prov.test`;
      const password = 'ProviderPassw0rd!';
      await prisma.user.create({
        data: {
          organizationId: orgId, email, fullName: `${role}`, role,
          passwordHash: await bcrypt.hash(password, 10), emailVerifiedAt: new Date(),
        },
      });
      const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
      return res.body.accessToken as string;
    };
    ownerToken = await mk('OWNER');
    agentToken = await mk('AGENT');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  beforeEach(async () => {
    seen = [];
    setEnv('DEEPGRAM_API_KEY', DEEPGRAM);
    setEnv('ELEVENLABS_API_KEY', ELEVEN);
    setEnv('OPENAI_API_KEY', OPENAI);
    setEnv('RESEND_API_KEY', RESEND);
    // Exactly one provider, so which one answers is not left to resolution
    // order inside a test about something else.
    setEnv('EMAIL_PROVIDER', 'resend');
    setEnv('EMAIL_FROM', undefined);
    setEnv('BREVO_API_KEY', undefined);
    setEnv('SENDGRID_API_KEY', undefined);
    setEnv('POSTMARK_SERVER_TOKEN', undefined);
    setEnv('MAILGUN_API_KEY', undefined);
    setEnv('SUPABASE_URL', 'https://proj.supabase.co');
    setEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE);
    setEnv('QDRANT_URL', 'https://qdrant.example');
    setEnv('QDRANT_API_KEY', undefined);
    setEnv('WHATSAPP_ACCESS_TOKEN', undefined);
    setEnv('WHATSAPP_PHONE_NUMBER_ID', undefined);
    setEnv('WHATSAPP_BUSINESS_ID', undefined);
    setEnv('LLM_BASE_URL', undefined);
    setEnv('ELEVENLABS_BASE_URL', undefined);
    providersRespond();
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const get = (token = ownerToken) =>
    request(app.getHttpServer()).get('/api/diagnostics/providers').set('Authorization', `Bearer ${token}`);

  const find = (body: any, id: string) => body.providers.find((p: any) => p.id === id);

  it('is OWNER/ADMIN only', async () => {
    expect((await get(agentToken)).status).toBe(403);
    expect((await get(ownerToken)).status).toBe(200);
  });

  it('actually asks every provider', async () => {
    await get();
    // The whole point: outbound requests, not environment reads.
    expect(seen.some((u) => u.includes('api.deepgram.com'))).toBe(true);
    expect(seen.some((u) => u.includes('api.elevenlabs.io'))).toBe(true);
    expect(seen.some((u) => u.includes('api.openai.com'))).toBe(true);
    expect(seen.some((u) => u.includes('qdrant.example'))).toBe(true);
    expect(seen.some((u) => u.includes('supabase.co'))).toBe(true);
    expect(seen.some((u) => u.includes('api.resend.com'))).toBe(true);
  });

  it('reports ok when every provider accepts its credential', async () => {
    const { body } = await get();
    for (const id of ['deepgram', 'elevenlabs', 'openai', 'qdrant', 'supabase-storage', 'email']) {
      expect(find(body, id).state).toBe('ok');
    }
    // WhatsApp is genuinely not configured here, and that is not a fault.
    expect(find(body, 'whatsapp').state).toBe('not_configured');
    expect(body.summary).toMatch(/not configured/i);
  });

  it('reports a REFUSED key as failed, quoting the provider', async () => {
    providersRespond({ refuse: 'api.deepgram.com' });
    const { body } = await get();
    const dg = find(body, 'deepgram');
    // A present-but-revoked key was indistinguishable from a working one, and
    // this is the case that proves it no longer is.
    expect(dg.state).toBe('failed');
    expect(dg.detail).toMatch(/HTTP 401/);
    expect(dg.detail).toMatch(/invalid api key/);
    expect(body.summary).toMatch(/refusal/i);
  });

  it('reports an UNREACHABLE provider as failed, not as working', async () => {
    providersRespond({ down: 'api.openai.com' });
    const { body } = await get();
    const openai = find(body, 'openai');
    expect(openai.state).toBe('failed');
    expect(openai.detail).toMatch(/Could not reach OpenAI/);
    // And says what it costs, because an unreachable LLM is degraded service
    // rather than a dead platform.
    expect(openai.consequence).toMatch(/falls back to a fixed reply/);
  });

  it('separates NOT CONFIGURED from broken', async () => {
    // Every provider cleared, not just Resend: the check is provider-agnostic
    // now, so leaving a second key set would make it report that one as ready
    // and the test would prove nothing.
    setEnv('RESEND_API_KEY', undefined);
    setEnv('BREVO_API_KEY', undefined);
    setEnv('SENDGRID_API_KEY', undefined);
    setEnv('POSTMARK_SERVER_TOKEN', undefined);
    setEnv('MAILGUN_API_KEY', undefined);
    setEnv('EMAIL_PROVIDER', undefined);

    const { body } = await get();
    const email = find(body, 'email');
    expect(email.state).toBe('not_configured');
    // It names every variable that WOULD configure one, rather than one
    // vendor — the point of the change is that the choice is open.
    expect(email.detail).toMatch(/RESEND_API_KEY/);
    expect(email.detail).toMatch(/BREVO_API_KEY/);
    // Absent is not a failure — but what it costs is stated, because every
    // route back into a staff account is an email.
    expect(email.consequence).toMatch(/invitation|password reset/i);
    expect(seen.some((u) => u.includes('api.resend.com'))).toBe(false);
  });

  it('calls a PUBLIC selfie bucket a failure', async () => {
    providersRespond({
      buckets: [
        { name: 'knowledge-documents', public: false },
        { name: 'onboarding-selfies', public: true },
      ],
    });
    const { body } = await get();
    const storage = find(body, 'supabase-storage');
    // Citizens' faces on an open URL. Reported, and deliberately not changed:
    // objects are already in it.
    expect(storage.state).toBe('failed');
    expect(storage.detail).toMatch(/PUBLIC bucket/);
    expect(storage.consequence).toMatch(/world-readable/);
  });

  it('names a bucket that does not exist', async () => {
    providersRespond({ buckets: [{ name: 'knowledge-documents', public: false }] });
    const { body } = await get();
    const storage = find(body, 'supabase-storage');
    expect(storage.state).toBe('failed');
    expect(storage.detail).toMatch(/onboarding-selfies/);
    expect(storage.detail).toMatch(/storage:buckets/);
  });

  it("checks the tenant's own ElevenLabs key when it has one", async () => {
    await prisma.hostedAgentConfig.create({
      data: { organizationId: orgId, apiKey: encryptSecret('el_tenant_key_11111111') },
    });
    const { body } = await get();
    // A tenant with its own workspace does not use the shared key, so proving
    // the shared one proves nothing about that tenant's calls.
    expect(find(body, 'elevenlabs').detail).toMatch(/own workspace key/);
  });

  it('checks each WhatsApp line with its own stored token', async () => {
    await prisma.whatsAppConfig.create({
      data: {
        organizationId: orgId, phoneNumberId: 'pnid_live', whatsappBusinessId: 'waba_live',
        accessToken: encryptSecret(META), displayPhoneNumber: '+234 803 000 1111',
        webhookVerifyToken: encryptSecret('verify'), isActive: true,
      },
    });
    const { body } = await get();
    expect(find(body, 'whatsapp').state).toBe('ok');
    expect(seen.some((u) => u.includes('graph.facebook.com/v21.0/pnid_live'))).toBe(true);
  });

  it('reports an expired Meta token as failed, naming the line', async () => {
    await prisma.whatsAppConfig.create({
      data: {
        organizationId: orgId, phoneNumberId: 'pnid_expired', whatsappBusinessId: 'waba_live',
        accessToken: encryptSecret(META), displayPhoneNumber: '+234 803 000 2222',
        webhookVerifyToken: encryptSecret('verify'), isActive: true,
      },
    });
    providersRespond({ refuse: 'graph.facebook.com' });
    const { body } = await get();
    const wa = find(body, 'whatsapp');
    // The usual cause of a line the dashboard shows as connected that answers
    // nobody.
    expect(wa.state).toBe('failed');
    expect(wa.detail).toMatch(/\+234 803 000 2222/);
    expect(wa.detail).toMatch(/refused/);
  });

  it('never returns a credential value', async () => {
    await prisma.hostedAgentConfig.create({
      data: { organizationId: orgId, apiKey: encryptSecret('el_tenant_key_11111111') },
    });
    await prisma.whatsAppConfig.create({
      data: {
        organizationId: orgId, phoneNumberId: 'pnid_live', whatsappBusinessId: 'waba_live',
        accessToken: encryptSecret(META), displayPhoneNumber: '+234 803 000 1111',
        webhookVerifyToken: encryptSecret('verify'), isActive: true,
      },
    });

    const raw = JSON.stringify((await get()).body);
    for (const secret of [DEEPGRAM, ELEVEN, OPENAI, RESEND, SUPABASE, META, 'el_tenant_key_11111111']) {
      expect(raw).not.toContain(secret);
    }
    // Nor a ciphertext, which would be just as wrong and less obvious.
    expect(raw).not.toContain('v1.');
  });
  /**
   * A deployment-level Meta token makes NO agency reachable.
   *
   * `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` and
   * `WHATSAPP_BUSINESS_ID` are declared in render.yaml and read nowhere:
   * sending uses the agency's own stored row, and inbound is resolved by
   * Meta's `phoneNumberId` against that same table. So all three can be set,
   * visibly, while every message a citizen sends logs "no config found" — and
   * the operator has no reason to look past a dashboard that shows them set.
   */
  it('says a deployment-level Meta token does not connect any agency', async () => {
    setEnv('WHATSAPP_ACCESS_TOKEN', META);
    setEnv('WHATSAPP_PHONE_NUMBER_ID', '1319842031202307');
    setEnv('WHATSAPP_BUSINESS_ID', '1568175338085648');

    const check = find((await get()).body, 'whatsapp');
    expect(check.state).toBe('not_configured');
    // Where a line IS stored, so the reader is not left to find out.
    expect(check.detail).toContain('/api/organizations/whatsapp-config');
    expect(check.detail).toMatch(/nothing reads them/i);
    expect(check.detail).toContain('WHATSAPP_ACCESS_TOKEN');
    // Never the token itself, which is the whole point of reporting by name.
    expect(JSON.stringify((await get()).body)).not.toContain(META);
  });

  it('does not invent that warning when the deployment sets nothing', async () => {
    setEnv('WHATSAPP_ACCESS_TOKEN', undefined);
    setEnv('WHATSAPP_PHONE_NUMBER_ID', undefined);
    setEnv('WHATSAPP_BUSINESS_ID', undefined);

    const check = find((await get()).body, 'whatsapp');
    expect(check.state).toBe('not_configured');
    expect(check.detail).toContain('/api/organizations/whatsapp-config');
    expect(check.detail).not.toMatch(/nothing reads/i);
  });

  /**
   * Brevo takes a key AND a sender, and the two fail separately.
   *
   * `/v3/account` accepts any valid key, so a probe that stopped there
   * reported "Brevo accepted the credential" on an account that refuses every
   * send because EMAIL_FROM is not one of its verified senders. The cost is
   * identical to a bad key — no invitation, no verification, no password reset
   * — so it is reported as a BLOCKER, not as a note beside a green row.
   */
  describe('Brevo, where the key and the sender fail separately', () => {
    const BREVO = 'xkeysib_live_000000000000';

    /** Default: key accepted, and `senders` holds whatever is passed. */
    const brevoRespond = (senders: any) => {
      globalThis.fetch = (async (input: any) => {
        const url = String(input);
        seen.push(url);
        if (url === 'https://api.brevo.com/v3/senders') {
          if (senders === 'refused') return new Response('{"code":"unauthorized"}', { status: 403 });
          if (senders === 'threw') throw new Error('ECONNRESET');
          if (senders === 'odd-shape') return new Response('{"unexpected":true}', { status: 200 });
          return new Response(JSON.stringify({ senders }), { status: 200 });
        }
        if (url.includes('/storage/v1/bucket')) {
          return new Response(
            JSON.stringify([
              { name: 'knowledge-documents', public: false },
              { name: 'onboarding-selfies', public: false },
            ]),
            { status: 200 }
          );
        }
        return new Response('{"ok":true}', { status: 200 });
      }) as any;
    };

    beforeEach(() => {
      setEnv('RESEND_API_KEY', undefined);
      setEnv('BREVO_API_KEY', BREVO);
      setEnv('EMAIL_PROVIDER', 'brevo');
      setEnv('EMAIL_FROM', 'Care <noreply@plateaustate.gov.ng>');
    });

    it('asks Brevo whether it will accept the address we send FROM', async () => {
      brevoRespond([{ email: 'noreply@plateaustate.gov.ng', active: true }]);
      const res = await get();
      expect(seen).toContain('https://api.brevo.com/v3/account');
      expect(seen).toContain('https://api.brevo.com/v3/senders');
      expect(find(res.body, 'email').state).toBe('ok');
    });

    it('is a FAILURE when EMAIL_FROM is not a sender on the account', async () => {
      brevoRespond([{ email: 'someone.else@example.org', active: true }]);
      const check = find((await get()).body, 'email');
      // Not `ok`: the key works and no invitation can be delivered.
      expect(check.state).toBe('failed');
      expect(check.detail).toContain('noreply@plateaustate.gov.ng');
      expect(check.detail).toMatch(/not a sender on this account/i);
      // The account has just answered, so what it DOES hold is the answer
      // rather than a dead end.
      expect(check.detail).toContain('someone.else@example.org');
    });

    it('is a FAILURE when the sender exists but is not verified yet', async () => {
      brevoRespond([{ email: 'noreply@plateaustate.gov.ng', active: false }]);
      const check = find((await get()).body, 'email');
      expect(check.state).toBe('failed');
      expect(check.detail).toMatch(/not verified yet/i);
    });

    it('says the account holds NO senders rather than naming none', async () => {
      brevoRespond([]);
      expect(find((await get()).body, 'email').detail).toMatch(/holds none/i);
    });

    for (const [label, senders] of [
      ['the senders list is refused', 'refused'],
      ['the request fails outright', 'threw'],
      ['the body is not the documented shape', 'odd-shape'],
    ] as const) {
      it(`gives NO verdict when ${label}`, async () => {
        brevoRespond(senders);
        const check = find((await get()).body, 'email');
        // "Could not check" must not become "broken": a restricted key can be
        // refused at /v3/senders and send perfectly well, and inventing a
        // blocker is how the real ones stop being read.
        expect(check.state).toBe('ok');
        expect(check.detail).toMatch(/accepted the credential/i);
      });
    }

    it('never returns the Brevo key', async () => {
      brevoRespond([{ email: 'someone.else@example.org', active: true }]);
      expect(JSON.stringify((await get()).body)).not.toContain(BREVO);
    });
  });
});
