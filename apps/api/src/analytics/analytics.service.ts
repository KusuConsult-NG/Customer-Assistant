import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { zonedDayKey, zonedDayLabel, zonedWindow } from '../common/zoned-days';

type Period = '7d' | '30d' | '90d';

function periodToDays(period: Period): number {
  return period === '90d' ? 90 : period === '30d' ? 30 : 7;
}

const BUSY_WINDOW_ROWS = 20000;

@Injectable()
export class AnalyticsService {
  /**
   * The dashboard summary.
   *
   * A figure that could not be READ is null, and the names of those figures
   * come back in `unavailable`. It used to be `.catch(() => 0)` on every
   * query inside a try that logged and fell through, so a database that was
   * unreachable — or one connection short of the pool limit — produced a 200
   * with a complete set of zeros: "0 bookings", "0 open tickets", "₦0", shown
   * to an officer as the state of their agency. That is the same failure the
   * scheduling screen had when a failed list load rendered "No bookings
   * recorded yet", and it is worse here because the home page is the first
   * thing anyone sees. Nothing known is not the same as nothing there.
   */
  async getDashboardSummary(organizationId: string, period: Period = '7d') {
    const days = periodToDays(period);

    const org = await prisma.organization
      .findUnique({ where: { id: organizationId }, select: { timezone: true } })
      .catch(() => null);
    const timezone = org?.timezone || 'Africa/Lagos';

    // The period window and the per-day buckets are derived from ONE call, so
    // the trend cannot cover a different stretch of time than the totals.
    const { keys, since } = zonedWindow(days, timezone);

    const unavailable: string[] = [];
    const read = async <T>(name: string, query: () => Promise<T>): Promise<T | null> => {
      try {
        return await query();
      } catch (err: any) {
        unavailable.push(name);
        console.error(`[AnalyticsService] ${name} unavailable for ${organizationId}:`, err?.message ?? err);
        return null;
      }
    };

    // Sequential on purpose: @ace/database is one pooled client shared by the
    // whole process, and a dozen parallel counts per dashboard load is what
    // exhausts it under several officers at once.
    const totalCalls = await read('totalCalls', () => prisma.callLog.count({ where: { organizationId } }));
    const totalConversations = await read('totalConversations', () =>
      prisma.conversation.count({ where: { organizationId } }));
    const totalContacts = await read('totalContacts', () => prisma.contact.count({ where: { organizationId } }));
    const totalLeads = await read('totalLeads', () => prisma.lead.count({ where: { organizationId } }));
    const totalBookings = await read('totalBookings', () => prisma.booking.count({ where: { organizationId } }));
    const totalReservations = await read('totalReservations', () =>
      prisma.reservation.count({ where: { organizationId } }));

    const openTickets = await read('openTickets', () =>
      prisma.ticket.count({ where: { organizationId, status: 'OPEN' } }));
    const resolvedTickets = await read('resolvedTickets', () =>
      prisma.ticket.count({ where: { organizationId, status: 'RESOLVED' } }));

    // Each of these was queried TWICE in the old body — once near the top and
    // again sixty lines down under a comment saying they were never assigned,
    // which had stopped being true. Two extra round trips per dashboard load.
    const totalMessages = await read('totalMessages', () =>
      prisma.message.count({ where: { conversation: { organizationId } } }));
    const totalAiMessages = await read('totalAiMessages', () =>
      prisma.message.count({ where: { conversation: { organizationId }, sender: 'AI' } }));

    const handledByHumanConversations = await read('handoffConversations', () =>
      prisma.conversation.count({ where: { organizationId, isHumanHandoffActive: true } }));

    // Summed in the database. `findMany()` over every deal the agency has ever
    // had, to add one column up in JavaScript, grows without limit.
    const dealSum = await read('pipelineValue', () =>
      prisma.deal.aggregate({ _sum: { amount: true }, where: { organizationId } }));
    const pipelineValue = dealSum ? Number(dealSum._sum.amount ?? 0) : null;

    const periodCalls = await read('periodCalls', () =>
      prisma.callLog.count({ where: { organizationId, startedAt: { gte: since } } }));
    const periodConversations = await read('periodConversations', () =>
      prisma.conversation.count({ where: { organizationId, createdAt: { gte: since } } }));
    const periodLeads = await read('periodLeads', () =>
      prisma.lead.count({ where: { organizationId, createdAt: { gte: since } } }));
    const periodBookings = await read('periodBookings', () =>
      prisma.booking.count({ where: { organizationId, createdAt: { gte: since } } }));

    const callDurationAgg = await read('totalCallMinutes', () =>
      prisma.callLog.aggregate({ _sum: { durationSeconds: true }, where: { organizationId } }));
    const totalCallMinutes = callDurationAgg
      ? Math.ceil(Number(callDurationAgg._sum?.durationSeconds ?? 0) / 60)
      : null;

    // Conversations per channel, in one grouped query rather than one count
    // per channel — and it reports what EXISTS, so a channel nobody has used
    // is absent instead of being asserted as zero.
    const byChannel = await read('channelBreakdown', () =>
      prisma.conversation.groupBy({ by: ['channel'], where: { organizationId }, _count: { _all: true } }));

    const channelCount = (channel: string): number | null => {
      if (!byChannel) return null;
      const row = byChannel.find((r: any) => r.channel === channel);
      return row ? Number(row._count._all) : 0;
    };

    const weeklyData = await this.buildTrend(organizationId, keys, days, timezone, read);

    const recentCalls = (await read('recentCalls', () =>
      prisma.callLog.findMany({ where: { organizationId }, take: 10, orderBy: { startedAt: 'desc' } }))) ?? [];
    const recentConversations = (await read('recentConversations', () =>
      prisma.conversation.findMany({
        where: { organizationId },
        take: 5,
        orderBy: { lastMessageAt: 'desc' },
        include: { contact: true },
      }))) ?? [];

    /** A rate needs BOTH of its inputs; one unreadable count makes it unknown, not 0%. */
    const rate = (part: number | null, whole: number | null): number | null => {
      if (part === null || whole === null) return null;
      if (whole <= 0) return null;
      return Math.round((part / whole) * 100);
    };

    const totalTickets =
      openTickets === null || resolvedTickets === null ? null : openTickets + resolvedTickets;

    return {
      period,
      timezone,
      /** Figures the database could not be asked for on this request. */
      unavailable,
      metrics: {
        totalCalls,
        totalConversations,
        totalContacts,
        totalLeads,
        totalBookings,
        totalReservations,
        openTickets,
        /**
         * The sum of every Deal.amount — OPEN pipeline, not money received.
         * This platform collects no payments at all, so there is no "collected"
         * figure for a dashboard to show; the home page labelled this one
         * "Premiums Collected", which named revenue the State never took.
         */
        pipelineValue,
        totalCallMinutes,
        periodCalls,
        periodConversations,
        periodLeads,
        periodBookings,
      },
      aiMetrics: {
        /** Share of tickets that reached RESOLVED. */
        resolutionRate: rate(resolvedTickets, totalTickets),
        /** Share of all messages the AI wrote. */
        aiReplyRate: rate(totalAiMessages, totalMessages),
        /**
         * Share of conversations escalated to a human. Was tickets per
         * conversation, a different quantity that could exceed 100%.
         */
        handoverRate: rate(handledByHumanConversations, totalConversations),
      },
      channelBreakdown: [
        { name: 'WhatsApp', value: channelCount('WHATSAPP') },
        // Voice is counted from CallLog, not from Conversation: the media
        // stream handler creates no Conversation row for a call, so a
        // conversation count would report every phone call as zero.
        { name: 'Voice Calls', value: totalCalls },
        { name: 'Web Chat', value: channelCount('WEBCHAT') },
      ],
      weeklyData,
      recentCalls,
      recentConversations,
    };
  }

