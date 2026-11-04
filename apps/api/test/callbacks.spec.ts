/**
 * The callback queue: who may see it, who may act on it, and what a failed
 * call is allowed to claim.
 *
 * ── What this covers that the flow spec cannot ──────────────────────────────
 *
 * `packages/orchestrator/test/callback-flow.spec.ts` proves the conversation —
 * the questions, the read-back, the window. This proves the half that runs
 * after the citizen has hung up: the tenant boundary, the roles, and above all
 * that a call which did not happen is never recorded as one.
 *
 * That last point is the whole reason the dispatcher claims a row before it
 * dials. "Marked COMPLETED but never rang" is the callback-shaped version of
 * the scheduling screen that said "Booking cancelled." and made no request.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { prisma, callbackReference } from '@ace/database';
import { AppModule } from '../src/app.module';
import { CallbackDispatcherService } from '../src/telephony/callback-dispatcher.service';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Callback queue', () => {
  let app: INestApplication;
  let agency: TestTenant;
  let viewer: TestTenant;
  let other: TestTenant;
  let contactId: string;

  jest.setTimeout(90000);

  const phone = () => `+23480${String(Date.now()).slice(-8)}`;

  async function seedCallback(orgId: string, cid: string, over: Record<string, any> = {}) {
    return prisma.callbackRequest.create({
      data: {
        organizationId: orgId,
        contactId: cid,
        phoneNumber: phone(),
        reason: 'borehole has been dry for a week',
        promisedText: 'Within the hour',
        dueAt: new Date(Date.now() + 60 * 60 * 1000),
        ...over,
      },
    });
  }

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    agency = await createTenant(app, 'cb-agency', { role: 'OWNER' });
    viewer = await createTenant(app, 'cb-viewer', { role: 'VIEWER' });
    other = await createTenant(app, 'cb-other', { role: 'OWNER' });

    const contact = await prisma.contact.create({
      data: { organizationId: agency.orgId, phoneNumber: phone(), fullName: 'Amina Yusuf' },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await dropTenant(agency?.orgId);
    await dropTenant(viewer?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  describe('raising one', () => {
    it('records the promise and quotes a reference back', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/callbacks')
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ contactId, reason: 'water supply has been off for three days', dueInMinutes: 60 })
        .expect(201);

      expect(res.body.reference).toMatch(/^CB-[A-Z0-9]{8}$/);
      expect(res.body.status).toBe('PENDING');
      expect(new Date(res.body.dueAt).getTime()).toBeGreaterThan(Date.now());
      // The reference the citizen is told must find the row an officer opens.
      expect(callbackReference(res.body.id)).toBe(res.body.reference);
    });

    it('refuses one with no reason, because somebody has to ring about something', async () => {
      await request(app.getHttpServer())
        .post('/api/callbacks')
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ contactId, reason: '   ' })
        .expect(400);
    });

    it('will not attach a callback to another agency\'s citizen', async () => {
      await request(app.getHttpServer())
        .post('/api/callbacks')
        .set('Authorization', `Bearer ${other.token}`)
        .send({ contactId, reason: 'should not be possible' })
        .expect(400);
    });
  });

  describe('the tenant boundary', () => {
    it('shows an agency only its own promises', async () => {
      await seedCallback(agency.orgId, contactId);

      const mine = await request(app.getHttpServer())
        .get('/api/callbacks')
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);
      expect(mine.body.length).toBeGreaterThan(0);
      for (const row of mine.body) expect(row.organizationId).toBe(agency.orgId);

      const theirs = await request(app.getHttpServer())
        .get('/api/callbacks')
        .set('Authorization', `Bearer ${other.token}`)
        .expect(200);
      expect(theirs.body).toEqual([]);
    });

    it('refuses an unauthenticated read', async () => {
      await request(app.getHttpServer()).get('/api/callbacks').expect(401);
    });
  });

  describe('who may act on one', () => {
    it('lets any member READ the queue — an officer needs to see who is waiting', async () => {
      await request(app.getHttpServer())
        .get('/api/callbacks')
        .set('Authorization', `Bearer ${viewer.token}`)
        .expect(200);
    });

    it('refuses a VIEWER placing a call at the agency\'s expense', async () => {
      const row = await seedCallback(viewer.orgId, (await prisma.contact.create({
        data: { organizationId: viewer.orgId, phoneNumber: phone(), fullName: 'V' },
      })).id);

      await request(app.getHttpServer())
        .post(`/api/callbacks/${row.id}/call-now`)
        .set('Authorization', `Bearer ${viewer.token}`)
        .expect(403);
    });

    it('refuses a VIEWER closing a promise off', async () => {
      const row = await seedCallback(viewer.orgId, (await prisma.contact.create({
        data: { organizationId: viewer.orgId, phoneNumber: phone(), fullName: 'V2' },
      })).id);

      await request(app.getHttpServer())
        .patch(`/api/callbacks/${row.id}/complete`)
        .set('Authorization', `Bearer ${viewer.token}`)
        .expect(403);
    });
  });

  describe('closing one off', () => {
    it('marks it complete when an officer rang from their own phone', async () => {
      const row = await seedCallback(agency.orgId, contactId);
      await request(app.getHttpServer())
        .patch(`/api/callbacks/${row.id}/complete`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('COMPLETED');
      expect(after?.completedAt).toBeTruthy();
    });

    it('refuses to close the same one twice', async () => {
      const row = await seedCallback(agency.orgId, contactId);
      await request(app.getHttpServer())
        .patch(`/api/callbacks/${row.id}/complete`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(200);
      await request(app.getHttpServer())
        .patch(`/api/callbacks/${row.id}/complete`)
        .set('Authorization', `Bearer ${agency.token}`)
        .expect(400);
    });

    it('cancels with a reason an officer can read back', async () => {
      const row = await seedCallback(agency.orgId, contactId);
      await request(app.getHttpServer())
        .patch(`/api/callbacks/${row.id}/cancel`)
        .set('Authorization', `Bearer ${agency.token}`)
        .send({ reason: 'citizen called us first' })
        .expect(200);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('CANCELLED');
      expect(after?.failureReason).toMatch(/called us first/);
    });
  });

  describe('a call that did not happen is never recorded as one', () => {
    /** A dispatcher wired to a carrier that refuses, and one that answers. */
    const dispatcherWith = (telephony: any) =>
      new CallbackDispatcherService(telephony, { emitAsync: () => {} } as any);

    it('keeps the carrier\'s own reason and does NOT mark it completed', async () => {
      const row = await seedCallback(agency.orgId, contactId, { dueAt: new Date(Date.now() - 60_000) });
      const refusal = 'Twilio API returned 401: {"code":20003,"message":"Authenticate"}';

      await dispatcherWith({
        initiateOutboundCall: async () => { throw new Error(refusal); },
      }).placeOne(row.id);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).not.toBe('COMPLETED');
      expect(after?.completedAt).toBeNull();
      expect(after?.failureReason).toContain('20003');
      expect(after?.attempts).toBe(1);
      // Rescheduled rather than abandoned.
      expect(after!.dueAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('records the SID when the carrier does answer', async () => {
      const row = await seedCallback(agency.orgId, contactId, { dueAt: new Date(Date.now() - 60_000) });

      await dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_spec_sid_0001' }),
      }).placeOne(row.id);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('COMPLETED');
      expect(after?.callSid).toBe('CA_spec_sid_0001');
      expect(after?.completedAt).toBeTruthy();
    });

    it('rings the citizen ONCE when two pods sweep together', async () => {
      // The claim. Without it both pods see the same DUE row and both dial,
      // and the second officer has no idea the first call already happened.
      const row = await seedCallback(agency.orgId, contactId, { dueAt: new Date(Date.now() - 60_000) });
      let dials = 0;
      const slow = {
        initiateOutboundCall: async () => {
          dials++;
          await new Promise((r) => setTimeout(r, 200));
          return { callId: `CA_race_${dials}` };
        },
      };

      await Promise.all([
        dispatcherWith(slow).placeOne(row.id),
        dispatcherWith(slow).placeOne(row.id),
      ]);

      expect(dials).toBe(1);
    });

    it('stops after maxAttempts instead of ringing forever', async () => {
      const row = await seedCallback(agency.orgId, contactId, {
        dueAt: new Date(Date.now() - 60_000),
        maxAttempts: 2,
      });
      const d = dispatcherWith({
        initiateOutboundCall: async () => { throw new Error('carrier busy'); },
      });

      for (let i = 0; i < 4; i++) {
        await prisma.callbackRequest.updateMany({
          where: { id: row.id, status: 'PENDING' },
          data: { dueAt: new Date(Date.now() - 60_000) },
        });
        await d.placeOne(row.id);
      }

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('FAILED');
      expect(after?.attempts).toBe(2);
      expect(after?.failureReason).toBeTruthy();
    });

    it('holds a due promise outside the agency\'s contact hours', async () => {
      // The case this exists for. The agency answers 24/7, so serving hours
      // no longer hold anything back — but it may only RING between 08:00 and
      // 20:00, and a promise that fell due at 03:00 waits.
      await prisma.organization.update({
        where: { id: agency.orgId },
        data: {
          openingHour: 0, closingHour: 24, serviceDays: [0, 1, 2, 3, 4, 5, 6],
          outboundOpeningHour: 8, outboundClosingHour: 20, outboundDays: [0, 1, 2, 3, 4, 5, 6],
        },
      });
      const row = await seedCallback(agency.orgId, contactId, {
        status: 'DUE',
        dueAt: new Date(Date.UTC(2026, 10, 3, 2, 0)),
      });

      let dialled = false;
      const d = dispatcherWith({
        initiateOutboundCall: async () => { dialled = true; return { callId: 'x' }; },
      });

      // 03:00 WAT on the Tuesday.
      const result = await d.sweep(new Date(Date.UTC(2026, 10, 3, 2, 0)));

      expect(dialled).toBe(false);
      expect(result.held).toBeGreaterThan(0);

      // Held, not rescheduled: the citizen keeps the deadline they were given,
      // so the queue shows a promise that is late rather than one whose
      // deadline quietly moved to suit us.
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('DUE');
      expect(after?.attempts).toBe(0);
      expect(after!.dueAt.getTime()).toBe(row.dueAt.getTime());
    });

    it('dials the same promise once the window opens', async () => {
      await prisma.organization.update({
        where: { id: agency.orgId },
        data: {
          openingHour: 0, closingHour: 24, serviceDays: [0, 1, 2, 3, 4, 5, 6],
          outboundOpeningHour: 8, outboundClosingHour: 20, outboundDays: [0, 1, 2, 3, 4, 5, 6],
        },
      });
      const row = await seedCallback(agency.orgId, contactId, {
        status: 'DUE',
        dueAt: new Date(Date.UTC(2026, 10, 3, 2, 0)),
      });

      const d = dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_after_window_opened' }),
      });
      // 09:00 WAT.
      await d.sweep(new Date(Date.UTC(2026, 10, 3, 8, 0)));

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('COMPLETED');
      expect(after?.callSid).toBe('CA_after_window_opened');
    });

    it('uses serving hours when no contact window is configured', async () => {
      // Unchanged for an agency that configures nothing, which is every
      // agency that existed before this.
      await prisma.organization.update({
        where: { id: agency.orgId },
        data: {
          openingHour: 0, closingHour: 24, serviceDays: [0, 1, 2, 3, 4, 5, 6],
          outboundOpeningHour: null, outboundClosingHour: null, outboundDays: [],
        },
      });
      await seedCallback(agency.orgId, contactId, {
        status: 'DUE',
        dueAt: new Date(Date.UTC(2026, 10, 3, 2, 0)),
      });

      let dialled = false;
      const d = dispatcherWith({
        initiateOutboundCall: async () => { dialled = true; return { callId: 'y' }; },
      });
      await d.sweep(new Date(Date.UTC(2026, 10, 3, 2, 0)));

      // 24/7 serving hours, no window: it dials, as before.
      expect(dialled).toBe(true);
    });

    it('does not dial a promise that is not due yet', async () => {
      const row = await seedCallback(agency.orgId, contactId, {
        dueAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      });
      let dialled = false;
      await dispatcherWith({
        initiateOutboundCall: async () => { dialled = true; return { callId: 'x' }; },
      }).sweep();

      expect(dialled).toBe(false);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('PENDING');
      expect(after?.attempts).toBe(0);
    });
  });
});
