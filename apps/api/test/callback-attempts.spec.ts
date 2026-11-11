/**
 * Officers keeping callback promises from their own phones (PRD §09).
 *
 * Pinned: every attempt is a ROW with a time, outcome and who made it; a
 * failed attempt retries on the back-off (or at the time agreed with the
 * citizen) and, at the limit, the promise becomes FAILED for a supervisor
 * rather than staying quietly pending; a wrong number is not rung again;
 * and a promise more than an hour late reads as escalated.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Callback attempts', () => {
  let app: INestApplication;
  let t: TestTenant;
  let contactId: string;
  jest.setTimeout(60000);

  const as = (m: 'get' | 'post' | 'patch', path: string) =>
    (request(app.getHttpServer()) as any)[m](path).set('Authorization', `Bearer ${t.token}`);

  const promise = async (over: Record<string, unknown> = {}) =>
    prisma.callbackRequest.create({
      data: {
        organizationId: t.orgId,
        contactId,
        phoneNumber: '+2348031234567',
        reason: 'Asked about pension arrears',
        promisedText: 'As soon as an officer is free',
        dueAt: new Date(),
        status: 'DUE',
        ...over,
      },
    });

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    app = await createTestApp();
    t = await createTenant(app, 'cb-attempts', { role: 'AGENT', industry: 'GOVERNMENT' });
    contactId = (
      await prisma.contact.create({
        data: { organizationId: t.orgId, fullName: 'Citizen', phoneNumber: `+23480${randomBytes(4).readUInt32BE(0).toString().slice(0, 8).padStart(8, '1')}` },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.callbackAttempt.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.callbackRequest.deleteMany({ where: { organizationId: t.orgId } });
    await dropTenant(t?.orgId);
    await app?.close();
  });

  it('records a missed attempt, retries later, and gives up at the limit', async () => {
    const cb = await promise();
    const first = await as('post', `/api/callbacks/${cb.id}/attempt`).send({ outcome: 'NO_ANSWER', note: 'rang twice' }).expect(201);
    expect(first.body).toMatchObject({ status: 'PENDING', attempts: 1 });
    expect(new Date(first.body.dueAt).getTime()).toBeGreaterThan(Date.now());

    const agreed = new Date(Date.now() + 3 * 3600_000).toISOString();
    const second = await as('post', `/api/callbacks/${cb.id}/attempt`).send({ outcome: 'BUSY', rescheduleTo: agreed }).expect(201);
    expect(second.body.dueAt).toBe(agreed);

    const third = await as('post', `/api/callbacks/${cb.id}/attempt`).send({ outcome: 'VOICEMAIL' }).expect(201);
    expect(third.body).toMatchObject({ status: 'FAILED', attempts: 3, dueAt: null });

    const log = await prisma.callbackAttempt.findMany({ where: { callbackId: cb.id }, orderBy: { createdAt: 'asc' } });
    expect(log.map((a) => a.outcome)).toEqual(['NO_ANSWER', 'BUSY', 'VOICEMAIL']);
    expect(log.every((a) => a.via === 'OWN_PHONE' && a.userId === t.userId)).toBe(true);
    const row = await prisma.callbackRequest.findUnique({ where: { id: cb.id } });
    expect(row!.assignedUserId).toBe(t.userId);
    expect(row!.failureReason).toMatch(/voicemail/);

    // Closed: no further attempts can be logged against it.
    await as('post', `/api/callbacks/${cb.id}/attempt`).send({ outcome: 'REACHED' }).expect(400);
  });

  it('closes on REACHED and never rings a wrong number again', async () => {
    const ok = await promise();
    await as('post', `/api/callbacks/${ok.id}/attempt`).send({ outcome: 'REACHED' }).expect(201);
    expect((await prisma.callbackRequest.findUnique({ where: { id: ok.id } }))!.status).toBe('COMPLETED');

    const wrong = await promise();
    const r = await as('post', `/api/callbacks/${wrong.id}/attempt`).send({ outcome: 'WRONG_NUMBER' }).expect(201);
    expect(r.body.status).toBe('FAILED');
    await as('post', `/api/callbacks/${wrong.id}/attempt`).send({ outcome: 'MAYBE' }).expect(400);
  });

  it('reschedules without spending an attempt, assigns, and flags over-an-hour-late as escalated', async () => {
    const late = await promise({ dueAt: new Date(Date.now() - 2 * 3600_000), status: 'PENDING' });
    const list = await as('get', '/api/callbacks').expect(200);
    const row = list.body.find((c: any) => c.id === late.id);
    expect(row).toMatchObject({ overdue: true, escalated: true });

    const when = new Date(Date.now() + 86_400_000).toISOString();
    await as('patch', `/api/callbacks/${late.id}/reschedule`).send({ dueAt: when, preferredTime: 'after 4pm' }).expect(200);
    await as('patch', `/api/callbacks/${late.id}/assign`).send({ userId: t.userId }).expect(200);
    const after = await prisma.callbackRequest.findUnique({ where: { id: late.id } });
    expect(after!.attempts).toBe(0);
    expect(after!.preferredTime).toBe('after 4pm');
    expect(after!.assignedUserId).toBe(t.userId);
    const relisted = (await as('get', '/api/callbacks').expect(200)).body.find((c: any) => c.id === late.id);
    expect(relisted.escalated).toBe(false);
  });
});
