/**
 * WhatsApp templates and broadcasts — six routes that had no test at all.
 *
 * They are the highest-consequence untested surface in the API: a broadcast
 * sends a real message to every number it is given, on the agency's own Meta
 * line, to citizens.
 *
 * Three things are pinned here.
 *
 * WHO MAY SEND. Every staff route in this controller carried only
 * `@UseGuards(JwtAuthGuard)` — no RolesGuard, no @Roles — so any signed-in
 * member including a VIEWER could create a template and broadcast to every
 * citizen on the agency's list. Reading stays open, because an officer on a
 * call needs to see what has been sent; sending does not.
 *
 * THAT A FAILED SEND IS NOT REPORTED AS SENT. The service already refuses to
 * claim delivery when WhatsApp is unconfigured — that branch once set
 * `sentCount = recipients.length` for an audience that received nothing — and
 * nothing asserted it.
 *
 * THAT "APPROVED" MEANS META APPROVED IT. `status` defaulted to "APPROVED",
 * so a template Meta had never seen passed the approval gate and the send
 * failed at Meta instead. A status the platform invents is not a status.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('WhatsApp templates and broadcasts', () => {
  let app: INestApplication;
  let agency: TestTenant;
  let other: TestTenant;

  jest.setTimeout(90000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    agency = await createTenant(app, 'wa-agency', { role: 'OWNER' });
    other = await createTenant(app, 'wa-other', { role: 'OWNER' });
  });

  afterAll(async () => {
    await dropTenant(agency?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  beforeEach(async () => {
    for (const id of [agency.orgId, other.orgId]) {
      await prisma.broadcastCampaign.deleteMany({ where: { organizationId: id } });
      await prisma.whatsAppTemplate.deleteMany({ where: { organizationId: id } });
    }
  });

  /** A colleague inside the SAME agency, so a refusal is about role not tenancy. */
  const memberToken = async (role: 'AGENT' | 'VIEWER' | 'ADMIN') => {
    const user = await prisma.user.create({
      data: {
        organizationId: agency.orgId,
        email: `wa-${role.toLowerCase()}-${randomBytes(3).toString('hex')}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: `WhatsApp ${role}`,
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
    del: (p: string) => request(app.getHttpServer()).delete(p).set('Authorization', `Bearer ${token}`),
  });

  const owner = () => as(agency.token);

  const seedTemplate = (orgId = agency.orgId, over: Record<string, unknown> = {}) =>
    prisma.whatsAppTemplate.create({
      data: {
        organizationId: orgId,
        name: `tpl_${randomBytes(3).toString('hex')}`,
        bodyText: 'Your appointment is on {{1}}.',
        ...over,
      },
    });

  // ── Templates ─────────────────────────────────────────────────────────────

  describe('templates', () => {
    it('creates and lists one', async () => {
      const created = await owner()
        .post('/api/whatsapp/templates')
        .send({ name: `tpl_${randomBytes(3).toString('hex')}`, bodyText: 'Hello {{1}}' })
        .expect(201);

      const list = await owner().get('/api/whatsapp/templates').expect(200);
      expect(list.body.map((t: any) => t.id)).toContain(created.body.id);
    });

    it('requires a name and a body', async () => {
      await owner().post('/api/whatsapp/templates').send({ name: 'no-body' }).expect(400);
      await owner().post('/api/whatsapp/templates').send({ bodyText: 'no name' }).expect(400);
    });

    it('does not show another agency’s templates', async () => {
      const theirs = await seedTemplate(other.orgId);
      const list = await owner().get('/api/whatsapp/templates').expect(200);
      expect(list.body.map((t: any) => t.id)).not.toContain(theirs.id);
    });

    it('cannot delete another agency’s template', async () => {
      const theirs = await seedTemplate(other.orgId);

      const res = await owner().del(`/api/whatsapp/templates/${theirs.id}`);
      expect(res.status).toBeGreaterThanOrEqual(400);

      // The row survives: a 404 that deleted it anyway would be worse than a 200.
      expect(await prisma.whatsAppTemplate.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    });

    it('does not claim Meta approved a template Meta has never seen', async () => {
      const created = await owner()
        .post('/api/whatsapp/templates')
        .send({ name: `tpl_${randomBytes(3).toString('hex')}`, bodyText: 'Hello {{1}}' })
        .expect(201);

      // Meta approves templates; this platform does not. Creating a row here
      // registers nothing with Meta, and a send against an unsubmitted
      // template is rejected with error 132001. `createTemplate` has always
      // set this correctly — what was stale was the COLUMN DEFAULT, which any
      // other write path would have picked up.
      expect(created.body.status).toBe('PENDING_SUBMISSION');
      expect(created.body.status).not.toBe('APPROVED');
    });

    it('defaults to unsubmitted even when a row is written outside the service', async () => {
      // A seed or a direct insert takes the column default, which was
      // "APPROVED" — so it claimed Meta approval and passed the broadcast
      // gate. The service was never the gap; the default behind it was.
      const direct = await prisma.whatsAppTemplate.create({
        data: {
          organizationId: agency.orgId,
          name: `tpl_${randomBytes(3).toString('hex')}`,
          bodyText: 'Written straight to the table',
        },
      });
      expect(direct.status).not.toBe('APPROVED');
    });
  });

  // ── Broadcasts ────────────────────────────────────────────────────────────

  describe('broadcasts', () => {
    it('refuses a template Meta has not approved, naming the status', async () => {
      const pending = await seedTemplate(agency.orgId, { status: 'PENDING' });

      const res = await owner()
        .post('/api/whatsapp/broadcasts')
        .send({ name: 'Clinic reminder', templateId: pending.id, recipients: ['+2348012345678'] })
        .expect(400);

      expect(res.body.message).toMatch(/not been approved by Meta/i);
      expect(res.body.message).toMatch(/PENDING/);
      // Nothing was recorded as a campaign.
      expect(await prisma.broadcastCampaign.count({ where: { organizationId: agency.orgId } })).toBe(0);
    });

    it('does NOT report a campaign as sent when WhatsApp is not connected', async () => {
      const approved = await seedTemplate(agency.orgId, { status: 'APPROVED' });

      const res = await owner()
        .post('/api/whatsapp/broadcasts')
        .send({
          name: 'Clinic reminder',
          templateId: approved.id,
          recipients: ['+2348012345678', '+2348012345679'],
        })
        .expect(400);

      expect(res.body.message).toMatch(/not connected/i);

      // The campaign row exists and says FAILED with nothing sent. This branch
      // once set sentCount to the full recipient count, reporting a delivered
      // campaign to an audience that received nothing.
      const campaign = await prisma.broadcastCampaign.findFirst({
        where: { organizationId: agency.orgId },
      });
      expect(campaign).not.toBeNull();
      expect(campaign!.status).toBe('FAILED');
      expect(campaign!.sentCount).toBe(0);
      expect(campaign!.failedCount).toBe(2);
    });

    it('requires a name, a template and at least one recipient', async () => {
      const t = await seedTemplate(agency.orgId, { status: 'APPROVED' });
      await owner().post('/api/whatsapp/broadcasts').send({ templateId: t.id, recipients: ['+234801'] }).expect(400);
      await owner().post('/api/whatsapp/broadcasts').send({ name: 'x', recipients: ['+234801'] }).expect(400);
      await owner().post('/api/whatsapp/broadcasts').send({ name: 'x', templateId: t.id, recipients: [] }).expect(400);
    });

    it('cannot broadcast with another agency’s template', async () => {
      const theirs = await seedTemplate(other.orgId, { status: 'APPROVED' });

      await owner()
        .post('/api/whatsapp/broadcasts')
        .send({ name: 'Borrowed', templateId: theirs.id, recipients: ['+2348012345678'] })
        .expect(404);
    });

    it('does not list another agency’s campaigns', async () => {
      const theirs = await seedTemplate(other.orgId, { status: 'APPROVED' });
      const theirCampaign = await prisma.broadcastCampaign.create({
        data: {
          organizationId: other.orgId,
          templateId: theirs.id,
          name: 'Theirs',
          recipients: ['+2348000000000'],
          totalCount: 1,
        },
      });

      const list = await owner().get('/api/whatsapp/broadcasts').expect(200);
      expect(JSON.stringify(list.body)).not.toContain(theirCampaign.id);
    });

    it('the legacy /broadcasts/send path behaves identically', async () => {
      const pending = await seedTemplate(agency.orgId, { status: 'PENDING' });

      // Kept for backwards compatibility, so it must not be the lenient one.
      const res = await owner()
        .post('/api/whatsapp/broadcasts/send')
        .send({ name: 'Legacy', templateId: pending.id, recipients: ['+2348012345678'] })
        .expect(400);
      expect(res.body.message).toMatch(/not been approved by Meta/i);
    });
  });

  // ── Who may send to citizens ──────────────────────────────────────────────

  describe('authorization', () => {
    it.each(['AGENT', 'VIEWER'] as const)('refuses template writes for role %s', async (role) => {
      const token = await memberToken(role);
      const existing = await seedTemplate(agency.orgId);

      await as(token)
        .post('/api/whatsapp/templates')
        .send({ name: 'sneaky', bodyText: 'hello' })
        .expect(403);
      await as(token).del(`/api/whatsapp/templates/${existing.id}`).expect(403);

      expect(await prisma.whatsAppTemplate.findUnique({ where: { id: existing.id } })).not.toBeNull();
    });

    it.each(['AGENT', 'VIEWER'] as const)('refuses broadcasting for role %s', async (role) => {
      const token = await memberToken(role);
      const approved = await seedTemplate(agency.orgId, { status: 'APPROVED' });

      // A VIEWER being able to message every citizen on the agency's list is
      // the sharpest edge of this controller having had no role metadata.
      await as(token)
        .post('/api/whatsapp/broadcasts')
        .send({ name: 'Unauthorised blast', templateId: approved.id, recipients: ['+2348012345678'] })
        .expect(403);
      await as(token)
        .post('/api/whatsapp/broadcasts/send')
        .send({ name: 'Unauthorised blast', templateId: approved.id, recipients: ['+2348012345678'] })
        .expect(403);

      expect(await prisma.broadcastCampaign.count({ where: { organizationId: agency.orgId } })).toBe(0);
    });

    it.each(['AGENT', 'VIEWER'] as const)('still lets role %s read what was sent', async (role) => {
      const token = await memberToken(role);
      await seedTemplate(agency.orgId);

      // An officer on a call needs to know what the agency has already told
      // this citizen. Reading is not the privilege.
      await as(token).get('/api/whatsapp/templates').expect(200);
      await as(token).get('/api/whatsapp/broadcasts').expect(200);
      await as(token).get('/api/whatsapp/conversations').expect(200);
    });

    it('lets an AGENT answer a conversation, which is their job', async () => {
      const token = await memberToken('AGENT');
      const contact = await prisma.contact.create({
        data: {
          organizationId: agency.orgId,
          phoneNumber: `+2348${Date.now().toString().slice(-9)}`,
          fullName: 'Citizen',
        },
      });
      const conversation = await prisma.conversation.create({
        data: { organizationId: agency.orgId, contactId: contact.id, channel: 'WHATSAPP' },
      });

      // Replying and taking a thread over are an agent's work. Restricting
      // those to an admin means the citizen waits for one.
      const reply = await as(token)
        .post(`/api/whatsapp/conversations/${conversation.id}/messages`)
        .send({ content: 'Looking into that for you now.' });
      expect(reply.status).not.toBe(403);

      const handoff = await as(token)
        .post(`/api/whatsapp/conversations/${conversation.id}/handoff`)
        .send({ active: true });
      expect(handoff.status).not.toBe(403);
    });

    it('lets an ADMIN write, so the guard is a role check and not a lockout', async () => {
      const token = await memberToken('ADMIN');

      await as(token)
        .post('/api/whatsapp/templates')
        .send({ name: `tpl_${randomBytes(3).toString('hex')}`, bodyText: 'Admin may write' })
        .expect(201);
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/whatsapp/templates').expect(401);
      await request(app.getHttpServer()).post('/api/whatsapp/broadcasts').send({}).expect(401);
    });
  });
});
