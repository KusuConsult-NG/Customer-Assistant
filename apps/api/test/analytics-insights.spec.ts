/**
 * Operational analytics — numbers a staffing decision will be made on.
 *
 * Every assertion is against an exact figure derived from seeded fixtures,
 * because an aggregate that is merely "some number" tests nothing: the wrong
 * GROUP BY, a missing tenant filter, or a timezone slip all still produce
 * numbers. The cross-tenant fixtures exist for the same reason — an analytics
 * endpoint that leaks another organization's counts is a tenancy hole wearing
 * a dashboard.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';

describe('GET /api/analytics/insights', () => {
  let app: INestApplication;
  let orgId: string;
  let otherOrgId: string;
  let token: string;

  jest.setTimeout(60000);

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    // Fixtures go straight into the database rather than through
    // POST /api/auth/register: that endpoint is throttled to 5/min per IP as
    // an anti-abuse control, the whole CI suite shares one IP, and the sixth
    // registering spec in a minute gets a 429 that has nothing to do with what
    // it tests. Login carries a 60/min budget, so the token still comes from
    // the real auth path.
    const email = `insights.${randomBytes(4).toString('hex')}@insights.test`;
    const password = 'InsightsPassw0rd!';
    const insightsOrg = await prisma.organization.create({
      data: { name: 'Insights Test Ltd', slug: `insights-test-${randomBytes(4).toString('hex')}`, industry: 'CLINIC' },
    });
    orgId = insightsOrg.id;
    await prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        fullName: 'Insights Tester',
        role: 'OWNER',
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
    token = login.body.accessToken;
    expect(token).toBeTruthy();

    // A second organization with lookalike data. None of it may appear.
    const other = await prisma.organization.create({
      data: { name: 'Other Tenant', slug: `insights-other-${randomBytes(4).toString('hex')}`, industry: 'OTHER' },
    });
    otherOrgId = other.id;

    // ── Fixtures for OUR org ────────────────────────────────────────────────
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber: '+2348030009901', fullName: 'Fixture Customer', preferredLanguage: 'ha' },
    });
    await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber: '+2348030009902', fullName: 'Second Customer', preferredLanguage: 'ha' },
    });
    await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber: '+2348030009903', fullName: 'Third Customer' }, // language unknown
    });

    const conv = await prisma.conversation.create({
      data: {
        organizationId: orgId, contactId: contact.id, channel: 'WHATSAPP',
        isHumanHandoffActive: true, handoffReason: 'TOOL_FAILURE',
      },
    });
    // 3 labelled AI replies: 2× BOOK_APPOINTMENT, 1× PROVIDE_PAYMENT_GUIDANCE —
    // plus one customer message and one UNlabelled AI reply that must not count.
    await prisma.message.createMany({
      data: [
        { conversationId: conv.id, sender: 'CUSTOMER', content: 'i want to book', sentAt: hoursAgo(30) },
        { conversationId: conv.id, sender: 'AI', content: 'booked', sentAt: hoursAgo(30), metadata: { intent: 'BOOK_APPOINTMENT' } },
        { conversationId: conv.id, sender: 'AI', content: 'booked again', sentAt: hoursAgo(29), metadata: { intent: 'BOOK_APPOINTMENT' } },
        { conversationId: conv.id, sender: 'AI', content: 'pay like this', sentAt: hoursAgo(5), metadata: { intent: 'PROVIDE_PAYMENT_GUIDANCE' } },
        { conversationId: conv.id, sender: 'AI', content: 'unlabelled legacy reply', sentAt: hoursAgo(4) },
      ],
    });

    // Bookings: 2 CONFIRMED (one tomorrow → upcoming week), 1 CANCELLED.
    const tomorrow = new Date(Date.now() + 24 * 3600_000);
    await prisma.booking.createMany({
      data: [
        { organizationId: orgId, contactId: contact.id, serviceName: 'Enrollment Check', startTime: tomorrow, endTime: new Date(tomorrow.getTime() + 1800_000), status: 'CONFIRMED' },
        { organizationId: orgId, contactId: contact.id, serviceName: 'Enrollment Check', startTime: hoursAgo(-200), endTime: hoursAgo(-200.5), status: 'CONFIRMED' },
        { organizationId: orgId, contactId: contact.id, serviceName: 'Consultation', startTime: hoursAgo(-300), endTime: hoursAgo(-300.5), status: 'CANCELLED' },
      ],
    });

    // Calls: two the platform could not connect, one that went through. Only
    // the failures count toward callsNotConnected.
    await prisma.callLog.createMany({
      data: [
        { organizationId: orgId, callSid: `CA-fail-1-${randomBytes(3).toString('hex')}`, fromNumber: '+2348030009901', toNumber: '+2348000000001', status: 'FAILED', durationSeconds: 0, startedAt: hoursAgo(3) },
        { organizationId: orgId, callSid: `CA-fail-2-${randomBytes(3).toString('hex')}`, fromNumber: '+2348030009902', toNumber: '+2348000000001', status: 'FAILED', durationSeconds: 0, startedAt: hoursAgo(2) },
        { organizationId: orgId, callSid: `CA-ok-1-${randomBytes(3).toString('hex')}`, fromNumber: '+2348030009903', toNumber: '+2348000000001', status: 'COMPLETED', durationSeconds: 65, startedAt: hoursAgo(1) },
      ],
    });

    // The other tenant's failure must not be counted here either.
    await prisma.callLog.create({
      data: { organizationId: otherOrgId, callSid: `CA-other-${randomBytes(3).toString('hex')}`, fromNumber: '+2348030009999', toNumber: '+2348000000002', status: 'FAILED', durationSeconds: 0, startedAt: hoursAgo(2) },
    });

    // Tickets: one OPEN HIGH, one refund (REF- prefix).
    await prisma.ticket.createMany({
      data: [
        { organizationId: orgId, contactId: contact.id, ticketNumber: `TCK-INS-${randomBytes(3).toString('hex')}`, subject: 'complaint', description: 'x', status: 'OPEN', priority: 'HIGH', updatedAt: new Date() },
        { organizationId: orgId, contactId: contact.id, ticketNumber: `REF-BK-INS-${randomBytes(3).toString('hex')}`, subject: 'Refund Request', description: 'x', status: 'OPEN', priority: 'HIGH', updatedAt: new Date() },
      ],
    });

    // ── Lookalike fixtures for the OTHER org — must never surface ───────────
    const otherContact = await prisma.contact.create({
      data: { organizationId: otherOrgId, phoneNumber: '+2348030009999', fullName: 'Stranger', preferredLanguage: 'ig' },
    });
    const otherConv = await prisma.conversation.create({
      data: { organizationId: otherOrgId, contactId: otherContact.id, channel: 'WHATSAPP', isHumanHandoffActive: true, handoffReason: 'CUSTOMER_REQUEST' },
    });
    await prisma.message.create({
      data: { conversationId: otherConv.id, sender: 'AI', content: 'other tenant reply', sentAt: hoursAgo(3), metadata: { intent: 'REQUEST_REFUND' } },
    });
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => {});
    await app?.close();
  });

  it('aggregates intents from AI reply metadata, exactly', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/analytics/insights?period=7d')
      .set('Authorization', `Bearer ${token}`).expect(200);

    expect(res.body.intentDistribution).toEqual([
      { intent: 'BOOK_APPOINTMENT', count: 2 },
      { intent: 'PROVIDE_PAYMENT_GUIDANCE', count: 1 },
    ]);
    // The other tenant's REQUEST_REFUND must not leak in.
    const intents = res.body.intentDistribution.map((i: any) => i.intent);
    expect(intents).not.toContain('REQUEST_REFUND');
  });

  it('reports handoff reasons for this organization only', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/analytics/insights?period=7d')
      .set('Authorization', `Bearer ${token}`).expect(200);

    expect(res.body.handoffReasons).toEqual([{ reason: 'TOOL_FAILURE', count: 1 }]);
  });

  it('counts the booking funnel and the week ahead', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/analytics/insights?period=7d')
      .set('Authorization', `Bearer ${token}`).expect(200);

    const byStatus = Object.fromEntries(res.body.bookingFunnel.byStatus.map((s: any) => [s.status, s.count]));
    expect(byStatus.CONFIRMED).toBe(2);
    expect(byStatus.CANCELLED).toBe(1);

    expect(res.body.bookingFunnel.topServices[0]).toEqual({ serviceName: 'Enrollment Check', count: 2 });

    // Seven days, and exactly one booking lands in them (tomorrow's).
    expect(res.body.bookingFunnel.upcomingWeek).toHaveLength(7);
    const totalUpcoming = res.body.bookingFunnel.upcomingWeek.reduce((s: number, d: any) => s + d.count, 0);
    expect(totalUpcoming).toBe(1);
  });

  it('counts tickets, refunds and languages honestly', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/analytics/insights?period=7d')
      .set('Authorization', `Bearer ${token}`).expect(200);

    expect(res.body.ticketFlow.opened).toBe(2);
    expect(res.body.ticketFlow.refundRequests).toBe(1);
    expect(res.body.ticketFlow.openByPriority).toEqual([{ priority: 'HIGH', count: 2 }]);

    // 2× Hausa, 1× unknown — and the other tenant's Igbo speaker absent.
    expect(res.body.languages).toEqual([
      { language: 'ha', count: 2 },
      { language: 'unknown', count: 1 },
    ]);
  });

  it('puts the day of activity in the volume trend, in the right column', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/analytics/insights?period=7d')
      .set('Authorization', `Bearer ${token}`).expect(200);

    const totals = res.body.volumeTrend.reduce(
      (acc: any, d: any) => ({
        customer: acc.customer + d.customerMessages,
        ai: acc.ai + d.aiMessages,
      }),
      { customer: 0, ai: 0 }
    );
    expect(totals.customer).toBe(1);
    // All four AI messages count as volume — labelled or not.
    expect(totals.ai).toBe(4);
  });

  it('counts callers who could not get through, for this tenant only', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/analytics/insights?period=7d')
      .set('Authorization', `Bearer ${token}`).expect(200);

    // Two failed, and neither the completed call nor the other tenant's
    // failure is included. This is the number that decides whether the plan
    // needs more concurrent capacity, so an inflated one is not a harmless
    // rounding error.
    expect(res.body.callsNotConnected).toBe(2);
  });

  it('refuses an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/analytics/insights').expect(401);
  });
});
