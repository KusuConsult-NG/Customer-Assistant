/**
 * Service-standards report (PRD §16). Pinned: it counts what happened in THIS
 * agency only, reports overdue work, and the CSV carries the same figures.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';

describe('Service standards report', () => {
  let app: INestApplication;
  let t: TestTenant;
  let other: TestTenant;
  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    app = await createTestApp();
    t = await createTenant(app, 'standards', { role: 'ADMIN', industry: 'GOVERNMENT' });
    other = await createTenant(app, 'standards-other', { role: 'ADMIN' });
    const c = await prisma.contact.create({ data: { organizationId: t.orgId, fullName: 'C', phoneNumber: `+23480${randomBytes(4).readUInt32BE(0).toString().slice(0, 8).padStart(8, '2')}` } });
    const mk = (n: string, over: Record<string, unknown>) =>
      prisma.ticket.create({ data: { organizationId: t.orgId, contactId: c.id, ticketNumber: `SS-${n}-${randomBytes(3).toString('hex')}`, subject: 's', description: 'd', ...over } });
    await mk('a', { category: 'water', lga: 'Jos South', dueAt: new Date(Date.now() - 86_400_000) });
    await mk('b', { category: 'roads', lga: 'Bokkos', caseStage: 'RESOLVED', resolvedAt: new Date() });
    const cb = { organizationId: t.orgId, contactId: c.id, phoneNumber: '+2348030000000', promisedText: 'x' };
    await prisma.callbackRequest.create({ data: { ...cb, reason: 'EMERGENCY REPORTED — fire', dueAt: new Date(Date.now() - 2 * 3_600_000), status: 'DUE' } });
    await prisma.callbackRequest.create({ data: { ...cb, reason: 'pension', dueAt: new Date(), status: 'COMPLETED' } });
  });

  afterAll(async () => {
    await prisma.callbackRequest.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.ticket.deleteMany({ where: { organizationId: t.orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: t.orgId } });
    await dropTenant(t?.orgId);
    await dropTenant(other?.orgId);
    await app?.close();
  });

  it('reports cases, callbacks and emergencies for this agency only', async () => {
    const r = await request(app.getHttpServer()).get('/api/analytics/service-standards?period=week').set('Authorization', `Bearer ${t.token}`).expect(200);
    expect(r.body.unavailable).toEqual([]);
    expect(r.body.cases).toMatchObject({ opened: 2, resolved: 1, overdueNow: 1 });
    expect(r.body.cases.byLga).toEqual({ 'Jos South': 1, Bokkos: 1 });
    expect(r.body.callbacks).toMatchObject({ promised: 2, kept: 1, keptPercent: 50, overOneHourLateNow: 1 });
    expect(r.body.emergencies.voice).toBe(1);
    expect(r.body.note).toMatch(/not a representative sample/);

    const theirs = await request(app.getHttpServer()).get('/api/analytics/service-standards').set('Authorization', `Bearer ${other.token}`).expect(200);
    expect(theirs.body.cases.opened).toBe(0);
  });

  it('offers the same figures as CSV', async () => {
    const r = await request(app.getHttpServer()).get('/api/analytics/service-standards.csv?period=month').set('Authorization', `Bearer ${t.token}`).expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text.split('\n')[0]).toBe('section,metric,value');
    expect(r.text).toContain('"cases","overdue_now","1"');
    expect(r.text).toContain('"callbacks","kept","1"');
  });
});
