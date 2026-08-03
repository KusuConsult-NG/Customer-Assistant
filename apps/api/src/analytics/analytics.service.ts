import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';

type Period = '7d' | '30d' | '90d';

function periodToDays(period: Period): number {
  return period === '90d' ? 90 : period === '30d' ? 30 : 7;
}

@Injectable()
export class AnalyticsService {

  async getDashboardSummary(organizationId: string, period: Period = '7d') {
    const days = periodToDays(period);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // ── All-time totals (Batched to respect DB pool limits) ─────────────────
    const [
      totalCalls,
      totalConversations,
      totalContacts,
      totalLeads,
      totalBookings,
      totalReservations,
    ] = await Promise.all([
      prisma.callLog.count({ where: { organizationId } }),
      prisma.conversation.count({ where: { organizationId } }),
      prisma.contact.count({ where: { organizationId } }),
      prisma.lead.count({ where: { organizationId } }),
      prisma.booking.count({ where: { organizationId } }),
      prisma.reservation.count({ where: { organizationId } }),
    ]);

    const [
      openTickets,
      resolvedTickets,
      totalAiMessages,
      totalMessages,
      whatsappConversations,
      webchatConversations,
    ] = await Promise.all([
      prisma.ticket.count({ where: { organizationId, status: 'OPEN' } }),
      prisma.ticket.count({ where: { organizationId, status: 'RESOLVED' } }),
      prisma.message.count({ where: { conversation: { organizationId }, sender: 'AI' } }),
      prisma.message.count({ where: { conversation: { organizationId } } }),
      prisma.conversation.count({ where: { organizationId, channel: 'WHATSAPP' } }),
      prisma.conversation.count({ where: { organizationId, channel: 'WEBCHAT' } }),
    ]);

    const deals = await prisma.deal.findMany({ where: { organizationId } });
    const pipelineValue = deals.reduce((sum: number, d: any) => sum + d.amount, 0);

    // ── Period totals (filtered by date range) ─────────────────────────────────
    const [periodCalls, periodConversations, periodLeads, periodBookings] = await Promise.all([
      prisma.callLog.count({ where: { organizationId, startedAt: { gte: since } } }),
      prisma.conversation.count({ where: { organizationId, createdAt: { gte: since } } }),
      prisma.lead.count({ where: { organizationId, createdAt: { gte: since } } }),
      prisma.booking.count({ where: { organizationId, createdAt: { gte: since } } }),
    ]);

    // ── Total call minutes ────────────────────────────────────────────────────
    const callDurationAgg = await prisma.callLog.aggregate({
      _sum: { durationSeconds: true },
      where: { organizationId },
    });
    const totalCallMinutes = Math.ceil(((callDurationAgg._sum.durationSeconds as number) ?? 0) / 60);

    // ── AI Metrics ────────────────────────────────────────────────────────────
    const totalTickets = openTickets + resolvedTickets;
    const resolutionRate = totalTickets > 0
      ? Math.round((resolvedTickets / totalTickets) * 100)
      : null;
    const aiReplyRate = totalMessages > 0
      ? Math.round((totalAiMessages / totalMessages) * 100)
      : null;
    const handoverRate = totalConversations > 0
      ? Math.round(((totalTickets) / totalConversations) * 100)
      : null;

    // ── Weekly trend data (last N days, grouped by day) ───────────────────────
    const weeklyData = await this.buildWeeklyTrend(organizationId, days);

    // ── Recent activity ───────────────────────────────────────────────────────
    const [recentCalls, recentConversations] = await Promise.all([
      prisma.callLog.findMany({
        where: { organizationId },
        take: 10,
        orderBy: { startedAt: 'desc' },
      }),
      prisma.conversation.findMany({
        where: { organizationId },
        take: 5,
        orderBy: { lastMessageAt: 'desc' },
        include: { contact: true, messages: { take: 1, orderBy: { sentAt: 'desc' } } },
      }),
    ]);

    return {
      period,
      metrics: {
        totalCalls,
        totalConversations,
        totalContacts,
        totalLeads,
        totalBookings,
        totalReservations,
        openTickets,
        pipelineValue,
        totalCallMinutes,
        // Period-specific
        periodCalls,
        periodConversations,
        periodLeads,
        periodBookings,
      },
      aiMetrics: {
        resolutionRate,   // null if no tickets yet
        aiReplyRate,      // % of messages sent by AI
        handoverRate,     // % of conversations that became tickets
      },
      channelBreakdown: [
        { name: 'WhatsApp', value: whatsappConversations },
        { name: 'Voice Calls', value: totalCalls },
        { name: 'Web Chat', value: webchatConversations },
      ],
      weeklyData,
      recentCalls,
      recentConversations,
    };
  }

  /** Builds a per-day trend array for the last N days */
  private async buildWeeklyTrend(organizationId: string, days: number) {
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    startDate.setHours(0, 0, 0, 0);

    const conversations = await prisma.conversation.findMany({
      where: { organizationId, createdAt: { gte: startDate, lte: endDate } },
      select: { createdAt: true },
    });
    const calls = await prisma.callLog.findMany({
      where: { organizationId, startedAt: { gte: startDate, lte: endDate } },
      select: { startedAt: true },
    });

    const labels: string[] = [];
    const convMap: Record<string, number> = {};
    const callMap: Record<string, number> = {};
    
    const cursor = new Date(startDate);
    while (cursor <= endDate) {
      const label = cursor.toLocaleDateString('en-GB', {
        weekday: days <= 7 ? 'short' : undefined,
        day: days > 7 ? 'numeric' : undefined,
        month: days > 7 ? 'short' : undefined,
      });
      labels.push(label);
      convMap[label] = 0;
      callMap[label] = 0;
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const c of conversations) {
      const label = c.createdAt.toLocaleDateString('en-GB', {
        weekday: days <= 7 ? 'short' : undefined,
        day: days > 7 ? 'numeric' : undefined,
        month: days > 7 ? 'short' : undefined,
      });
      if (convMap[label] !== undefined) convMap[label]++;
    }
    for (const c of calls) {
      const label = c.startedAt.toLocaleDateString('en-GB', {
        weekday: days <= 7 ? 'short' : undefined,
        day: days > 7 ? 'numeric' : undefined,
        month: days > 7 ? 'short' : undefined,
      });
      if (callMap[label] !== undefined) callMap[label]++;
    }

    return {
      labels,
      conversations: labels.map(d => convMap[d]),
      calls: labels.map(d => callMap[d]),
    };
  }
}
