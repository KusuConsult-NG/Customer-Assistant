/**
 * Who may destroy a citizen's record.
 *
 * `CrmController` carried class-level `@UseGuards(JwtAuthGuard)` and NO role
 * metadata at all — 23 routes, zero `@Roles`. So any signed-in member of an
 * agency, including a VIEWER, could delete a citizen's contact record and
 * every lead, deal and ticket hanging off it, approve an enrollment, or export
 * the agency's entire contact list.
 *
 * This is the third controller in this codebase found in that state, after the
 * FAQ and WhatsApp ones. The pattern is the same each time: the guard is
 * applied, the decorators are not, and nothing fails — because `RolesGuard`
 * reads metadata that is simply absent.
 *
 * ── Where the line is drawn, and why ────────────────────────────────────────
 *
 * Reading a record, logging a call, raising a ticket and moving a case along
 * stay open to every member. They are an agent's job, and routing them through
 * an admin means the citizen waits for one — these tests assert that half too,
 * because a guard that refused everyone would satisfy every refusal below and
 * still be broken.
 *
 * Restricted is the set an agent has no reason to do and cannot undo: the four
 * DELETEs, the enrollment approval, and the bulk export — which is a different
 * act from reading one citizen's file.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('CRM authorization', () => {
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

    agency = await createTenant(app, 'crm-agency', { role: 'OWNER' });
    other = await createTenant(app, 'crm-other', { role: 'OWNER' });
  });

  afterAll(async () => {
    await dropTenant(agency?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  /** A colleague in the SAME agency, so a refusal is about role not tenancy. */
  const memberToken = async (role: 'AGENT' | 'VIEWER' | 'ADMIN') => {
    const user = await prisma.user.create({
      data: {
        organizationId: agency.orgId,
        email: `crm-${role.toLowerCase()}-${randomBytes(3).toString('hex')}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: `CRM ${role}`,
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
    patch: (p: string) => request(app.getHttpServer()).patch(p).set('Authorization', `Bearer ${token}`),
    del: (p: string) => request(app.getHttpServer()).delete(p).set('Authorization', `Bearer ${token}`),
  });

  const newContact = (orgId = agency.orgId) =>
    prisma.contact.create({
      data: {
        organizationId: orgId,
        phoneNumber: `+2348${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 9)}`.slice(0, 14),
        fullName: `Citizen ${randomBytes(2).toString('hex')}`,
      },
    });

  const newTicket = async (contactId: string) =>
    prisma.ticket.create({
      data: {
        organizationId: agency.orgId,
        contactId,
        ticketNumber: `CRM-${randomBytes(3).toString('hex')}`,
        subject: 'Street lighting',
        description: 'No lighting on the main road.',
        status: 'OPEN',
      },
    });

  // ── Destroying a citizen's record ─────────────────────────────────────────

  describe('deletions', () => {
    it.each(['AGENT', 'VIEWER'] as const)('refuses every delete for role %s', async (role) => {
      const token = await memberToken(role);
      const contact = await newContact();
      const ticket = await newTicket(contact.id);
      const lead = await prisma.lead.create({
        data: { organizationId: agency.orgId, contactId: contact.id, source: 'WHATSAPP' },
      });
      const deal = await prisma.deal.create({
        data: { organizationId: agency.orgId, contactId: contact.id, title: 'Permit', amount: 1000 },
      });

      await as(token).del(`/api/crm/tickets/${ticket.id}`).expect(403);
      await as(token).del(`/api/crm/leads/${lead.id}`).expect(403);
      await as(token).del(`/api/crm/deals/${deal.id}`).expect(403);
      await as(token).del(`/api/crm/contacts/${contact.id}`).expect(403);

      // A 403 that deleted the row anyway would be worse than no guard.
      expect(await prisma.contact.findUnique({ where: { id: contact.id } })).not.toBeNull();
      expect(await prisma.ticket.findUnique({ where: { id: ticket.id } })).not.toBeNull();
      expect(await prisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
      expect(await prisma.deal.findUnique({ where: { id: deal.id } })).not.toBeNull();
    });

    it('lets an ADMIN delete, so the guard is a role check and not a lockout', async () => {
      const token = await memberToken('ADMIN');
      const contact = await newContact();

      await as(token).del(`/api/crm/contacts/${contact.id}`).expect(200);
      expect(await prisma.contact.findUnique({ where: { id: contact.id } })).toBeNull();
    });

    it('refuses to delete a citizen who has records, and names what would go', async () => {
      // The most destructive action in the product, and it was one generic
      // "Are you sure you want to delete this record?" away. Every relation on
      // Contact is `onDelete: Cascade`, so deleting a citizen silently takes
      // their appointments, the callbacks promised to them, their open
      // complaints and the entire record of what the agency told them. The
      // audit entry recorded the name and phone number — not that three
      // appointments went with it.
      const token = await memberToken('ADMIN');
      const contact = await newContact();

      const booking = await prisma.booking.create({
        data: {
          organizationId: agency.orgId,
          contactId: contact.id,
          serviceName: 'Land registration',
          startTime: new Date(Date.now() + 3 * 24 * 3600_000),
          endTime: new Date(Date.now() + 3 * 24 * 3600_000 + 1800_000),
          status: 'CONFIRMED',
        },
      });
      const callback = await prisma.callbackRequest.create({
        data: {
          organizationId: agency.orgId,
          contactId: contact.id,
          phoneNumber: contact.phoneNumber,
          reason: 'water supply',
          promisedText: 'Within the hour',
          dueAt: new Date(),
        },
      });

      const res = await as(token).del(`/api/crm/contacts/${contact.id}`).expect(400);
      const message = Array.isArray(res.body.message) ? res.body.message.join(' ') : res.body.message;

      // It says what, and how many, in words an officer can act on.
      expect(message).toMatch(/1 appointment/i);
      expect(message).toMatch(/1 (promised )?callback/i);
      expect(message).toMatch(/acknowledge/i);

      // And nothing was destroyed while it asked.
      expect(await prisma.contact.findUnique({ where: { id: contact.id } })).not.toBeNull();
      expect(await prisma.booking.findUnique({ where: { id: booking.id } })).not.toBeNull();
      expect(await prisma.callbackRequest.findUnique({ where: { id: callback.id } })).not.toBeNull();
    });

    it('deletes once the officer acknowledges what goes with it', async () => {
      const token = await memberToken('ADMIN');
      const contact = await newContact();
      await prisma.callbackRequest.create({
        data: {
          organizationId: agency.orgId,
          contactId: contact.id,
          phoneNumber: contact.phoneNumber,
          reason: 'bin collection',
          promisedText: 'Tomorrow',
          dueAt: new Date(),
        },
      });

      await as(token)
        .del(`/api/crm/contacts/${contact.id}`)
        .send({ acknowledgeDestroysRelatedRecords: true })
        .expect(200);

      expect(await prisma.contact.findUnique({ where: { id: contact.id } })).toBeNull();

      // The audit says WHAT was destroyed, not just who did it — otherwise
      // "what did we lose" has no answer once the rows are gone.
      const entry = await prisma.auditLog.findFirst({
        where: { organizationId: agency.orgId, action: 'agency.contact.deleted' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry).not.toBeNull();
      expect(JSON.stringify(entry!.previousValue)).toMatch(/callbackRequest/i);
    });

    it('still deletes a citizen with nothing attached, without ceremony', async () => {
      // The ordinary case — a duplicate typed in by mistake — must not get
      // harder.
      const token = await memberToken('ADMIN');
      const contact = await newContact();

      await as(token).del(`/api/crm/contacts/${contact.id}`).expect(200);
      expect(await prisma.contact.findUnique({ where: { id: contact.id } })).toBeNull();
    });

    it('still cannot delete another agency’s citizen, even as an OWNER', async () => {
      const theirs = await newContact(other.orgId);

      const res = await as(agency.token).del(`/api/crm/contacts/${theirs.id}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await prisma.contact.findUnique({ where: { id: theirs.id } })).not.toBeNull();
    });
  });

  // ── Approving and exporting ───────────────────────────────────────────────

  describe('approval and bulk export', () => {
    it.each(['AGENT', 'VIEWER'] as const)('refuses the enrollment approval for role %s', async (role) => {
      const token = await memberToken(role);
      const contact = await newContact();

      // Approving an enrollment is a decision about a citizen's entitlement,
      // not a step in handling their call.
      await as(token).post(`/api/crm/contacts/${contact.id}/approve-enrollee`).send({}).expect(403);
    });

    it.each(['AGENT', 'VIEWER'] as const)('refuses the bulk contact export for role %s', async (role) => {
      const token = await memberToken(role);

      // Reading one citizen's file is an agent's job. Taking a copy of every
      // citizen the agency holds is a different act.
      await as(token).get('/api/crm/export/contacts').expect(403);
    });

    it('lets an ADMIN export', async () => {
      const token = await memberToken('ADMIN');
      await as(token).get('/api/crm/export/contacts').expect(200);
    });
  });

  // ── The work an agent must still be able to do ────────────────────────────

  describe('what stays open', () => {
    it.each(['AGENT', 'VIEWER'] as const)('still lets role %s read the CRM', async (role) => {
      const token = await memberToken(role);
      const contact = await newContact();

      await as(token).get('/api/crm/contacts').expect(200);
      await as(token).get('/api/crm/tickets').expect(200);
      await as(token).get('/api/crm/leads').expect(200);
      await as(token).get(`/api/crm/contacts/${contact.id}`).expect(200);
      await as(token).get(`/api/crm/contacts/${contact.id}/timeline`).expect(200);
    });

    it('lets an AGENT log work against a citizen, which is their job', async () => {
      const token = await memberToken('AGENT');
      const contact = await newContact();
      const ticket = await newTicket(contact.id);

      // Raising a ticket, updating a citizen's details and moving a case along
      // are what an agent is for. Routing these through an admin means the
      // citizen waits for one.
      const created = await as(token)
        .post('/api/crm/tickets')
        .send({ contactId: contact.id, subject: 'Refuse collection', description: 'Missed twice.' });
      expect(created.status).toBeLessThan(400);

      const updated = await as(token)
        .patch(`/api/crm/contacts/${contact.id}`)
        .send({ fullName: 'Corrected Name' });
      expect(updated.status).toBeLessThan(400);

      const progressed = await as(token)
        .patch(`/api/crm/tickets/${ticket.id}/status`)
        .send({ status: 'IN_PROGRESS' });
      expect(progressed.status).toBeLessThan(400);
    });

    it('requires authentication throughout', async () => {
      await request(app.getHttpServer()).get('/api/crm/contacts').expect(401);
      await request(app.getHttpServer()).delete('/api/crm/contacts/anything').expect(401);
      await request(app.getHttpServer()).get('/api/crm/export/contacts').expect(401);
    });
  });
});
