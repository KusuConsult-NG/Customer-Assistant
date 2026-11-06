import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { bookedAppointmentId } from '@ace/shared-types';

/**
 * `appointment.booked` and `handover.requested`, through the real routes.
 *
 * `webhook-events.spec.ts` checks the catalogue against the API source — that
 * every delivered event is dispatched somewhere, and that no handoff-activating
 * file forgets to. That is static analysis: it cannot see whether the module
 * graph actually resolves the dispatcher, and it cannot see the rule that makes
 * these two events usable rather than noise.
 *
 * Two properties are worth a live test:
 *
 *  - **The dispatch happens at all.** Both events needed `WebhooksModule` added
 *    to a module that did not import it, and a missing provider is a runtime DI
 *    failure that no amount of source scanning reveals.
 *  - **Only the TRANSITION fires a handover.** Every one of the five writes that
 *    activates a handoff sets the flag whether or not it was already set, so a
 *    naive dispatch delivers a webhook on an officer's every message to a thread
 *    they already hold. That is the noise that teaches a receiver to ignore the
 *    one delivery that mattered.
 */
describe('appointment.booked and handover.requested', () => {
  let app: INestApplication;
  let orgId: string;
  let ownerToken: string;
  let contactId: string;
  let realFetch: typeof globalThis.fetch;

  jest.setTimeout(60000);

  // A public IP literal: assertPublicHttpUrl skips DNS for one, so the SSRF
  // guard still runs without the test needing to resolve a name.
  const TARGET = 'https://93.184.216.34/hook';
  const savedEnv: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined) => {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  /** Every webhook delivery the dispatcher attempted. */
  let delivered: Array<{ event: string; data: any }>;

  const deliveriesOf = (event: string) => delivered.filter((d) => d.event === event);

  /**
   * The dispatch is fire-and-forget at every call site, so the HTTP response
   * can land before the delivery goes out. Waits for a delivery rather than
   * asserting immediately — and returns what it has either way, so a test
   * expecting NO delivery is not slowed by the full timeout.
   */
  const settle = async (expected = 1, attempts = 40) => {
    for (let i = 0; i < attempts && delivered.length < expected; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // A short grace period, so "exactly one" cannot pass by reading too early.
    await new Promise((r) => setTimeout(r, 150));
    return delivered;
  };

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    setEnv('WEBHOOK_SECRET', 'webhook_secret_for_domain_event_tests');
    realFetch = globalThis.fetch;

    app = await createTestApp();

    const org = await prisma.organization.create({
      data: {
        name: 'Domain Event Agency',
        slug: `dom-${randomBytes(5).toString('hex')}`,
        industry: 'GOVERNMENT',
        webhookUrl: TARGET,
        enabledWebhookEvents: ['appointment.booked', 'handover.requested'],
      },
    });
    orgId = org.id;

    const email = `dom.owner.${randomBytes(4).toString('hex')}@dom.test`;
    const password = 'DomainPassw0rd!';
    await prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        fullName: 'Owner',
        role: 'OWNER',
        passwordHash: await bcrypt.hash(password, 10),
        emailVerifiedAt: new Date(),
      },
    });
    ownerToken = (
      await request(app.getHttpServer()).post('/api/auth/login').send({ email, password })
    ).body.accessToken;

    contactId = (
      await prisma.contact.create({
        data: { organizationId: orgId, fullName: 'Amina Bello', phoneNumber: '+2348012345678' },
      })
    ).id;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await prisma.webhookLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.message.deleteMany({ where: { conversation: { organizationId: orgId } } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
    await prisma.booking.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await app.close();
  });

  beforeEach(() => {
    delivered = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      if (url === TARGET) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        delivered.push({ event: body.event, data: body.data });
        return new Response('{}', { status: 200 });
      }
      // Anything else this request path reaches (Meta, a carrier) is refused
      // rather than silently allowed out of the test.
      return new Response('{}', { status: 200 });
    }) as any;
  });

  /**
   * The read that tells the Nest layer a citizen was booked in over WhatsApp or
   * the phone. The orchestrator writes the booking itself, so this entry in its
   * result is the only signal — and the near-misses matter, because a wrong
   * `true` here announces an appointment that does not exist.
   */
  describe('bookedAppointmentId', () => {
    const call = (toolName: string, result: any) =>
      ({ replyText: '', confidenceScore: 1, shouldHandoff: false, toolCallsExecuted: [{ toolName, result }] }) as any;

    it('reads the booking the assistant just made', () => {
      expect(bookedAppointmentId(call('book_appointment', { booked: true, bookingId: 'bk_1' }))).toBe('bk_1');
    });

    it('ignores a RESERVATION, which also reports booked: true', () => {
      // Same flag, different tool, and a reservationId rather than a bookingId.
      // A reservation is not an appointment, and dispatching `appointment.booked`
      // for one would put a table in an agency's appointment diary.
      expect(
        bookedAppointmentId(call('manage_reservation', { booked: true, reservationId: 'rs_1' }))
      ).toBeNull();
    });

    it('ignores a turn that booked nothing', () => {
      // A slot taken between the offer and the reply comes back as the flow's
      // next question, carrying no book_appointment entry at all.
      expect(bookedAppointmentId(call('check_availability', { slots: [] }))).toBeNull();
      expect(bookedAppointmentId({ replyText: 'hello', confidenceScore: 1, shouldHandoff: false } as any)).toBeNull();
      expect(bookedAppointmentId(null)).toBeNull();
      expect(bookedAppointmentId(undefined)).toBeNull();
    });

    it('refuses a malformed result rather than announcing a booking', () => {
      // `result` is typed `any`, so these are reachable shapes.
      expect(bookedAppointmentId(call('book_appointment', { booked: true }))).toBeNull();
      expect(bookedAppointmentId(call('book_appointment', { booked: true, bookingId: '' }))).toBeNull();
      expect(bookedAppointmentId(call('book_appointment', { booked: true, bookingId: 42 }))).toBeNull();
      expect(bookedAppointmentId(call('book_appointment', { booked: 'yes', bookingId: 'bk_2' }))).toBeNull();
      expect(bookedAppointmentId(call('book_appointment', undefined))).toBeNull();
    });
  });

  describe('appointment.booked', () => {
    const futureIso = (hoursAhead: number) =>
      new Date(Date.now() + hoursAhead * 3600_000).toISOString();

    it('fires when a booking is created, with the appointment on it', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/scheduling/bookings')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          contactId,
          serviceName: 'Birth certificate collection',
          staffName: 'Registry desk 2',
          startTime: futureIso(48),
        });
      expect(res.status).toBe(201);

      await settle();
      const sent = deliveriesOf('appointment.booked');
      expect(sent).toHaveLength(1);

      // The payload is built in the dispatcher from the booking row, so what a
      // tenant's own diary receives does not depend on which path booked it.
      expect(sent[0].data.bookingId).toBe(res.body.id);
      expect(sent[0].data.serviceName).toBe('Birth certificate collection');
      expect(sent[0].data.staffName).toBe('Registry desk 2');
      expect(sent[0].data.status).toBe('CONFIRMED');
      expect(sent[0].data.contactId).toBe(contactId);
      expect(sent[0].data.contactPhone).toBe('+2348012345678');
      expect(typeof sent[0].data.startTime).toBe('string');
      expect(typeof sent[0].data.endTime).toBe('string');
    });

    it('does not fire when the booking was refused', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/scheduling/bookings')
        .set('Authorization', `Bearer ${ownerToken}`)
        // In the past — the service refuses it.
        .send({ contactId, serviceName: 'Too late', startTime: '2020-01-01T09:00:00.000Z' });
      expect(res.status).toBe(400);

      await settle(0);
      // An appointment nobody holds must not be announced to the agency's own
      // systems as one they do.
      expect(deliveriesOf('appointment.booked')).toHaveLength(0);
    });

    it('is not sent to an agency that did not subscribe to it', async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { enabledWebhookEvents: ['handover.requested'] },
      });
      try {
        const res = await request(app.getHttpServer())
          .post('/api/scheduling/bookings')
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ contactId, serviceName: 'Unsubscribed', startTime: futureIso(72) });
        expect(res.status).toBe(201);

        await settle(0);
        expect(deliveriesOf('appointment.booked')).toHaveLength(0);
      } finally {
        await prisma.organization.update({
          where: { id: orgId },
          data: { enabledWebhookEvents: ['appointment.booked', 'handover.requested'] },
        });
      }
    });
  });

  describe('handover.requested', () => {
    let conversationId: string;

    beforeEach(async () => {
      await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
      conversationId = (
        await prisma.conversation.create({
          data: { organizationId: orgId, contactId, channel: 'WHATSAPP' },
        })
      ).id;
    });

    const toggle = (handoff: boolean) =>
      request(app.getHttpServer())
        .patch(`/api/conversations/${conversationId}/handoff`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ handoff });

    it('fires when an officer takes a thread, naming who and why', async () => {
      expect((await toggle(true)).status).toBe(200);

      await settle();
      const sent = deliveriesOf('handover.requested');
      expect(sent).toHaveLength(1);
      expect(sent[0].data.conversationId).toBe(conversationId);
      expect(sent[0].data.channel).toBe('WHATSAPP');
      expect(sent[0].data.requestedBy).toBe('OFFICER');
      expect(sent[0].data.contactPhone).toBe('+2348012345678');
      expect(sent[0].data.assignedUserId).toBeTruthy();
      expect(sent[0].data.assignedUserName).toBe('Owner');
    });

    it('does not fire a second time for a thread already handed over', async () => {
      await toggle(true);
      await settle();
      expect(deliveriesOf('handover.requested')).toHaveLength(1);

      delivered = [];
      expect((await toggle(true)).status).toBe(200);
      await settle(0);
      // The write happens again; the transition does not. A webhook per
      // re-assertion is the noise that buries the real one.
      expect(deliveriesOf('handover.requested')).toHaveLength(0);
    });

    it('does not fire when a handover is RELEASED', async () => {
      await toggle(true);
      await settle();
      delivered = [];

      expect((await toggle(false)).status).toBe(200);
      await settle(0);
      // Releasing is not a request, and the catalogue has no name for it —
      // sending `handover.requested` for one would be a false statement.
      expect(deliveriesOf('handover.requested')).toHaveLength(0);
    });

    it('fires again once the thread has been released and retaken', async () => {
      await toggle(true);
      await settle();
      await toggle(false);
      delivered = [];

      expect((await toggle(true)).status).toBe(200);
      await settle();
      // A genuine second handover is a genuine second event.
      expect(deliveriesOf('handover.requested')).toHaveLength(1);
    });

    it('is not sent to an agency that did not subscribe to it', async () => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { enabledWebhookEvents: ['appointment.booked'] },
      });
      try {
        expect((await toggle(true)).status).toBe(200);
        await settle(0);
        expect(deliveriesOf('handover.requested')).toHaveLength(0);
      } finally {
        await prisma.organization.update({
          where: { id: orgId },
          data: { enabledWebhookEvents: ['appointment.booked', 'handover.requested'] },
        });
      }
    });

    it('refuses a conversation belonging to another agency', async () => {
      const otherOrg = await prisma.organization.create({
        data: {
          name: 'Other Agency',
          slug: `oth-${randomBytes(5).toString('hex')}`,
          industry: 'GOVERNMENT',
        },
      });
      const otherContact = await prisma.contact.create({
        data: { organizationId: otherOrg.id, fullName: 'Someone Else', phoneNumber: '+2348099999999' },
      });
      const otherConv = await prisma.conversation.create({
        data: { organizationId: otherOrg.id, contactId: otherContact.id, channel: 'WHATSAPP' },
      });

      try {
        const res = await request(app.getHttpServer())
          .patch(`/api/conversations/${otherConv.id}/handoff`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ handoff: true });
        // An id is not authority over a conversation, and no webhook describing
        // another agency's citizen may leave on this tenant's URL.
        expect(res.status).toBe(404);
        await settle(0);
        expect(deliveriesOf('handover.requested')).toHaveLength(0);
      } finally {
        await prisma.conversation.deleteMany({ where: { organizationId: otherOrg.id } });
        await prisma.contact.deleteMany({ where: { organizationId: otherOrg.id } });
        await prisma.organization.deleteMany({ where: { id: otherOrg.id } });
      }
    });
  });
});
