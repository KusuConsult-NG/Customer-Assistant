/**
 * The ElevenLabs workspace boundary.
 *
 * An ElevenLabs workspace has no tenancy of its own. The agents in it, the
 * phone numbers, the WhatsApp lines and every conversation transcript belong to
 * whoever holds the key — so a platform that puts all its tenants behind one
 * shared key has put all of their customers' conversations in one bucket, kept
 * apart only by our own filtering code being right at every listing endpoint
 * anyone ever adds.
 *
 * This suite is about the two halves of moving a tenant into its own workspace,
 * and about the states in between, which are the ones that bite:
 *
 *   OUTBOUND — a tenant with no key of its own is REFUSED rather than quietly
 *   dropped into the shared workspace. The refusal is the security control; the
 *   ELEVENLABS_ALLOW_SHARED_WORKSPACE opt-in exists for deployments that really
 *   do serve one tenant.
 *
 *   INBOUND — a workspace signs its post-call deliveries with its own secret, so
 *   one environment variable cannot verify them all. Each dedicated tenant has
 *   its own secret and its own URL, and a valid signature proves only WHO SENT a
 *   delivery, never who it may be filed against.
 *
 * That last distinction is the one worth stating twice, because it is the one
 * that reads as pedantic right up until it isn't: these endpoints write call
 * transcripts and callers' phone numbers into a CRM on the strength of an
 * `agent_id` in the body. Verifying the sender is not the same as verifying the
 * subject.
 */

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma, encryptSecret } from '@ace/database';
import { AppModule } from '../src/app.module';
import { ElevenLabsAgentService } from '../src/agent-tools/elevenlabs-agent.service';
import { ElevenLabsApi } from '../src/agent-tools/elevenlabs-client';
import {
  sharedWorkspaceAllowed,
  tenantWebhookPath,
} from '../src/agent-tools/elevenlabs-workspace';
import { signPayload } from '../src/agent-tools/elevenlabs-signature';

