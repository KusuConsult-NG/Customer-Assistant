/**
 * Agent tool endpoints — the surface a hosted agent (ElevenLabs) calls to do
 * real work.
 *
 * Two properties matter more than the happy paths, and both are tested here
 * against the real controller, guard and database:
 *
 *  1. TENANT ISOLATION. The tenant comes from the agent key, never from the
 *     request. A hosted agent is configured by a third party and its calls are
 *     shaped by an LLM, so "organizationId" as a parameter would let one
 *     tenant's agent read another tenant's bookings by changing a string. These
 *     tests confirm a key for org A cannot reach org B's data even when B's ids
 *     are supplied.
 *
 *  2. HONEST FAILURE. No tool throws, and none invents facts. Payment details
 *     with nothing configured must refuse and hand off rather than produce a
 *     plausible account number; a handoff with no forwarding number must not
 *     promise a transfer.
 */

import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AgentToolsModule } from '../src/agent-tools/agent-tools.module';
import { WorkflowTriggerModule } from '../src/workflows/workflow-trigger.module';
import { AGENT_KEY_PREFIX } from '../src/agent-tools/agent-key.guard';

describe('Agent tools', () => {
  let app: INestApplication;
  let orgA: string;
  let orgB: string;
  let keyA: string;
  let keyB: string;

  const mintKey = async (organizationId: string) => {
    const key = `${AGENT_KEY_PREFIX}${randomBytes(16).toString('hex')}`;
    await prisma.apiKey.create({
      data: {
        organizationId,
        keyName: 'test agent key',
        keyHash: createHash('sha256').update(key).digest('hex'),
        keyPrefix: key.slice(0, 20),
      },
    });
    return key;
  };

  const makeOrg = async (name: string) => {
    const org = await prisma.organization.create({
      data: { name, slug: `${name.toLowerCase()}-${randomBytes(4).toString('hex')}`, industry: 'OTHER' },
    });
    return org.id;
  };

  beforeAll(async () => {
    // WorkflowTriggerModule is @Global, but @Global still has to enter the graph
    // once — CrmService depends on it and AgentToolsModule pulls in CrmModule.
    const moduleRef = await Test.createTestingModule({
      imports: [WorkflowTriggerModule, AgentToolsModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    orgA = await makeOrg('AgentToolsA');
    orgB = await makeOrg('AgentToolsB');
    keyA = await mintKey(orgA);
    keyB = await mintKey(orgB);
  }, 60_000);

  // Same 60s as the setup above. Two organizations cascade to every booking
  // the concurrency tests made, and this runs while the contended writes are
  // still draining — it hit the 5s default in CI and reported "Test suite
  // failed to run", which reads like a broken suite rather than slow cleanup.
  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
    await app?.close();
  }, 60_000);

  const post = (path: string, key: string, body: any = {}) =>
    request(app.getHttpServer())
      .post(`/api/agent-tools/${path}`)
      .set('Authorization', `Bearer ${key}`)
      .send(body);

  describe('authentication', () => {
    it('refuses a request with no key', async () => {
      await request(app.getHttpServer())
        .post('/api/agent-tools/payment-details')
        .send({})
        .expect(401);
    });

    it('refuses an unknown key', async () => {
      await post('payment-details', `${AGENT_KEY_PREFIX}deadbeef`).expect(401);
    });

    it('refuses a widget key, which is public and must not reach these endpoints', async () => {
      const widgetKey = `ace_live_pk_${randomBytes(16).toString('hex')}`;
      await prisma.apiKey.create({
        data: {
          organizationId: orgA,
          keyName: 'widget',
          keyHash: createHash('sha256').update(widgetKey).digest('hex'),
          keyPrefix: widgetKey.slice(0, 20),
        },
      });
      await post('payment-details', widgetKey).expect(401);
    });
  });

  describe('tenant isolation', () => {
    it("a key for one org cannot see another org's customer", async () => {
      const phone = `+2348${Date.now().toString().slice(-9)}`;
      await prisma.contact.create({
        data: { organizationId: orgB, phoneNumber: phone, fullName: 'Belongs To B' },
      });

      const asB = await post('lookup-customer', keyB, { phoneNumber: phone }).expect(201);
      expect(asB.body.data.known).toBe(true);

      // Same phone number, org A's key: must not find B's contact.
      const asA = await post('lookup-customer', keyA, { phoneNumber: phone }).expect(201);
      expect(asA.body.data.known).toBe(false);
      expect(JSON.stringify(asA.body)).not.toContain('Belongs To B');
    });

    it('ignores an organizationId supplied in the body', async () => {
      const phone = `+2347${Date.now().toString().slice(-9)}`;
      await prisma.contact.create({
        data: { organizationId: orgB, phoneNumber: phone, fullName: 'Also B' },
      });

      // The classic attempt: point org A's key at org B by parameter.
      const res = await post('lookup-customer', keyA, {
        phoneNumber: phone,
        organizationId: orgB,
      }).expect(201);

      expect(res.body.data.known).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('Also B');
    });
  });

  describe('honest failure', () => {
    it('refuses to give payment details when none are configured', async () => {
      const res = await post('payment-details', keyA).expect(201);

      expect(res.body.ok).toBe(false);
      expect(res.body.handoff).toBe(true);
      // Must not have produced anything resembling an account number.
      expect(res.body.speak).not.toMatch(/\d{6,}/);
    });

    it('returns the configured payment details verbatim once set', async () => {
      await prisma.organization.update({
        where: { id: orgA },
        data: {
          payoutBankName: 'Test Bank',
          payoutAccountName: 'Agent Tools Ltd',
          payoutAccountNumber: '0123456789',
        },
      });

      const res = await post('payment-details', keyA).expect(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.speak).toContain('0123456789');
      expect(res.body.speak).toContain('Agent Tools Ltd');
    });

    /**
     * The tool used to check whether a forwarding number was CONFIGURED and, if
     * one was, say "Connecting you to a member of our team now" — having
     * attempted nothing. The call was never moved. It also said "I will log
     * this so a member of our team calls you back" and logged nothing.
     *
     * Both are the same failure: a sentence that describes an action nobody
     * performed. On the orchestrator path a caller hearing "connecting you"
     * really is being transferred, because TwilioMediaStreamHandler redirects
     * first and picks the words from what Twilio did. Here the sentence WAS the
     * action — and after a cutover that handler is not in the path at all.
     */
    describe('handoff', () => {
      it('does not promise a transfer when there is no call to move', async () => {
        const res = await post('handoff', keyA, { phoneNumber: '+2348055500011' }).expect(201);

        expect(res.body.data.transferred).toBe(false);
        // The bug this guards: announcing a connection that never happens.
        expect(res.body.speak).not.toMatch(/connecting you|putting you through/i);
      });

      it('actually files the callback it promises, and quotes its reference', async () => {
        const phone = `+23480555${Date.now().toString().slice(-5)}`;
        const res = await post('handoff', keyA, { phoneNumber: phone, reason: 'a billing query' })
          .expect(201);

        // A promise of a record that does not exist is not a degradation — the
        // customer hangs up and waits for a callback nobody will make.
        expect(res.body.data.ticketId).toBeTruthy();
        expect(res.body.speak).toContain(res.body.data.ticketId.slice(0, 8));

        const ticket = await prisma.ticket.findUnique({ where: { id: res.body.data.ticketId } });
        expect(ticket).not.toBeNull();
        expect(ticket!.priority).toBe('HIGH');
        expect(ticket!.organizationId).toBe(orgA);
      });

      it('claims nothing at all when it cannot even log a callback', async () => {
        // No phone number: there is nobody to attach a ticket to, and inventing
        // a contact to hold one would be a record of a customer who does not
        // exist.
        const res = await post('handoff', keyA, {}).expect(201);

        expect(res.body.data.ticketId).toBeNull();
        expect(res.body.speak).not.toMatch(/connecting you|logged this|reference/i);
      });
    });

    /**
     * A taken slot is an ordinary answer, not a malfunction.
     *
     * The branch that says so decided by regexing the exception's English
     * message for /conflict|already booked|overlap|not available/.
     * SchedulingService throws "That slot is already taken by …" — none of
     * those four words. So every slot clash reached the customer as "I could
     * not complete that just now. Let me put you through to a member of our
     * team" and escalated to a human, which is the opposite of what the branch
     * exists to do. It now matches the HTTP status, which cannot drift with the
     * wording.
     */
    describe('a slot that is already taken', () => {
      const slotFor = (days: number) => {
        const when = new Date(Date.now() + days * 24 * 3600 * 1000);
        when.setUTCHours(9, 0, 0, 0);
        return when.toISOString();
      };

      it('is reported as unavailable, not as a broken tool', async () => {
        const startTime = slotFor(40);
        const first = await post('book-appointment', keyA, {
          phoneNumber: '+2348055501001',
          serviceName: 'Consultation',
          startTime,
          staffName: 'Dr Clash',
        }).expect(201);
        expect(first.body.ok).toBe(true);

        const clash = await post('book-appointment', keyA, {
          phoneNumber: '+2348055501002',
          serviceName: 'Consultation',
          startTime,
          staffName: 'Dr Clash',
        }).expect(201);

        expect(clash.body.data.reason).toBe('slot_unavailable');
        expect(clash.body.speak).toMatch(/taken|available/i);
        // The customer should be offered another time, not a human.
        expect(clash.body.handoff).toBeFalsy();
        expect(clash.body.speak).not.toMatch(/could not complete|put you through/i);
      });

      /**
       * The read-then-write race, closed at the database.
       *
       * The application check passes for every request in flight before any of
       * them commits, so only an EXCLUDE constraint can settle it. The original
       * constraint carried `WHERE "staffName" IS NOT NULL` — because `= `never
       * matches two NULLs — and the agent's book-appointment tool DOES NOT
       * EXPOSE staffName at all. So every booking an agent makes was covered by
       * nothing: eight simultaneous requests produced eight CONFIRMED bookings
       * in one slot, each caller told their appointment was made.
       *
       * Needs the SQL-only migrations applied (CI does this); without them the
       * assertion below fails loudly rather than passing on the racy check.
       */
      it.each([
        ['with a named staff member', 'Dr Concurrent'],
        ['with no staff assigned — what the agent always sends', undefined],
        /*
         * 60s, because jest's default 5s cannot cover what this test asks for.
         *
         * Eight writers contend on one gist exclusion key, and PostgreSQL only
         * notices a deadlock after `deadlock_timeout` — one second per
         * collision, on the server, before our own jittered retry even starts.
         * A CI run of this pair logged fourteen deadlock aborts across twelve
         * seconds. The unstaffed variant is the worse of the two by design:
         * every row keys on COALESCE("staffName", ''), so all eight collide on
         * the same value rather than spreading.
         *
         * It passed on faster runners by luck. Raising the timeout does not
         * weaken the assertions — one CONFIRMED row, seven honest refusals —
         * it stops a slow runner reporting them as a double-booking bug.
         */
      ])('gives one caller the slot when eight ask at once, %s', async (_label, staffName) => {
        const startTime = slotFor(60 + (staffName ? 0 : 1));

        const results = await Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            post('book-appointment', keyA, {
              phoneNumber: `+23480555200${i}`,
              serviceName: 'Consultation',
              startTime,
              ...(staffName ? { staffName } : {}),
            })
          )
        );

        const confirmed = results.filter((r) => r.body.ok === true);
        expect(confirmed).toHaveLength(1);

        // And the seven who lost are told the truth, not that the tool broke.
        const refused = results.filter((r) => r.body.data?.reason === 'slot_unavailable');
        expect(refused).toHaveLength(7);
        for (const r of refused) expect(r.body.handoff).toBeFalsy();

        const rows = await prisma.booking.count({
          where: {
            organizationId: orgA,
            startTime: new Date(startTime),
            status: { in: ['CONFIRMED', 'RESCHEDULED'] },
          },
        });
        expect(rows).toBe(1);
      }, 60_000);

      it('does not swallow a genuine failure as a taken slot', async () => {
        // The mirror of the bug above, and it survived the first mutation run:
        // a check that answered "clash" to everything would tell a customer
        // their time was taken when the truth is the tool broke. An unparseable
        // date is a 400, not a 409, and must still degrade honestly.
        const res = await post('book-appointment', keyA, {
          phoneNumber: '+2348055501009',
          serviceName: 'Consultation',
          startTime: 'the 45th of Neveruary',
        }).expect(201);

        expect(res.body.data.reason).not.toBe('slot_unavailable');
        expect(res.body.speak).not.toMatch(/taken|another time/i);
        expect(res.body.handoff).toBe(true);
      });

      it('is reported as unavailable when rescheduling onto it too', async () => {
        const taken = slotFor(41);
        await post('book-appointment', keyA, {
          phoneNumber: '+2348055501003',
          serviceName: 'Consultation',
          startTime: taken,
          staffName: 'Dr Clash2',
        }).expect(201);
        await post('book-appointment', keyA, {
          phoneNumber: '+2348055501004',
          serviceName: 'Checkup',
          startTime: slotFor(42),
          staffName: 'Dr Clash2',
        }).expect(201);

        const clash = await post('reschedule-booking', keyA, {
          phoneNumber: '+2348055501004',
          newStartTime: taken,
        }).expect(201);

        expect(clash.body.data.reason).toBe('slot_unavailable');
        expect(clash.body.handoff).toBeFalsy();
        expect(clash.body.speak).not.toMatch(/could not complete|put you through/i);
      });
    });

    it('says it does not know rather than inventing an answer', async () => {
      const res = await post('search-knowledge', keyA, {
        query: 'what is the airspeed velocity of an unladen swallow',
      }).expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.source).toBe('none');
      expect(res.body.speak).toMatch(/don't have that detail/i);
    });

    it('reports no booking rather than fabricating one', async () => {
      const res = await post('check-booking', keyA, {
        phoneNumber: '+2340000000000',
      }).expect(201);

      expect(res.body.ok).toBe(true);
      expect(res.body.data.found).toBe(false);
    });
  });

  /**
   * The agent could not know what was free.
   *
   * It asked the caller to name a time, called book-appointment, and learned
   * the answer from an exclusion violation — a guess-and-retry loop on a live
   * call, while the orchestrator offered real openings on WhatsApp.
   */
  describe('availability', () => {
    it('returns real, future slots inside business hours', async () => {
      const res = await post('check-availability', keyA, { limit: 3 }).expect(201);

      expect(res.body.ok).toBe(true);
      const slots = res.body.data.slots;
      expect(slots.length).toBeGreaterThan(0);
      expect(slots.length).toBeLessThanOrEqual(3);

      for (const slot of slots) {
        const start = new Date(slot.startTime);
        expect(start.getTime()).toBeGreaterThan(Date.now());
        // Mon–Fri 08:00–18:00 West Africa Time.
        const watHour = (start.getUTCHours() + 1) % 24;
        const watDay = new Date(start.getTime() + 3600_000).getUTCDay();
        expect(watHour).toBeGreaterThanOrEqual(8);
        expect(watHour).toBeLessThan(18);
        expect(watDay).not.toBe(0);
        expect(watDay).not.toBe(6);
        // A sentence the agent can read out, not a raw timestamp it would have
        // to format itself — and formatting a time is a thing models get wrong.
        expect(slot.label).toBeTruthy();
      }
      expect(res.body.speak).toContain(slots[0].label);
    });

    it('never offers a slot that is already booked', async () => {
      const phone = `+2349${Date.now().toString().slice(-9)}`;

      const free = await post('check-availability', keyA, { limit: 1 }).expect(201);
      const target = free.body.data.slots[0];

      await post('book-appointment', keyA, {
        phoneNumber: phone,
        serviceName: 'Blocker',
        startTime: target.startTime,
        durationMinutes: 30,
      }).expect(201);

      const after = await post('check-availability', keyA, { limit: 5 }).expect(201);
      const offered = after.body.data.slots.map((sl: any) => sl.startTime);
      expect(offered).not.toContain(target.startTime);

      await post('cancel-booking', keyA, { phoneNumber: phone, reason: 'cleanup' });
    });

    it('is scoped to the caller\'s own tenant', async () => {
      const phone = `+2349${Date.now().toString().slice(-9)}`;
      const free = await post('check-availability', keyA, { limit: 1 }).expect(201);
      const target = free.body.data.slots[0];

      // Org A fills the slot; org B's diary is untouched by that.
      await post('book-appointment', keyA, {
        phoneNumber: phone,
        serviceName: 'Tenant A only',
        startTime: target.startTime,
        durationMinutes: 30,
      }).expect(201);

      const bView = await post('check-availability', keyB, { limit: 5 }).expect(201);
      expect(bView.body.data.slots.map((sl: any) => sl.startTime)).toContain(target.startTime);

      await post('cancel-booking', keyA, { phoneNumber: phone, reason: 'cleanup' });
    });
  });

  describe('booking round trip', () => {
    it('books, finds and cancels an appointment for the caller', async () => {
      const phone = `+2349${Date.now().toString().slice(-9)}`;
      const startTime = new Date(Date.now() + 7 * 24 * 3600_000).toISOString();

      const booked = await post('book-appointment', keyA, {
        phoneNumber: phone,
        fullName: 'Round Trip',
        serviceName: 'Consultation',
        startTime,
        durationMinutes: 30,
      }).expect(201);

      expect(booked.body.ok).toBe(true);
      expect(booked.body.speak).toContain('Consultation');
      expect(booked.body.data.bookingId).toBeTruthy();

      const found = await post('check-booking', keyA, { phoneNumber: phone }).expect(201);
      expect(found.body.data.found).toBe(true);

      // Another tenant must not see it.
      const otherTenant = await post('check-booking', keyB, { phoneNumber: phone }).expect(201);
      expect(otherTenant.body.data.found).toBe(false);

      const cancelled = await post('cancel-booking', keyA, {
        phoneNumber: phone,
        reason: 'test',
      }).expect(201);
      expect(cancelled.body.ok).toBe(true);
    }, 30_000);
  });
});
