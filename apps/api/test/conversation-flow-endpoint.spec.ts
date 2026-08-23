/**
 * GET /api/conversations/:id/flow — what the customer is part-way through.
 *
 * Asking for a person always beats a flow, which is what stops a form being a
 * trap. But `flowState` lived on the Conversation row and never left the
 * orchestrator, so a citizen six answers into PLASCHEMA enrollment who asked
 * for help reached an operator who could see the message thread and nothing
 * else — and was asked their name, age, address and LGA a second time.
 *
 * Pinned against the real database rather than a mock, because the two things
 * that can go wrong here are both in the query: reading a JSON column back
 * into the shape the describer expects, and scoping by organization. A mocked
 * Prisma would assert the mock on both counts.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { createTenant } from './support/tenant';

describe('GET /api/conversations/:id/flow', () => {
  let app: INestApplication;
  let orgId: string;
  let token: string;
  let otherOrgId: string;
  let otherToken: string;

  jest.setTimeout(60000);

  /** A conversation carrying `flowState`, as the orchestrator would leave it. */
  const seed = async (organizationId: string, phoneNumber: string, flowState: any) => {
    const contact = await prisma.contact.create({
      data: { organizationId, phoneNumber, fullName: 'Half Way Through' },
    });
    return prisma.conversation.create({
      data: { organizationId, contactId: contact.id, channel: 'WHATSAPP', flowState },
    });
  };

  const halfFilledEnrollment = () => ({
    flow: 'plaschema-enrollment',
    collected: {
      fullName: 'Amina Yusuf',
      ageOrDob: '34 years',
      residentialAddress: '12 Ahmadu Bello Way, Jos',
      lga: 'Jos North',
    },
    awaiting: 'planType',
    confirming: false,
    startedAt: Date.now() - 120_000,
    updatedAt: Date.now() - 30_000,
  });

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    // Seeded, not registered — see the note in ./support/tenant.
    ({ token, orgId } = await createTenant(app, 'flow-a'));
    ({ token: otherToken, orgId: otherOrgId } = await createTenant(app, 'flow-b'));
  }, 60_000);

  afterAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await prisma.organization.delete({ where: { id } }).catch(() => {});
    }
    await app?.close();
  }, 60_000);

  it('gives the operator the answers already collected and the pending question', async () => {
    const conv = await seed(orgId, '+2348030008101', halfFilledEnrollment());

    const res = await request(app.getHttpServer())
      .get(`/api/conversations/${conv.id}/flow`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.title).toBe('PLASCHEMA enrollment');
    expect(res.body.answered.map((a: any) => [a.label, a.value])).toEqual([
      ['Full name', 'Amina Yusuf'],
      ['Age / date of birth', '34 years'],
      ['Residential address', '12 Ahmadu Bello Way, Jos'],
      ['LGA', 'Jos North'],
    ]);
    expect(res.body.awaiting).toEqual({ name: 'planType', label: 'Plan' });
    expect(res.body.stale).toBe(false);
  });

  it('answers null for a conversation with no flow, rather than 404', async () => {
    // "This customer is not filling anything in" is a normal answer to this
    // question — a 404 would make the panel look broken on most conversations.
    const conv = await seed(orgId, '+2348030008102', undefined);

    const res = await request(app.getHttpServer())
      .get(`/api/conversations/${conv.id}/flow`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body).toEqual({});  // JSON null serialises to an empty body
  });

  it('refuses another organization the flow state of a conversation it cannot see', async () => {
    const conv = await seed(orgId, '+2348030008103', halfFilledEnrollment());

    await request(app.getHttpServer())
      .get(`/api/conversations/${conv.id}/flow`)
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(404);
  });

  it('requires authentication — a conversation id is not authority to read one', async () => {
    const conv = await seed(orgId, '+2348030008104', halfFilledEnrollment());

    await request(app.getHttpServer())
      .get(`/api/conversations/${conv.id}/flow`)
      .expect(401);
  });

  it('reports an expired form as expired, so nobody expects the AI to resume it', async () => {
    const old = Date.now() - 2 * 60 * 60 * 1000;
    const conv = await seed(orgId, '+2348030008105', {
      ...halfFilledEnrollment(),
      startedAt: old,
      updatedAt: old,
    });

    const res = await request(app.getHttpServer())
      .get(`/api/conversations/${conv.id}/flow`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.stale).toBe(true);
  });

  it('never returns the seeded lists the slots ask their questions from', async () => {
    // `collected` carries JSON blobs of offered times under underscored keys.
    // They are not answers, and an operator does not want to read them.
    const conv = await seed(orgId, '+2348030008106', {
      flow: 'book-appointment',
      collected: {
        _slots: JSON.stringify([{ startIso: 'x', endIso: 'y', label: 'Monday, 24 August at 09:00' }]),
        _service: 'Dental Check-up',
        when: '0',
      },
      awaiting: null,
      confirming: true,
      startedAt: Date.now() - 60_000,
      updatedAt: Date.now() - 10_000,
    });

    const res = await request(app.getHttpServer())
      .get(`/api/conversations/${conv.id}/flow`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(JSON.stringify(res.body)).not.toContain('startIso');
    expect(res.body.answered).toHaveLength(1);
    // And the stored index is rendered as the time the customer actually chose.
    expect(res.body.answered[0].value).toBe('Monday, 24 August at 09:00');
  });
});
