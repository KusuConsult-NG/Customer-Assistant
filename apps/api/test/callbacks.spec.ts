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
import { randomBytes } from 'crypto';
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

  /**
   * A distinct number per call, from RANDOM bytes rather than the clock.
   *
   * This was `+23480${String(Date.now()).slice(-8)}`, and `Contact` is unique
   * on `[organizationId, phoneNumber]` — so two contacts created in the SAME
   * MILLISECOND in one organization got the same number and the second write
   * failed with a P2002. Two tests below do exactly that, back to back in one
   * org, so the suite failed intermittently with a unique-constraint
   * violation that reads like a real regression in the callback queue and is
   * nothing of the kind. It passes on a re-run, which is the worst property a
   * failure can have: the next person re-runs it, sees green, and learns to
   * ignore this suite.
   */
  // A random 4-digit run id, then a COUNTER. The counter makes collisions
  // within a run impossible rather than unlikely, and the run id keeps two
  // runs against the same database apart.
  //
  // Pure randomness truncated to 8 digits still collided 4 times in 20,000
  // draws when measured, and a rare flake is worse than a frequent one: it
  // surfaces in somebody else's unrelated change, months later, with no way
  // to reproduce it.
  const runId = randomBytes(2).readUInt16BE(0) % 10000;
  let phoneSeq = 0;
  const phone = () =>
    `+23480${String(runId).padStart(4, '0')}${String((phoneSeq += 1) % 10000).padStart(4, '0')}`;

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

    it('records the SID, and does NOT yet claim the citizen was reached', async () => {
      // This assertion used to be `status === 'COMPLETED'`, and the schema
      // says COMPLETED means "the citizen was reached". A carrier accepting a
      // dial request is not that: the phone may be engaged, switched off, or
      // ring out. Marking it COMPLETED told the console a promise had been
      // kept, used up nothing of `maxAttempts`, and retried nothing — the
      // exact "recorded as a call that never happened" this file exists for,
      // reintroduced one step later in the same flow.
      const row = await seedCallback(agency.orgId, contactId, { dueAt: new Date(Date.now() - 60_000) });

      await dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_spec_sid_0001' }),
      }).placeOne(row.id);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('IN_PROGRESS');
      expect(after?.callSid).toBe('CA_spec_sid_0001');
      expect(after?.completedAt).toBeNull();
      expect(after?.attempts).toBe(1);
    });

    it('is kept once the carrier reports the citizen answered', async () => {
      const row = await seedCallback(agency.orgId, contactId, { dueAt: new Date(Date.now() - 60_000) });
      await dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_answered_0001' }),
      }).placeOne(row.id);

      await dispatcherWith({}).reconcileFromCall('CA_answered_0001', 'COMPLETED', 42);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('COMPLETED');
      expect(after?.completedAt).toBeTruthy();
    });

    it('tries again when the citizen did not pick up', async () => {
      const row = await seedCallback(agency.orgId, contactId, { dueAt: new Date(Date.now() - 60_000) });
      await dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_noanswer_0001' }),
      }).placeOne(row.id);

      await dispatcherWith({}).reconcileFromCall('CA_noanswer_0001', 'NO_ANSWER');

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('PENDING');
      expect(after?.completedAt).toBeNull();
      expect(after?.failureReason).toMatch(/did not answer/i);
      expect(after!.dueAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('gives up honestly when the last attempt also went unanswered', async () => {
      const row = await seedCallback(agency.orgId, contactId, {
        dueAt: new Date(Date.now() - 60_000),
        maxAttempts: 1,
      });
      await dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_busy_final' }),
      }).placeOne(row.id);

      await dispatcherWith({}).reconcileFromCall('CA_busy_final', 'BUSY');

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('FAILED');
      expect(after?.failureReason).toMatch(/engaged|busy/i);
      expect(after?.completedAt).toBeNull();
    });

    it('does not resolve another agency\'s promise from a shared SID', async () => {
      // CallLog and CallbackRequest both key on the carrier's SID, and the
      // reconciliation runs from a carrier callback — so it must stay inside
      // the organization that owns the row.
      const row = await seedCallback(agency.orgId, contactId, { dueAt: new Date(Date.now() - 60_000) });
      await dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_scoped_0001' }),
      }).placeOne(row.id);

      const handled = await dispatcherWith({}).reconcileFromCall(
        'CA_scoped_0001', 'COMPLETED', 10, other.orgId
      );
      expect(handled).toBe(false);

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('IN_PROGRESS');
    });

    it('does not leave a promise dialling forever when the carrier says nothing', async () => {
      // The carrier's status callback can be lost, the SIP path reports no
      // outcome at all, and a crash between the claim and the dial leaves the
      // same state. Before this, such a row sat IN_PROGRESS until somebody
      // noticed — which is indistinguishable from a promise nobody kept.
      const row = await seedCallback(agency.orgId, contactId, {
        status: 'IN_PROGRESS',
        attempts: 1,
        maxAttempts: 3,
        callSid: 'CA_silent_0001',
        lastAttemptAt: new Date(Date.now() - 60 * 60_000),
        dueAt: new Date(Date.now() - 90 * 60_000),
      });

      const result = await dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'should_not_be_called_here' }),
      }).sweep(new Date());

      expect(result.reopened).toBeGreaterThan(0);
      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      expect(after?.status).toBe('PENDING');
      expect(after?.failureReason).toMatch(/never reported/i);
    });

    it('does not let one agency\'s held promises starve another\'s', async () => {
      // Held rows stay DUE at the head of the queue, ordered by dueAt. With a
      // fixed `take`, an agency with a nightful of promises outside its own
      // contact window filled every sweep, and an agency whose window IS open
      // was never reached — its citizens waiting on a queue that was busy
      // skipping somebody else's.
      await prisma.organization.update({
        where: { id: agency.orgId },
        data: {
          openingHour: 0, closingHour: 24, serviceDays: [0, 1, 2, 3, 4, 5, 6],
          outboundOpeningHour: 8, outboundClosingHour: 20, outboundDays: [0, 1, 2, 3, 4, 5, 6],
        },
      });
      // The other agency may ring at any hour.
      await prisma.organization.update({
        where: { id: other.orgId },
        data: {
          openingHour: 0, closingHour: 24, serviceDays: [0, 1, 2, 3, 4, 5, 6],
          outboundOpeningHour: 0, outboundClosingHour: 24, outboundDays: [0, 1, 2, 3, 4, 5, 6],
        },
      });
      const otherContact = await prisma.contact.create({
        data: { organizationId: other.orgId, phoneNumber: phone(), fullName: 'Reachable Now' },
      });

      const night = new Date(Date.UTC(2026, 10, 3, 2, 0)); // 03:00 WAT
      // 30 promises for the agency that may not ring yet, all older.
      const backlog: string[] = [];
      for (let i = 0; i < 30; i++) {
        const held = await seedCallback(agency.orgId, contactId, {
          status: 'DUE',
          dueAt: new Date(night.getTime() - (i + 10) * 60_000),
        });
        backlog.push(held.id);
      }
      const reachable = await seedCallback(other.orgId, otherContact.id, {
        status: 'DUE',
        dueAt: new Date(night.getTime() - 60_000),
      });

      let dialled: string[] = [];
      const d = dispatcherWith({
        initiateOutboundCall: async (_org: string, to: string) => {
          dialled.push(to);
          return { callId: `CA_starve_${dialled.length}` };
        },
      });
      const result = await d.sweep(night);

      // Asserted on THESE rows, not on the global `held` counter.
      //
      // The sweep is deployment-wide by design and reads a bounded page
      // ordered by dueAt, so `result.held` counts every agency's held rows —
      // including ones other suites left behind. In CI that page filled and
      // the count came back 29 of an expected 30, failing for a reason that
      // has nothing to do with starvation. The behaviour under test is that
      // a reachable promise in ANOTHER agency still got dialled behind a
      // 30-deep backlog, and that is what these assert.
      const heldAfter = await prisma.callbackRequest.findMany({
        where: { id: { in: backlog } },
        select: { status: true },
      });
      expect(heldAfter).toHaveLength(30);
      expect(heldAfter.every((r) => r.status === 'DUE')).toBe(true);

      const after = await prisma.callbackRequest.findUnique({ where: { id: reachable.id } });
      expect(after?.status).toBe('IN_PROGRESS');
      expect(after?.callSid).toBeTruthy();

      // This backlog exists to crowd a sweep, so leaving it behind crowds the
      // sweeps the later tests run — the dial budget is real and shared.
      await prisma.callbackRequest.deleteMany({ where: { id: { in: backlog } } });
      await prisma.callbackRequest.deleteMany({ where: { id: reachable.id } });
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
      // Dated well into the past on purpose. The sweep reads a bounded page
      // ordered by dueAt ASC, so the oldest rows are the ones certain to be
      // seen — with a recent timestamp this row sat behind whatever other
      // suites had left DUE in the shared database and was never scanned,
      // which read as "the window did not open" rather than as crowding.
      const row = await seedCallback(agency.orgId, contactId, {
        status: 'DUE',
        dueAt: new Date(Date.UTC(2020, 0, 1, 2, 0)),
      });

      const d = dispatcherWith({
        initiateOutboundCall: async () => ({ callId: 'CA_after_window_opened' }),
      });
      // 09:00 WAT.
      await d.sweep(new Date(Date.UTC(2026, 10, 3, 8, 0)));

      const after = await prisma.callbackRequest.findUnique({ where: { id: row.id } });
      // Dialled, outcome not yet known — see "records the SID" above.
      expect(after?.status).toBe('IN_PROGRESS');
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
