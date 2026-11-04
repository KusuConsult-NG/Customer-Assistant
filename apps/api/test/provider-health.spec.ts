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
    setEnv('SUPABASE_URL', 'https://proj.supabase.co');
    setEnv('SUPABASE_SERVICE_ROLE_KEY', SUPABASE);
    setEnv('QDRANT_URL', 'https://qdrant.example');
    setEnv('QDRANT_API_KEY', undefined);
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
    for (const id of ['deepgram', 'elevenlabs', 'openai', 'qdrant', 'supabase-storage', 'resend']) {
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
    setEnv('RESEND_API_KEY', undefined);
    const { body } = await get();
    const resend = find(body, 'resend');
    expect(resend.state).toBe('not_configured');
    expect(resend.detail).toMatch(/not set/);
    // Absent is not a failure — but what it costs is stated, because every
    // route back into a staff account is an email.
    expect(resend.consequence).toMatch(/invitation|password reset/i);
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
});
