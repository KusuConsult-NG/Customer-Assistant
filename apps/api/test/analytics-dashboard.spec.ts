/**
 * GET /api/analytics/dashboard — the figures on the home screen.
 *
 * The point of this suite is the difference between ZERO and UNKNOWN. Every
 * query in this service used to be wrapped in `.catch(() => 0)` inside a try
 * that logged and carried on, so a database that could not answer produced a
 * 200 with a full set of zeros, and the dashboard presented them as the state
 * of the agency: 0 citizens, 0 open tickets, ₦0. Officers make staffing and
 * follow-up decisions on this screen.
 *
 * It also pins the three things the payload was quietly wrong about: the
 * trend's day buckets (built in the server's timezone, which is UTC on
 * Render, for an agency on Africa/Lagos), the per-channel series (one
 * undifferentiated count drawn under a WhatsApp legend) and pipelineValue
 * (summed in JavaScript over every deal ever recorded).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import { AppModule } from '../src/app.module';
import { AnalyticsService } from '../src/analytics/analytics.service';
import { zonedDayKey, zonedWindow, zonedDayStart } from '../src/common/zoned-days';

describe('GET /api/analytics/dashboard', () => {
  let app: INestApplication;
  let orgId: string;
  let token: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';

    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();

    // Straight into the database: POST /api/auth/register is throttled to
    // 5/min per IP and the whole suite shares one IP in CI.
    const email = `dash.${randomBytes(4).toString('hex')}@dash.test`;
    const password = 'DashboardPassw0rd!';
    const org = await prisma.organization.create({
      data: {
        name: 'Dashboard Test Agency',
        slug: `dash-${randomBytes(4).toString('hex')}`,
        industry: 'OTHER',
        timezone: 'Africa/Lagos',
      },
    });
    orgId = org.id;
    await prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        fullName: 'Dashboard Tester',
        role: 'OWNER',
        passwordHash: await bcrypt.hash(password, 10),
      },
    });
    const login = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
    token = login.body.accessToken;
    expect(token).toBeTruthy();

    const contact = await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber: '+2348030007701', fullName: 'Dash Citizen' },
    });

    // One WhatsApp thread and one WEBCHAT thread, both created at 00:30 LAGOS
    // time today — which is 23:30 UTC YESTERDAY. Bucketed in the server's
    // timezone they land on the wrong day, and on the earliest day of a 7-day
    // window they fall outside it entirely.
    const { keys } = zonedWindow(7, 'Africa/Lagos');
    const todayLagos = keys[keys.length - 1];
    const halfPastMidnightLagos = new Date(zonedDayStart(todayLagos, 'Africa/Lagos').getTime() + 30 * 60_000);

    const wa = await prisma.conversation.create({
      data: { organizationId: orgId, contactId: contact.id, channel: 'WHATSAPP', createdAt: halfPastMidnightLagos },
    });
    await prisma.conversation.create({
      data: { organizationId: orgId, contactId: contact.id, channel: 'WEBCHAT', createdAt: halfPastMidnightLagos },
    });
    await prisma.message.createMany({
      data: [
        { conversationId: wa.id, sender: 'CUSTOMER', content: 'hello' },
        { conversationId: wa.id, sender: 'AI', content: 'hello back' },
      ],
    });

    await prisma.callLog.create({
      data: {
        organizationId: orgId,
        contactId: contact.id,
        callSid: `CA${randomBytes(8).toString('hex')}`,
        fromNumber: '+2348030007701',
        toNumber: '+2348030000000',
        direction: 'INBOUND',
        status: 'COMPLETED',
        durationSeconds: 90,
        startedAt: halfPastMidnightLagos,
      },
    });

    await prisma.ticket.create({
      data: {
        organizationId: orgId, contactId: contact.id, ticketNumber: `TCK-D-${randomBytes(3).toString('hex')}`,
        subject: 'Open one', description: 'seeded open ticket', status: 'OPEN', priority: 'MEDIUM',
      },
    });
    await prisma.ticket.create({
      data: {
        organizationId: orgId, contactId: contact.id, ticketNumber: `TCK-D-${randomBytes(3).toString('hex')}`,
        subject: 'Done one', description: 'seeded resolved ticket', status: 'RESOLVED', priority: 'LOW',
      },
    });

    await prisma.deal.createMany({
      data: [
        { organizationId: orgId, contactId: contact.id, title: 'One', amount: 150000, stage: 'PROPOSAL' },
        { organizationId: orgId, contactId: contact.id, title: 'Two', amount: 50000, stage: 'CLOSED_WON' },
      ],
    });
  });

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { conversation: { organizationId: orgId } } });
    await prisma.conversation.deleteMany({ where: { organizationId: orgId } });
    await prisma.callLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.ticket.deleteMany({ where: { organizationId: orgId } });
    await prisma.deal.deleteMany({ where: { organizationId: orgId } });
    await prisma.contact.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  const get = (period = '7d') =>
    request(app.getHttpServer())
      .get(`/api/analytics/dashboard?period=${period}`)
      .set('Authorization', `Bearer ${token}`);

  it('reports the figures it was seeded with', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.unavailable).toEqual([]);
    expect(res.body.timezone).toBe('Africa/Lagos');

    const m = res.body.metrics;
    expect(m.totalConversations).toBe(2);
    expect(m.totalCalls).toBe(1);
    expect(m.totalContacts).toBe(1);
    expect(m.openTickets).toBe(1);
    // 150000 + 50000, summed in the database over every stage. This is the
    // OPEN pipeline; the dashboard labelled it "Premiums Collected", which
    // named revenue a platform that collects no payments had taken.
    expect(m.pipelineValue).toBe(200000);
    // 90 seconds is rounded UP: a 90-second call is not "1 minute of calls",
    // and it is certainly not 0. Pinned so a future `Math.round` or a
    // truncating divide cannot quietly discard short calls.
    expect(m.totalCallMinutes).toBe(2);
  });

  it('computes rates from both of their inputs, and nothing else', async () => {
    const { body } = await get();
    // 1 resolved of 2 tickets.
    expect(body.aiMetrics.resolutionRate).toBe(50);
    // 1 AI message of 2.
    expect(body.aiMetrics.aiReplyRate).toBe(50);
    // No conversation is in handoff.
    expect(body.aiMetrics.handoverRate).toBe(0);
  });

  it('buckets the trend by the agency calendar day, not the server one', async () => {
    const { body } = await get();
    const trend = body.weeklyData;
    expect(trend.labels).toHaveLength(7);
    expect(trend.timezone).toBe('Africa/Lagos');

    // Everything was seeded at 00:30 Lagos today, which is yesterday in UTC.
    // It must land on the LAST bucket.
    const last = trend.labels.length - 1;
    expect(trend.whatsapp[last]).toBe(1);
    expect(trend.webchat[last]).toBe(1);
    expect(trend.calls[last]).toBe(1);
    expect(trend.conversations[last]).toBe(2);
    // And on no other day.
    expect(trend.conversations.slice(0, last).every((n: number) => n === 0)).toBe(true);
  });

  it('separates the channels the chart draws a legend for', async () => {
    const { body } = await get();
    // The chart's three series must be three series. A single conversation
    // count plotted under a "WhatsApp" legend reported the WEBCHAT thread as
    // a WhatsApp one.
    expect(body.weeklyData.whatsapp).not.toEqual(body.weeklyData.conversations);
    const wa = body.channelBreakdown.find((c: any) => c.name === 'WhatsApp');
    const web = body.channelBreakdown.find((c: any) => c.name === 'Web Chat');
    const voice = body.channelBreakdown.find((c: any) => c.name === 'Voice Calls');
    expect(wa.value).toBe(1);
    expect(web.value).toBe(1);
    // Voice is counted from CallLog: a phone call creates no Conversation row.
    expect(voice.value).toBe(1);
  });

  it('counts the period window from local midnight', async () => {
    const { body } = await get();
    // The 00:30 Lagos rows are inside today, so a 7-day window includes them
    // whatever time of day the request is made. The old window was
    // `Date.now() - 7*86400000`, which started mid-afternoon seven days back.
    expect(body.metrics.periodConversations).toBe(2);
    expect(body.metrics.periodCalls).toBe(1);
  });

  describe('when the database cannot answer', () => {
    it('reports the figure as unknown instead of as zero', async () => {
      const service = app.get(AnalyticsService);
      const failing = new Error('terminating connection due to administrator command');
      const spy = jest.spyOn(prisma.ticket, 'count').mockRejectedValue(failing);

      try {
        const summary = await service.getDashboardSummary(orgId, '7d');

        // THE assertion. Not 0.
        expect(summary.metrics.openTickets).toBeNull();
        expect(summary.unavailable).toContain('openTickets');
        // A rate missing one input is unknown too, not 0%.
        expect(summary.aiMetrics.resolutionRate).toBeNull();
        // Everything that COULD be read still is — one broken count does not
        // blank the screen.
        expect(summary.metrics.totalConversations).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('says the week is unknown rather than drawing a quiet one', async () => {
      const service = app.get(AnalyticsService);
      const convSpy = jest
        .spyOn(prisma.conversation, 'findMany')
        .mockRejectedValue(new Error('pool timeout'));
      const callSpy = jest.spyOn(prisma.callLog, 'findMany').mockRejectedValue(new Error('pool timeout'));

      try {
        const summary = await service.getDashboardSummary(orgId, '7d');
        expect(summary.weeklyData.conversations).toBeNull();
        expect(summary.weeklyData.calls).toBeNull();
        // Still seven labelled days, so the axis renders — with no bars and a
        // message, not seven zero-height bars implying seven quiet days.
        expect(summary.weeklyData.labels).toHaveLength(7);
      } finally {
        convSpy.mockRestore();
        callSpy.mockRestore();
      }
    });
  });

  describe('zoned day helpers', () => {
    it('puts 23:30 UTC on the next day in Lagos', () => {
      const at = new Date('2026-03-04T23:30:00Z');
      expect(zonedDayKey(at, 'Africa/Lagos')).toBe('2026-03-05');
      expect(zonedDayKey(at, 'UTC')).toBe('2026-03-04');
    });

    it('opens the window at local midnight', () => {
      const { since, keys } = zonedWindow(7, 'Africa/Lagos', new Date('2026-03-05T12:00:00Z'));
      expect(keys).toEqual([
        '2026-02-27', '2026-02-28', '2026-03-01',
        '2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05',
      ]);
      // Lagos is UTC+1 with no DST, so local midnight is 23:00 UTC the day before.
      expect(since.toISOString()).toBe('2026-02-26T23:00:00.000Z');
    });

    it('survives a DST transition in a zone that has one', () => {
      // 2026-03-29 is the European spring-forward; the day still begins once.
      const start = zonedDayStart('2026-03-29', 'Europe/London');
      expect(zonedDayKey(start, 'Europe/London')).toBe('2026-03-29');
      expect(zonedDayKey(new Date(start.getTime() - 1), 'Europe/London')).toBe('2026-03-28');
    });
  });
});