  /**
   * Conversations and calls per calendar day, in the agency's timezone, split
   * by channel.
   *
   * The series used to be one undifferentiated `conversations` count that the
   * dashboard drew under a "WhatsApp" legend, with a third "WebChat" series
   * hardcoded to zero — so a WEBCHAT thread was displayed as a WhatsApp one
   * and the legend asserted a breakdown the payload never carried.
   */
  private async buildTrend(
    organizationId: string,
    keys: string[],
    days: number,
    timezone: string,
    read: <T>(name: string, q: () => Promise<T>) => Promise<T | null>,
  ) {
    const labels = keys.map((k) => zonedDayLabel(k, days, timezone));
    const empty = () => keys.map(() => 0);
    const since = new Date(`${keys[0]}T00:00:00Z`);
    // The window opens at local midnight, which can be the previous UTC day;
    // widen the query by a day at each end and let the bucketing decide.
    const from = new Date(since.getTime() - 36 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 36 * 60 * 60 * 1000);

    const conversations = await read('trendConversations', () =>
      prisma.conversation.findMany({
        where: { organizationId, createdAt: { gte: from, lte: to } },
        select: { createdAt: true, channel: true },
        take: BUSY_WINDOW_ROWS,
      }));

    const calls = await read('trendCalls', () =>
      prisma.callLog.findMany({
        where: { organizationId, startedAt: { gte: from, lte: to } },
        select: { startedAt: true },
        take: BUSY_WINDOW_ROWS,
      }));

    if (conversations === null && calls === null) {
      // Not "a week of quiet days" — nothing is known about this week. The
      // page draws no chart for a null series.
      return { labels, timezone, conversations: null, whatsapp: null, webchat: null, calls: null };
    }

    const index = new Map(keys.map((k, i) => [k, i]));
    const total = empty();
    const whatsapp = empty();
    const webchat = empty();
    const callsPerDay = empty();

    for (const c of conversations ?? []) {
      const i = index.get(zonedDayKey(c.createdAt, timezone));
      if (i === undefined) continue;
      total[i]++;
      if (c.channel === 'WHATSAPP') whatsapp[i]++;
      else if (c.channel === 'WEBCHAT') webchat[i]++;
    }
    for (const c of calls ?? []) {
      const i = index.get(zonedDayKey(c.startedAt, timezone));
      if (i !== undefined) callsPerDay[i]++;
    }

    return {
      labels,
      timezone,
      conversations: conversations === null ? null : total,
      whatsapp: conversations === null ? null : whatsapp,
      webchat: conversations === null ? null : webchat,
      calls: calls === null ? null : callsPerDay,
    };
  }
}
