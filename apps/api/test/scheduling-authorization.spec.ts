/**
 * Who may change a citizen's appointment.
 *
 * `SchedulingController` carried `@UseGuards(JwtAuthGuard)` and nothing else,
 * so every route was open to every member. A VIEWER — the lowest-privileged
 * role in the product — could cancel a citizen's clinic appointment, move it to
 * another day, override its status, and raise a refund ticket against it.
 *
 * `getRefundRequests` even documented a protection it did not have: "Only
 * admins and owners should access this in production (enforced by RolesGuard)",
 * on a controller that applied no RolesGuard. A comment asserting a control
 * that is absent is worse than no comment — it is what a reviewer reads instead
 * of the decorator list.
 *
 * AGENT can write here, unlike in CRM and WhatsApp where writes are OWNER/ADMIN.
 * Moving an appointment is routine front-desk work and AGENT is the front-desk
 * role; making an officer escalate to cancel a citizen's Tuesday slot is how
 * agencies end up sharing an admin login.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma } from '@ace/database';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Scheduling authorization', () => {
  let app: INestApplication;
  let owner: TestTenant;
  let agent: TestTenant;
  let viewer: TestTenant;
  let contactId: string;

  jest.setTimeout(90000);

  /** A fresh future booking, so one test's cancel cannot affect another's. */
  const makeBooking = async (offsetHours: number) => {
    const start = new Date(Date.now() + offsetHours * 3600_000);
    const booking = await prisma.booking.create({
      data: {
        organizationId: owner.orgId,
        contactId,
        serviceName: `Fixture ${offsetHours}h`,
        startTime: start,
        endTime: new Date(start.getTime() + 30 * 60_000),
        status: 'CONFIRMED',
      },
    });
    return booking.id;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    owner = await createTenant(app, 'sched-owner', { role: 'OWNER' });

    // Same agency, different roles — the point is the role, not the tenant.
    const agentUser = await prisma.user.create({
      data: {
        organizationId: owner.orgId,
        email: `agent-${owner.orgId.slice(0, 8)}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: 'Front desk',
        role: 'AGENT',
      },
    });
    const viewerUser = await prisma.user.create({
      data: {
        organizationId: owner.orgId,
        email: `viewer-${owner.orgId.slice(0, 8)}@tenant.test`,
        passwordHash: 'not-a-login-path',
        fullName: 'Read only',
        role: 'VIEWER',
      },
    });

    // Signed exactly as `createTenant` does — `userId`, not `sub`, and the
    // user's own `tokenVersion`, because `JwtStrategy.validate` re-reads the
    // row and checks both. A hand-rolled payload is a 401 that looks like an
    // authorization failure.
    const jwt = app.get(JwtService);
    const sign = (u: { id: string; email: string; fullName: string; role: string; tokenVersion: number }) =>
      jwt.sign({
        userId: u.id,
        organizationId: owner.orgId,
        email: u.email,
        fullName: u.fullName,
        role: u.role,
        tokenVersion: u.tokenVersion,
      });
    agent = { orgId: owner.orgId, userId: agentUser.id, email: agentUser.email, token: sign(agentUser as any) };
    viewer = { orgId: owner.orgId, userId: viewerUser.id, email: viewerUser.email, token: sign(viewerUser as any) };

    const contact = await prisma.contact.create({
      data: { organizationId: owner.orgId, fullName: 'Appointment Holder', phoneNumber: '+2348012349001' },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await dropTenant(owner?.orgId);
    await app?.close();
  });

  describe('a VIEWER', () => {
    it('cannot cancel a citizen\'s appointment', async () => {
      const id = await makeBooking(24);
      const res = await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${id}/cancel`)
        .set('Authorization', `Bearer ${viewer.token}`)
        .send({ reason: 'because I can' });

      expect(res.status).toBe(403);

      // And the appointment is untouched, not merely the response refused.
      const after = await prisma.booking.findUnique({ where: { id } });
      expect(after?.status).toBe('CONFIRMED');
    });

    it('cannot move one, override its status, or raise a refund against it', async () => {
      const id = await makeBooking(25);
      const bearer = `Bearer ${viewer.token}`;

      const reschedule = await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${id}/reschedule`)
        .set('Authorization', bearer)
        .send({ newStartTime: new Date(Date.now() + 99 * 3600_000).toISOString() });
      const status = await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${id}/status`)
        .set('Authorization', bearer)
        .send({ status: 'COMPLETED' });
      const refund = await request(app.getHttpServer())
        .post(`/api/scheduling/bookings/${id}/refund-request`)
        .set('Authorization', bearer)
        .send({ reason: 'x' });
      const create = await request(app.getHttpServer())
        .post('/api/scheduling/bookings')
        .set('Authorization', bearer)
        .send({ contactId, serviceName: 'Nope', startTime: new Date(Date.now() + 80 * 3600_000).toISOString() });

      expect([reschedule.status, status.status, refund.status, create.status]).toEqual([403, 403, 403, 403]);

      const after = await prisma.booking.findUnique({ where: { id } });
      expect(after?.status).toBe('CONFIRMED');
      expect(after?.startTime.toISOString()).not.toContain('9999');
    });

    it('can still read the diary, because looking is the job', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/scheduling/bookings')
        .set('Authorization', `Bearer ${viewer.token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('cannot read the refund queue, which its own comment always claimed', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/scheduling/refund-requests')
        .set('Authorization', `Bearer ${viewer.token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('an AGENT on the front desk', () => {
    it('can cancel, because that is the job', async () => {
      const id = await makeBooking(26);
      const res = await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${id}/cancel`)
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ reason: 'Citizen called to cancel' });

      expect(res.status).toBe(200);
      const after = await prisma.booking.findUnique({ where: { id } });
      expect(after?.status).toBe('CANCELLED');
      // The reason is kept: the citizen will ask why, possibly months later.
      expect(after?.notes).toContain('Citizen called to cancel');
    });

    it('can move one to a free slot', async () => {
      const id = await makeBooking(27);
      const moved = new Date(Date.now() + 50 * 3600_000);
      const res = await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${id}/reschedule`)
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ newStartTime: moved.toISOString() });

      expect(res.status).toBe(200);
      const after = await prisma.booking.findUnique({ where: { id } });
      expect(after?.startTime.getTime()).toBe(moved.getTime());
    });

    it('cannot override a status, which corrects the record rather than serving a citizen', async () => {
      const id = await makeBooking(28);
      const res = await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${id}/status`)
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ status: 'COMPLETED' });

      expect(res.status).toBe(403);
    });
  });

  describe('an OWNER', () => {
    it('can override a status', async () => {
      const id = await makeBooking(29);
      const res = await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${id}/status`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ status: 'COMPLETED' });

      expect(res.status).toBe(200);
      expect((await prisma.booking.findUnique({ where: { id } }))?.status).toBe('COMPLETED');
    });

    it('raises a refund ticket AND frees the slot, together', async () => {
      const id = await makeBooking(30);
      const res = await request(app.getHttpServer())
        .post(`/api/scheduling/bookings/${id}/refund-request`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ reason: 'Paid twice' });

      expect(res.status).toBe(201);

      // The dashboard tells the officer both things happen; both must.
      const after = await prisma.booking.findUnique({ where: { id } });
      expect(after?.status).toBe('CANCELLED');

      const queue = await request(app.getHttpServer())
        .get('/api/scheduling/refund-requests')
        .set('Authorization', `Bearer ${owner.token}`);
      expect(queue.status).toBe(200);
      expect(queue.body.some((t: any) => String(t.ticketNumber).startsWith('REF-BK-'))).toBe(true);
    });
  });

  // Not scheduling, but the same hole found by the same audit: a controller
  // with write routes and no RolesGuard. This one spends money.
  describe('placing an outbound call', () => {
    it('refuses a VIEWER, who could otherwise dial anywhere at the agency\u2019s expense', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/telephony/outbound')
        .set('Authorization', `Bearer ${viewer.token}`)
        .send({ toNumber: '+2348090000009' });

      expect(res.status).toBe(403);
    });

    it('does not refuse an AGENT, because ringing a citizen back is the job', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/telephony/outbound')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({ toNumber: '+2348090000009' });

      // No carrier credentials in a test environment, so this fails further in
      // — on purpose. What matters is that it is not refused by the ROLE, and
      // that the failure is an honest one rather than a fabricated call record.
      expect(res.status).not.toBe(403);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  describe('the payload the dashboard sends', () => {
    it('creates a booking from a contact id, the shape the form now posts', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/scheduling/bookings')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({
          contactId,
          serviceName: 'Biometrics capture',
          staffName: 'Desk 3',
          startTime: new Date(Date.now() + 70 * 3600_000).toISOString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.serviceName).toBe('Biometrics capture');
    });

    it('refuses the shape the form USED to send, rather than half-creating one', async () => {
      // `{contactName, service, staff}` reached Prisma with contactId
      // undefined — which Prisma treats as "no filter", so the lookup matched
      // an arbitrary contact — and serviceName undefined against a NOT NULL
      // column. The dashboard showed no error at all, because it checked
      // `if (res.ok)` and had no else.
      const res = await request(app.getHttpServer())
        .post('/api/scheduling/bookings')
        .set('Authorization', `Bearer ${agent.token}`)
        .send({
          contactName: 'Jane Citizen',
          service: 'Consultation',
          staff: 'Senior Specialist',
          startTime: new Date(Date.now() + 71 * 3600_000).toISOString(),
        });

      expect(res.status).toBeGreaterThanOrEqual(400);

      const stray = await prisma.booking.findFirst({
        where: { organizationId: owner.orgId, serviceName: { in: ['Consultation', ''] } },
      });
      expect(stray).toBeNull();
    });
  });
});