describe('the ElevenLabs workspace boundary', () => {
  const realSharedFlag = process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;
  const realSharedKey = process.env.ELEVENLABS_API_KEY;
  const realEnvSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  const realEncryptionKey = process.env.ENCRYPTION_KEY;
  const realBaseUrl = process.env.API_BASE_URL;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  });

  afterAll(() => {
    const restore = (key: string, value: string | undefined) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ELEVENLABS_ALLOW_SHARED_WORKSPACE', realSharedFlag);
    restore('ELEVENLABS_API_KEY', realSharedKey);
    restore('ELEVENLABS_WEBHOOK_SECRET', realEnvSecret);
    restore('ENCRYPTION_KEY', realEncryptionKey);
    restore('API_BASE_URL', realBaseUrl);
  });

  // ── Outbound: whose key does a tenant act with? ─────────────────────────────

  describe('resolving a workspace to act in', () => {
    let api: ElevenLabsApi;
    const orgId = 'org_workspace_resolution';

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ providers: [ElevenLabsApi] }).compile();
      api = moduleRef.get(ElevenLabsApi);
    });

    beforeEach(() => {
      process.env.ELEVENLABS_API_KEY = 'xi-shared-workspace-key';
      delete process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;
    });

    it('refuses a tenant with no key of its own', () => {
      // The whole point. Silently continuing here is the failure being fixed:
      // the tenant would run in a workspace holding everybody else's numbers,
      // WhatsApp lines and transcripts, and nothing would look wrong.
      expect(() => api.workspaceFor(orgId, null)).toThrow(/share a workspace with every other/i);
    });

    it('names both ways out, because an operator will not know the second exists', () => {
      try {
        api.workspaceFor(orgId, null);
        throw new Error('expected a refusal');
      } catch (err: any) {
        expect(err.message).toMatch(/agent-provisioning\/credentials/);
        expect(err.message).toMatch(/ELEVENLABS_ALLOW_SHARED_WORKSPACE/);
        expect(err.message).toContain(orgId);
      }
    });

    it('shares only when a deployment has opted in, and says which mode it is in', () => {
      process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = '1';

      const resolved = api.workspaceFor(orgId, null);
      expect(resolved).toEqual({ apiKey: 'xi-shared-workspace-key', mode: 'shared' });
    });

    it("uses the tenant's own key, decrypted, and never the shared one", () => {
      process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = '1';
      const own = 'sk_this_tenants_own_workspace_key';

      const resolved = api.workspaceFor(orgId, encryptSecret(own));

      // The ciphertext reaching the SDK looks like a revoked credential rather
      // than a decryption bug, and costs hours.
      expect(resolved).toEqual({ apiKey: own, mode: 'dedicated' });
      expect(resolved.apiKey).not.toBe(process.env.ELEVENLABS_API_KEY);
    });

    it('still refuses when there is no shared key to fall back to either', () => {
      delete process.env.ELEVENLABS_API_KEY;
      expect(() => api.workspaceFor(orgId, null)).toThrow(/ELEVENLABS_API_KEY is unset/i);
    });

    /**
     * The opt-in has to be typed, not inferred. A security boundary that changes
     * shape depending on a variable nobody set on purpose is one nobody can
     * reason about — and "TRUE" or "yes" from a deploy dashboard has to mean what
     * the person typing it thought it meant.
     */
    it.each([
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      [' true ', true],
      ['0', false],
      ['false', false],
      ['no', false],
      ['', false],
      ['maybe', false],
    ])('reads ELEVENLABS_ALLOW_SHARED_WORKSPACE=%j as %s', (value, expected) => {
      process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = value as string;
      expect(sharedWorkspaceAllowed()).toBe(expected);
    });

    it('is off when the variable is absent', () => {
      delete process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;
      expect(sharedWorkspaceAllowed()).toBe(false);
    });
  });

  // ── Status: "configured" is not the same as "working" ───────────────────────

  describe('reporting which workspace a tenant is in', () => {
    let service: ElevenLabsAgentService;
    let orgId: string;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [ElevenLabsAgentService, ElevenLabsApi],
      }).compile();
      service = moduleRef.get(ElevenLabsAgentService);

      const org = await prisma.organization.create({
        data: {
          name: 'Workspace Status Ltd',
          slug: `wsstatus-${randomBytes(4).toString('hex')}`,
          industry: 'OTHER',
        },
      });
      orgId = org.id;
      process.env.API_BASE_URL = 'https://api.example.test';
    }, 60_000);

    afterAll(async () => {
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    });

    beforeEach(async () => {
      await prisma.hostedAgentConfig.deleteMany({ where: { organizationId: orgId } });
      process.env.ELEVENLABS_API_KEY = 'xi-shared-workspace-key';
      process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE = '1';
    });

    it('warns that a tenant without its own key is sharing', async () => {
      const status = await service.getWorkspaceKeyStatus(orgId);

      expect(status.mode).toBe('shared');
      expect(status.usingSharedWorkspace).toBe(true);
      expect(status.warnings.join(' ')).toMatch(/shared workspace/i);
    });

    it('warns that a tenant without a key cannot act at all when sharing is off', async () => {
      delete process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE;

      const status = await service.getWorkspaceKeyStatus(orgId);
      expect(status.usingSharedWorkspace).toBe(false);
      expect(status.sharedWorkspaceAllowed).toBe(false);
      expect(status.warnings.join(' ')).toMatch(/will all be refused/i);
    });

    /**
     * The half-migrated state this whole change makes possible, and the reason
     * `warnings` exists at all: a tenant with a key but no webhook secret looks
     * fully configured in every listing and silently loses every transcript.
     */
    it('warns when a dedicated tenant has no webhook secret, and says where to point it', async () => {
      await service.setWorkspaceKey(orgId, 'sk_dedicated_key_abcd');

      const status = await service.getWorkspaceKeyStatus(orgId);
      expect(status.mode).toBe('dedicated');
      expect(status.webhookSecretConfigured).toBe(false);
      expect(status.webhookUrl).toBe(`https://api.example.test${tenantWebhookPath(orgId)}`);
      expect(status.warnings.join(' ')).toContain(status.webhookUrl);
    });

    it('has nothing left to warn about once both halves are set', async () => {
      await service.setWorkspaceKey(orgId, 'sk_dedicated_key_abcd');
      const stored = await service.setWebhookSecret(orgId, 'wsec_dedicated');

      expect(stored.webhookUrl).toBe(`https://api.example.test${tenantWebhookPath(orgId)}`);

      const status = await service.getWorkspaceKeyStatus(orgId);
      expect(status).toMatchObject({
        mode: 'dedicated',
        configured: true,
        webhookSecretConfigured: true,
        encryptedAtRest: true,
        usingSharedWorkspace: false,
        warnings: [],
      });
    });

    it('never stores or returns the webhook secret in a readable form', async () => {
      const secret = 'wsec_dedicated_abcd';
      const result = await service.setWebhookSecret(orgId, secret);

      const config = await prisma.hostedAgentConfig.findUnique({
        where: { organizationId: orgId },
      });
      expect(config!.webhookSecret).not.toContain(secret);
      expect(config!.webhookSecret!.startsWith('v1.')).toBe(true);
      expect(result.fingerprint).toBe('••••abcd');
      expect(JSON.stringify(result)).not.toContain(secret);
    });

    it('refuses to store a webhook secret with no encryption key configured', async () => {
      const key = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      try {
        await expect(service.setWebhookSecret(orgId, 'wsec_x')).rejects.toThrow(
          /ENCRYPTION_KEY is not set/
        );
        const config = await prisma.hostedAgentConfig.findUnique({
          where: { organizationId: orgId },
        });
        // Storing it in the clear "for now" is how a system reports encryption
        // at rest while having none.
        expect(config?.webhookSecret ?? null).toBeNull();
      } finally {
        process.env.ENCRYPTION_KEY = key;
      }
    });
  });

  // ── Inbound: whose secret verified this delivery, and whose call is it? ──────

  describe('the per-tenant webhook', () => {
    let app: INestApplication;
    let dedicatedOrgId: string;
    let sharedOrgId: string;

    const DEDICATED_SECRET = 'wsec_tenant_own_workspace';
    const ENV_SECRET = 'wsec_shared_workspace';

    const dedicatedAgent = `agent_${randomBytes(4).toString('hex')}`;
    const sharedAgent = `agent_${randomBytes(4).toString('hex')}`;

    jest.setTimeout(60000);

    const payloadFor = (agentId: string) => ({
      type: 'post_call_transcription',
      data: {
        agent_id: agentId,
        conversation_id: `conv_${randomBytes(4).toString('hex')}`,
        status: 'done',
        transcript: [{ role: 'user', message: 'Hello there.', time_in_call_secs: 0 }],
        metadata: {
          start_time_unix_secs: Math.floor(Date.now() / 1000),
          call_duration_secs: 10,
          phone_call: {
            type: 'twilio',
            direction: 'inbound',
            call_sid: `CA${randomBytes(6).toString('hex')}`,
            agent_number: '+2348000000009',
            external_number: '+2348222222222',
          },
        },
        analysis: { transcript_summary: 'A short call.' },
      },
    });

    // The body travels as a STRING. supertest JSON-stringifies a Buffer, so the
    // wire would carry `{"type":"Buffer","data":[…]}` — not what was signed, and
    // every test below would 403 for a reason unrelated to the code under test.
    const signed = (body: any, secret: string) => {
      const raw = JSON.stringify(body);
      const at = Math.floor(Date.now() / 1000);
      return { raw, header: `t=${at},${signPayload(Buffer.from(raw, 'utf8'), at, secret)}` };
    };

    const post = (path: string, raw: string, header?: string) => {
      const req = request(app.getHttpServer())
        .post(path)
        .set('Content-Type', 'application/json');
      if (header) req.set('ElevenLabs-Signature', header);
      return req.send(raw);
    };

    const settle = () => new Promise((r) => setTimeout(r, 250));

    beforeAll(async () => {
      process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
      process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
      process.env.ELEVENLABS_WEBHOOK_SECRET = ENV_SECRET;

      const moduleFixture = await Test.createTestingModule({ imports: [AppModule] }).compile();
      // rawBody: true mirrors main.ts. Without it every check below lands on the
      // "server misconfiguration" branch instead of the one under test.
      app = moduleFixture.createNestApplication({ rawBody: true });
      await app.init();

      const dedicated = await prisma.organization.create({
        data: {
          name: 'Dedicated Workspace Ltd',
          slug: `wsdedicated-${randomBytes(4).toString('hex')}`,
          industry: 'OTHER',
        },
      });
      dedicatedOrgId = dedicated.id;
      await prisma.hostedAgentConfig.create({
        data: {
          organizationId: dedicatedOrgId,
          agentId: dedicatedAgent,
          apiKey: encryptSecret('sk_dedicated_workspace_key'),
          webhookSecret: encryptSecret(DEDICATED_SECRET),
        },
      });

      const shared = await prisma.organization.create({
        data: {
          name: 'Shared Workspace Ltd',
          slug: `wsshared-${randomBytes(4).toString('hex')}`,
          industry: 'OTHER',
        },
      });
      sharedOrgId = shared.id;
      // No apiKey: this tenant really is in the shared workspace.
      await prisma.hostedAgentConfig.create({
        data: { organizationId: sharedOrgId, agentId: sharedAgent },
      });
    });

    afterAll(async () => {
      await prisma.organization.delete({ where: { id: dedicatedOrgId } }).catch(() => {});
      await prisma.organization.delete({ where: { id: sharedOrgId } }).catch(() => {});
      if (app) await app.close();
    });

    beforeEach(async () => {
      process.env.ELEVENLABS_WEBHOOK_SECRET = ENV_SECRET;
      await prisma.callLog.deleteMany({
        where: { organizationId: { in: [dedicatedOrgId, sharedOrgId] } },
      });
    });

    const callsFor = (organizationId: string) =>
      prisma.callLog.count({ where: { organizationId } });

    it("accepts a delivery signed with the tenant's own secret", async () => {
      const body = payloadFor(dedicatedAgent);
      const { raw, header } = signed(body, DEDICATED_SECRET);

      await post(tenantWebhookPath(dedicatedOrgId), raw, header).expect(200);
      await settle();

      const call = await prisma.callLog.findUnique({
        where: { callSid: body.data.metadata.phone_call.call_sid },
      });
      expect(call?.organizationId).toBe(dedicatedOrgId);
    });

    /**
     * No fallback to the environment secret, and this is the reason per-tenant
     * webhooks exist at all: falling back would verify a tenant's transcripts
     * against the SHARED workspace's secret, which is exactly the cross-workspace
     * confusion being removed.
     */
    it('refuses a delivery signed with the environment secret on a tenant path', async () => {
      const { raw, header } = signed(payloadFor(dedicatedAgent), ENV_SECRET);

      await post(tenantWebhookPath(dedicatedOrgId), raw, header).expect(403);
      await settle();
      expect(await callsFor(dedicatedOrgId)).toBe(0);
    });

    it('answers 500, not 403, for a tenant that has no secret configured', async () => {
      const noSecret = await prisma.organization.create({
        data: {
          name: 'No Secret Ltd',
          slug: `wsnosecret-${randomBytes(4).toString('hex')}`,
          industry: 'OTHER',
        },
      });
      try {
        const { raw, header } = signed(payloadFor(dedicatedAgent), DEDICATED_SECRET);

        // 500 makes ElevenLabs retry, so the transcript is delayed while the
        // configuration is fixed rather than treated as permanently rejected.
        await post(tenantWebhookPath(noSecret.id), raw, header).expect(500);
      } finally {
        await prisma.organization.delete({ where: { id: noSecret.id } }).catch(() => {});
      }
    });

    /**
     * A valid signature proves who SENT the delivery. It says nothing about
     * whose conversation it is, and these endpoints write transcripts and
     * callers' phone numbers into a CRM on the strength of an id in the body.
     */
    it("refuses to file one tenant's conversation under another, even correctly signed", async () => {
      // The dedicated workspace's own secret, genuinely valid — naming an agent
      // that belongs to somebody else.
      const { raw, header } = signed(payloadFor(sharedAgent), DEDICATED_SECRET);

      // 200: the sender is who they claim to be, so there is nothing to retry.
      // The refusal is to ATTRIBUTE, which is a different thing from rejecting.
      await post(tenantWebhookPath(dedicatedOrgId), raw, header).expect(200);
      await settle();

      expect(await callsFor(sharedOrgId)).toBe(0);
      expect(await callsFor(dedicatedOrgId)).toBe(0);
    });

    it('refuses a shared-workspace delivery for a tenant that has moved out of it', async () => {
      const { raw, header } = signed(payloadFor(dedicatedAgent), ENV_SECRET);

      await post('/api/webhooks/elevenlabs', raw, header).expect(200);
      await settle();

      // The shared workspace no longer has this tenant's conversations to send.
      expect(await callsFor(dedicatedOrgId)).toBe(0);
    });

    it('still accepts a shared-workspace delivery for a tenant still in it', async () => {
      const body = payloadFor(sharedAgent);
      const { raw, header } = signed(body, ENV_SECRET);

      await post('/api/webhooks/elevenlabs', raw, header).expect(200);
      await settle();

      const call = await prisma.callLog.findUnique({
        where: { callSid: body.data.metadata.phone_call.call_sid },
      });
      expect(call?.organizationId).toBe(sharedOrgId);
    });
  });
});
