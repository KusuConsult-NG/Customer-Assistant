/**
 * The last routes with no test of their own.
 *
 * Twelve endpoints across five controllers were referenced by nothing. Some
 * have service-level coverage, so what was missing is the ROUTE: its guard,
 * its role check and the shape of what it returns. That distinction matters
 * here — three controllers in this codebase have now been found with a guard
 * applied and no role metadata behind it, and only a route-level test sees
 * that.
 *
 * The properties pinned below are the ones worth a test rather than a
 * checkbox: that a credential write does not echo the credential back, that
 * what lands in the database is ciphertext, that an account-existence probe
 * cannot tell the difference, and that the provisioning and replay routes
 * refuse an agent.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('the remaining untested routes', () => {
  let app: INestApplication;
  let agency: TestTenant;
  let other: TestTenant;

  jest.setTimeout(90000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString('base64');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    agency = await createTenant(app, 'rest-agency', { role: 'OWNER' });
    other = await createTenant(app, 'rest-other', { role: 'OWNER' });
  });

  afterAll(async () => {
    await dropTenant(agency?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  const memberToken = async (role: 'AGENT' | 'VIEWER' | 'ADMIN') => {
    const user = await prisma.user.create({
      data: {
        organizationId: agency.orgId,
        email: `rest-${role.toLowerCase()}-${randomBytes(3).toString('hex')}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: `Rest ${role}`,
        role,
      },
    });
    return app.get(JwtService).sign({
      userId: user.id,
      organizationId: agency.orgId,
      email: user.email,
      fullName: user.fullName,
      role,
      tokenVersion: user.tokenVersion,
    });
  };

  const as = (token: string) => ({
    get: (p: string) => request(app.getHttpServer()).get(p).set('Authorization', `Bearer ${token}`),
    post: (p: string) => request(app.getHttpServer()).post(p).set('Authorization', `Bearer ${token}`),
  });
  const owner = () => as(agency.token);

  // ── Credential writes must not hand the credential back ───────────────────

  describe('provider credential writes', () => {
    it('does not echo a WhatsApp access token back in the response', async () => {
      const accessToken = `EAA${randomBytes(16).toString('hex')}`;
      const verifyToken = `vt_${randomBytes(8).toString('hex')}`;

      const res = await owner()
        .post('/api/organizations/whatsapp-config')
        .send({
          phoneNumberId: '1234567890',
          accessToken,
          webhookVerifyToken: verifyToken,
        })
        .expect(201);

      // Before encryption this path returned the stored row, so it echoed the
      // tenant's own access token straight back in the response body.
      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain(accessToken);
      expect(serialized).not.toContain(verifyToken);
    });

    it('stores the WhatsApp token as ciphertext, not plaintext', async () => {
      const accessToken = `EAA${randomBytes(16).toString('hex')}`;

      await owner()
        .post('/api/organizations/whatsapp-config')
        .send({ phoneNumberId: '1234567890', accessToken, webhookVerifyToken: 'vt_abc' })
        .expect(201);

      const row = await prisma.whatsAppConfig.findFirst({
        where: { organizationId: agency.orgId },
      });
      // `v1.<iv>.<tag>.<ciphertext>`. A plaintext token here is a system
      // reporting encryption at rest while having none.
      expect(row?.accessToken).toMatch(/^v1\./);
      expect(row?.accessToken).not.toContain(accessToken);
    });

    it('does not echo a Twilio auth token back, and stores it encrypted', async () => {
      const authToken = `tw_${randomBytes(16).toString('hex')}`;

      const res = await owner()
        .post('/api/organizations/telephony-config')
        .send({
          provider: 'TWILIO',
          phoneNumber: `+2348${String(Date.now()).slice(-9)}`,
          accountSid: 'AC_rest_test',
          authToken,
        })
        .expect(201);

      expect(JSON.stringify(res.body)).not.toContain(authToken);

      const row = await prisma.telephonyConfig.findFirst({
        where: { organizationId: agency.orgId, provider: 'TWILIO' },
      });
      expect(row?.authToken).toMatch(/^v1\./);
    });

    it.each(['AGENT', 'VIEWER'] as const)('refuses a credential write for role %s', async (role) => {
      const token = await memberToken(role);

      // A carrier or Meta credential decides who answers the agency's
      // citizens. It is not an agent's to change.
      await as(token)
        .post('/api/organizations/whatsapp-config')
        .send({ phoneNumberId: '1', accessToken: 'x', webhookVerifyToken: 'y' })
        .expect(403);
      await as(token)
        .post('/api/organizations/telephony-config')
        .send({ provider: 'TWILIO', phoneNumber: '+2348000000000' })
        .expect(403);
    });
  });

  // ── The permissions matrix ────────────────────────────────────────────────

  describe('the role permissions matrix', () => {
    it.each(['AGENT', 'VIEWER'] as const)('is readable by role %s', async (role) => {
      const token = await memberToken(role);

      // It describes what each role may do. Hiding it from the roles it
      // describes serves nobody.
      const res = await as(token).get('/api/organizations/roles/permissions').expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThan(0);
    });
  });

  // ── Hosted-agent provisioning is not an agent's to run ───────────────────

  describe('agent provisioning routes', () => {
    it.each(['AGENT', 'VIEWER'] as const)('refuses provisioning for role %s', async (role) => {
      const token = await memberToken(role);

      // Syncing pushes this platform's prompt and tools to the agent that
      // answers citizens; attaching moves a WhatsApp line onto it. The route
      // guards are what these assert — the services have their own tests.
      await as(token).post('/api/agent-provisioning/sync').send({}).expect(403);
      await as(token)
        .post('/api/agent-provisioning/whatsapp/attach')
        .send({ phoneNumberId: 'wa_1' })
        .expect(403);
      await as(token).post('/api/agent-provisioning/whatsapp/detach').send({}).expect(403);
    });
  });

  // ── Replaying a workflow run ──────────────────────────────────────────────

  describe('workflow replay', () => {
    it.each(['AGENT', 'VIEWER'] as const)('refuses a replay for role %s', async (role) => {
      const token = await memberToken(role);

      // A replay re-executes real actions — messages, tickets, bookings.
      await as(token).post('/api/workflows/runs/some-run-id/replay').send({}).expect(403);
    });

    it('will not replay another agency’s run', async () => {
      const workflow = await prisma.workflow.create({
        data: {
          organizationId: other.orgId,
          name: 'Theirs',
          nodes: [] as any,
          edges: [] as any,
        },
      });
      const run = await prisma.workflowRun.create({
        data: {
          organizationId: other.orgId,
          workflowId: workflow.id,
          status: 'SUCCEEDED',
          triggerType: 'WHATSAPP_INBOUND',
          payload: {} as any,
        },
      });

      const res = await owner().post(`/api/workflows/runs/${run.id}/replay`).send({});
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).not.toBe(403); // an OWNER has the role; the tenancy is the refusal
    });
  });

  // ── Account-existence probing ─────────────────────────────────────────────

  describe('resending a verification email', () => {
    it('answers identically whether or not the account exists', async () => {
      const known = await request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .send({ email: agency.email })
        .expect(201);

      const unknown = await request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .send({ email: `nobody-${randomBytes(6).toString('hex')}@nowhere.test` })
        .expect(201);

      // Differing responses turn this into an account-existence oracle for
      // anyone with a list of email addresses.
      expect(known.body).toEqual(unknown.body);
      expect(known.body.message).toMatch(/if an account exists/i);
    });
  });

  // ── A citizen's digital card ──────────────────────────────────────────────

  describe('the digital card', () => {
    it('will not issue a card for another agency’s citizen', async () => {
      const theirs = await prisma.contact.create({
        data: {
          organizationId: other.orgId,
          phoneNumber: `+2347${String(Date.now()).slice(-9)}`,
          fullName: 'Their Citizen',
        },
      });

      const res = await owner().get(`/api/crm/contacts/${theirs.id}/digital-card`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toContain('Their Citizen');
    });
  });
});

