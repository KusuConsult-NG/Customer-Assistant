/**
 * An agency's own audit trail.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * `AuditLog` had exactly one writer — a private method on `PlatformService` —
 * and exactly one reader, `/api/platform/audit`, which is operators-only. So
 * every row in the table described something the ministry had done, and the
 * agency it was done TO could not read any of it. "Who did this to our agency"
 * had no answer from inside the agency, which is the opposite of what an audit
 * record is for.
 *
 * Nothing an agency's own staff did was recorded at all. Somebody could make
 * themselves an ADMIN, deactivate a colleague and mint a fresh API key, and
 * the table would show nothing.
 *
 * ── What these tests hold ───────────────────────────────────────────────────
 *
 * The trail is only worth having if it is both complete and bounded, so the
 * assertions come in pairs: a row IS written for each access change, and the
 * read shows a ministry action on this agency — while another agency's rows,
 * rows belonging to no agency, and the identity of the ministry official are
 * all absent. A trail that leaks across the boundary it documents is not an
 * improvement on having none.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { SchedulingService } from '../src/scheduling/scheduling.service';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('the agency audit trail', () => {
  let app: INestApplication;
  let operator: TestTenant;
  let agency: TestTenant;
  let other: TestTenant;
  /** A colleague inside `agency`, to be promoted and deactivated. */
  let scheduling: SchedulingService;
  let colleagueId: string;
  let colleagueEmail: string;

  jest.setTimeout(90000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    scheduling = app.get(SchedulingService);

    operator = await createTenant(app, 'audit-ministry', { isPlatformAdmin: true });
    agency = await createTenant(app, 'audit-agency', { role: 'OWNER' });
    other = await createTenant(app, 'audit-other', { role: 'OWNER' });

    colleagueEmail = `colleague-${randomBytes(3).toString('hex')}@tenant.test`;
    const colleague = await prisma.user.create({
      data: {
        organizationId: agency.orgId,
        email: colleagueEmail,
        passwordHash: 'not-a-login-path',
        fullName: 'Audit Colleague',
        role: 'AGENT',
      },
    });
    colleagueId = colleague.id;
  });

  afterAll(async () => {
    await dropTenant(operator?.orgId);
    await dropTenant(agency?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  const asAgency = () =>
    request(app.getHttpServer())
      .get('/api/organizations/audit')
      .set('Authorization', `Bearer ${agency.token}`);

  const trail = async (): Promise<any[]> => (await asAgency().expect(200)).body.entries;

  // ── The agency's own actions are recorded at all ──────────────────────────

  describe('what an agency does inside its own tenancy', () => {
    it('records a role change with both sides of it', async () => {
      await request(app.getHttpServer())
        .patch(`/api/organizations/members/${colleagueId}/role`)
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ role: 'ADMIN' })
        .expect(200);

      const row = (await trail()).find((e) => e.action === 'agency.member.role_changed');
      expect(row).toBeDefined();
      // The new value alone cannot answer "who made themselves an admin".
      expect(row.previousValue).toMatchObject({ role: 'AGENT' });
      expect(row.newValue).toMatchObject({ role: 'ADMIN' });
      expect(row.origin).toBe('agency');
    });

    it('names the colleague who made the change', async () => {
      const row = (await trail()).find((e) => e.action === 'agency.member.role_changed');

      // The platform console renders a truncated uuid, which answers "who did
      // this" with a riddle. Inside the agency the name is the whole point.
      expect(row.actorIsOwnStaff).toBe(true);
      expect(row.actor).toContain(agency.email);
    });

    it('records a deactivation as its own action, not a boolean', async () => {
      await request(app.getHttpServer())
        .patch(`/api/organizations/members/${colleagueId}/status`)
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ isActive: false })
        .expect(200);

      // Findable by somebody scanning for what happened, which
      // `status_changed {isActive:false}` is not.
      const row = (await trail()).find((e) => e.action === 'agency.member.deactivated');
      expect(row).toBeDefined();
      expect(row.newValue).toMatchObject({ isActive: false });
    });

    it('records the API key prefix and never the key itself', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/organizations/api-keys/regenerate')
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(201);

      const issued: string = res.body.apiKey;
      expect(issued).toMatch(/^ace_live_pk_/);

      const row = (await trail()).find((e) => e.action === 'agency.api_key.regenerated');
      expect(row).toBeDefined();
      expect(row.newValue.keyPrefix).toBe(issued.slice(0, 16));

      // The trail is readable by every admin in the agency. A key recorded
      // here would make the audit log a place to go and collect one.
      expect(JSON.stringify(row)).not.toContain(issued);
    });

    it('keeps a removed member identifiable after the row is gone', async () => {
      const doomed = await prisma.user.create({
        data: {
          organizationId: agency.orgId,
          email: `doomed-${randomBytes(3).toString('hex')}@tenant.test`,
          passwordHash: 'not-a-login-path',
          fullName: 'Departing Officer',
          role: 'VIEWER',
        },
      });

      await request(app.getHttpServer())
        .delete(`/api/organizations/members/${doomed.id}`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);

      // Nothing is left to resolve the id against, so the record has to carry
      // the details or it describes a person nobody can name.
      const row = (await trail()).find(
        (e) => e.action === 'agency.member.removed' && e.targetId === doomed.id
      );
      expect(row).toBeDefined();
      expect(row.previousValue).toMatchObject({ fullName: 'Departing Officer', role: 'VIEWER' });
    });
  });

  // ── What the ministry did to it ───────────────────────────────────────────

  describe('what was done to the agency from outside', () => {
    beforeAll(async () => {
      // Suspend and reinstate. The order matters: a suspended agency's members
      // are refused on their next request, so it could not read its own trail
      // while suspended — which is itself the reason the reinstate has to
      // happen before the assertions rather than after them.
      await request(app.getHttpServer())
        .post(`/api/platform/agencies/${agency.orgId}/suspend`)
        .set('Authorization', `Bearer ${operator.token}`)
        .send({ reason: 'Audit trail fixture' })
        .expect(201);

      await request(app.getHttpServer())
        .post(`/api/platform/agencies/${agency.orgId}/reinstate`)
        .set('Authorization', `Bearer ${operator.token}`)
        .expect(201);
    });

    it('shows the suspension, with the reason that was recorded', async () => {
      const row = (await trail()).find((e) => e.action === 'platform.agency.suspended');

      // The whole point: the one actor not bounded by tenant scoping is
      // accountable to the agency it acted on.
      expect(row).toBeDefined();
      expect(row.newValue).toMatchObject({ reason: 'Audit trail fixture' });
      expect(row.origin).toBe('platform');
    });

    it('does not name the ministry official who did it', async () => {
      const rows = await trail();
      const row = rows.find((e) => e.action === 'platform.agency.suspended');

      expect(row.actorIsOwnStaff).toBe(false);
      expect(row.actor).toMatch(/platform operator/i);

      // Naming them would hand one tenant the identity of a person in
      // another. Which official it was stays a question for the ministry's
      // own console, which has the whole picture.
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(operator.email);
      expect(serialized).not.toContain(operator.userId);
    });
  });

  // ── Domain records: what was done to a citizen's file ─────────────────────

  describe('records the agency changed, not just the access it granted', () => {
    const contactPayload = () => ({
      organizationId: agency.orgId,
      fullName: `Hauwa ${randomBytes(3).toString('hex')}`,
      phoneNumber: `+2348${String(Date.now()).slice(-9)}`,
      email: `hauwa-${randomBytes(3).toString('hex')}@citizen.test`,
    });

    it('names the citizen whose record was deleted', async () => {
      const contact = await prisma.contact.create({ data: contactPayload() });

      await request(app.getHttpServer())
        .delete(`/api/crm/contacts/${contact.id}`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);

      // The row is gone, so the id resolves to nothing — the record has to
      // carry the details or it describes a citizen nobody can identify.
      const row = (await trail()).find(
        (e) => e.action === 'agency.contact.deleted' && e.targetId === contact.id
      );
      expect(row).toBeDefined();
      expect(row.previousValue).toMatchObject({
        fullName: contact.fullName,
        phoneNumber: contact.phoneNumber,
      });
      expect(row.actorIsOwnStaff).toBe(true);
    });

    it('records a case being closed, with the status it replaced', async () => {
      const contact = await prisma.contact.create({ data: contactPayload() });
      const ticket = await prisma.ticket.create({
        data: {
          organizationId: agency.orgId,
          contactId: contact.id,
          ticketNumber: `AUD-${randomBytes(3).toString('hex')}`,
          subject: 'Water supply',
          description: 'No supply for three days.',
          status: 'OPEN',
        },
      });

      await request(app.getHttpServer())
        .patch(`/api/crm/tickets/${ticket.id}/status`)
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ status: 'CLOSED' })
        .expect(200);

      const row = (await trail()).find(
        (e) => e.action === 'agency.ticket.status_changed' && e.targetId === ticket.id
      );
      expect(row).toBeDefined();
      expect(row.previousValue).toMatchObject({ status: 'OPEN' });
      expect(row.newValue).toMatchObject({ status: 'CLOSED' });
    });

    it('records a service being withdrawn from citizens', async () => {
      const option = await prisma.serviceOption.create({
        data: { organizationId: agency.orgId, name: `Land Title ${randomBytes(2).toString('hex')}` },
      });

      await request(app.getHttpServer())
        .delete(`/api/catalogue/services/${option.id}`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);

      const row = (await trail()).find(
        (e) => e.action === 'agency.service.deleted' && e.targetId === option.id
      );
      expect(row).toBeDefined();
      expect(row.previousValue).toMatchObject({ name: option.name });
    });
  });

  // ── Who moved the appointment: a person, or the AI ────────────────────────

  describe('a change the AI made is attributed to the AI', () => {
    const makeBooking = async () => {
      const contact = await prisma.contact.create({
        data: {
          organizationId: agency.orgId,
          fullName: `Booking Citizen ${randomBytes(2).toString('hex')}`,
          phoneNumber: `+2347${String(Date.now()).slice(-9)}`,
        },
      });
      const start = new Date(Date.now() + 7 * 24 * 3600 * 1000);
      return prisma.booking.create({
        data: {
          organizationId: agency.orgId,
          contactId: contact.id,
          serviceName: 'Land title search',
          startTime: start,
          endTime: new Date(start.getTime() + 30 * 60 * 1000),
          status: 'CONFIRMED',
        },
      });
    };

    it('names the officer who cancelled an appointment', async () => {
      const booking = await makeBooking();

      await request(app.getHttpServer())
        .patch(`/api/scheduling/bookings/${booking.id}/cancel`)
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ reason: 'Office closed that day' })
        .expect(200);

      const row = (await trail()).find(
        (e) => e.action === 'agency.booking.cancelled' && e.targetId === booking.id
      );
      expect(row).toBeDefined();
      expect(row.actorIsOwnStaff).toBe(true);
      expect(row.actor).toContain(agency.email);
      // The time the citizen gave up, which the cancellation itself erases.
      expect(row.previousValue).toMatchObject({ status: 'CONFIRMED' });
      expect(row.newValue).toMatchObject({ reason: 'Office closed that day' });
    });

    it('does not file an AI cancellation as though a colleague did it', async () => {
      const booking = await makeBooking();

      // What the hosted agent passes when a citizen cancels on a call.
      await scheduling.cancelBooking(
        agency.orgId,
        booking.id,
        'Citizen cancelled on the call',
        'system:hosted-agent'
      );

      const row = (await trail()).find(
        (e) => e.action === 'agency.booking.cancelled' && e.targetId === booking.id
      );
      expect(row).toBeDefined();

      // A trail recording only what humans did would quietly imply the AI
      // never touched anyone's appointment.
      expect(row.actorIsOwnStaff).toBe(false);
      expect(row.actor).toMatch(/automated process/i);
      expect(row.actor).toContain('hosted-agent');

      // And emphatically not attributed to a member of staff.
      expect(row.actor).not.toContain(agency.email);
    });

    it('records a reschedule as the move it was', async () => {
      const booking = await makeBooking();
      const later = new Date(Date.now() + 14 * 24 * 3600 * 1000);

      await scheduling.rescheduleBooking(
        agency.orgId,
        booking.id,
        later.toISOString(),
        30,
        'system:orchestrator'
      );

      const row = (await trail()).find(
        (e) => e.action === 'agency.booking.rescheduled' && e.targetId === booking.id
      );
      expect(row).toBeDefined();
      expect(row.actor).toContain('orchestrator');
      // Both times: a reschedule with only the new one does not say what moved.
      expect(new Date(row.previousValue.startTime).toISOString()).toBe(booking.startTime.toISOString());
      expect(new Date(row.newValue.startTime).toISOString()).toBe(later.toISOString());
    });
  });

  // ── The platform tier must not learn WHICH citizen ────────────────────────

  describe('what the ministry sees of an agency action', () => {
    it('is told that a citizen record was deleted, but never which one', async () => {
      const contact = await prisma.contact.create({
        data: {
          organizationId: agency.orgId,
          fullName: 'Confidential Citizen Name',
          phoneNumber: `+2349${String(Date.now()).slice(-9)}`,
        },
      });

      await request(app.getHttpServer())
        .delete(`/api/crm/contacts/${contact.id}`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);

      const res = await request(app.getHttpServer())
        .get(`/api/platform/audit?organizationId=${agency.orgId}`)
        .set('Authorization', `Bearer ${operator.token}`)
        .expect(200);

      const serialized = JSON.stringify(res.body);

      // The accountable fact survives: the ministry can see the action, the
      // actor and the time.
      expect(serialized).toContain('agency.contact.deleted');

      // The citizen does not. This tier reports metrics and configuration,
      // never content — and an audit row is the one place where an agency
      // action carries a citizen's name and number.
      expect(serialized).not.toContain('Confidential Citizen Name');
      expect(serialized).not.toContain(contact.phoneNumber);
    });

    it('still shows the reason a suspension was issued', async () => {
      // platform.* values are about AGENCIES, not citizens, and the reason is
      // the point of the record — redacting those too would make the tier's
      // own trail useless.
      const res = await request(app.getHttpServer())
        .get(`/api/platform/audit?organizationId=${agency.orgId}`)
        .set('Authorization', `Bearer ${operator.token}`)
        .expect(200);

      expect(JSON.stringify(res.body)).toContain('Audit trail fixture');
    });
  });

  // ── The boundary ──────────────────────────────────────────────────────────

  describe('scoping', () => {
    it('shows nothing belonging to another agency', async () => {
      await request(app.getHttpServer())
        .post(`/api/platform/agencies/${other.orgId}/suspend`)
        .set('Authorization', `Bearer ${operator.token}`)
        .send({ reason: 'Another agency entirely' })
        .expect(201);

      const serialized = JSON.stringify(await trail());
      expect(serialized).not.toContain('Another agency entirely');
      expect(serialized).not.toContain(other.orgId);
    });

    it('excludes rows that belong to no agency at all', async () => {
      // Granting platform status is recorded against no organization, because
      // it belongs to no single agency. A read that treated null as a match
      // would hand every agency the platform's own administration history.
      const marker = `NOBODYS-TENANCY-${randomBytes(4).toString('hex')}`;
      await prisma.auditLog.create({
        data: {
          organizationId: null,
          actor: 'system:test',
          action: 'platform.operator.granted',
          targetType: 'User',
          targetId: marker,
          newValue: { marker },
        },
      });

      expect(JSON.stringify(await trail())).not.toContain(marker);
    });

    it('refuses a member who is not an OWNER or ADMIN', async () => {
      for (const role of ['AGENT', 'VIEWER'] as const) {
        const member = await createTenant(app, `audit-${role.toLowerCase()}`, { role });
        try {
          // The trail names which colleague changed somebody's role. That is
          // administrative information, not something an agent needs to work.
          await request(app.getHttpServer())
            .get('/api/organizations/audit')
            .set('Authorization', `Bearer ${member.token}`)
            .expect(403);
        } finally {
          await dropTenant(member.orgId);
        }
      }
    });

    it('requires authentication', async () => {
      await request(app.getHttpServer()).get('/api/organizations/audit').expect(401);
    });

    it('takes no organization id from the caller, so there is nothing to substitute', async () => {
      // Scoped from the token. Passing another agency's id as a query
      // parameter is simply ignored rather than honoured.
      const res = await request(app.getHttpServer())
        .get(`/api/organizations/audit?organizationId=${other.orgId}`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);

      expect(JSON.stringify(res.body)).not.toContain('Another agency entirely');
    });
  });
});
