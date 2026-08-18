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

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
    await app?.close();
  });

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
