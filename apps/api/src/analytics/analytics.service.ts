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

    let totalCalls = 0;
    let totalConversations = 0;
    let totalContacts = 0;
    let totalLeads = 0;
    let totalBookings = 0;
    let totalReservations = 0;
    let openTickets = 0;
    let resolvedTickets = 0;
    let totalAiMessages = 0;
    let totalMessages = 0;
    let whatsappConversations = 0;
    let webchatConversations = 0;
    let pipelineValue = 0;

    let periodCalls = 0;
    let periodConversations = 0;
    let periodLeads = 0;
    let periodBookings = 0;

    let totalCallMinutes = 0;
    let weeklyData: { labels: string[]; conversations: number[]; calls: number[] } = { labels: [], conversations: [], calls: [] };
    let recentCalls: any[] = [];
    let recentConversations: any[] = [];

    try {
      // Execute light sequential queries to prevent Supabase connection pool exhaustion
      totalCalls = await prisma.callLog.count({ where: { organizationId } }).catch(() => 0);
      totalConversations = await prisma.conversation.count({ where: { organizationId } }).catch(() => 0);
      totalContacts = await prisma.contact.count({ where: { organizationId } }).catch(() => 0);
      totalLeads = await prisma.lead.count({ where: { organizationId } }).catch(() => 0);
      totalBookings = await prisma.booking.count({ where: { organizationId } }).catch(() => 0);
      totalReservations = await prisma.reservation.count({ where: { organizationId } }).catch(() => 0);

      openTickets = await prisma.ticket.count({ where: { organizationId, status: 'OPEN' } }).catch(() => 0);
      resolvedTickets = await prisma.ticket.count({ where: { organizationId, status: 'RESOLVED' } }).catch(() => 0);
      // These two feed aiReplyRate — previously declared but never queried,
      // so aiReplyRate was permanently null on the dashboard.
      totalMessages = await prisma.message.count({ where: { conversation: { organizationId } } }).catch(() => 0);
      totalAiMessages = await prisma.message.count({ where: { conversation: { organizationId }, sender: 'AI' } }).catch(() => 0);
      whatsappConversations = await prisma.conversation.count({ where: { organizationId, channel: 'WHATSAPP' } }).catch(() => 0);
      webchatConversations = await prisma.conversation.count({ where: { organizationId, channel: 'WEBCHAT' } }).catch(() => 0);

      const deals = await prisma.deal.findMany({ where: { organizationId } }).catch(() => []);
      pipelineValue = deals.reduce((sum: number, d: any) => sum + (d.amount || 0), 0);

      periodCalls = await prisma.callLog.count({ where: { organizationId, startedAt: { gte: since } } }).catch(() => 0);
      periodConversations = await prisma.conversation.count({ where: { organizationId, createdAt: { gte: since } } }).catch(() => 0);
      periodLeads = await prisma.lead.count({ where: { organizationId, createdAt: { gte: since } } }).catch(() => 0);
      periodBookings = await prisma.booking.count({ where: { organizationId, createdAt: { gte: since } } }).catch(() => 0);

      const callDurationAgg = await prisma.callLog.aggregate({
        _sum: { durationSeconds: true },
        where: { organizationId },
      }).catch(() => ({ _sum: { durationSeconds: 0 } }));

      totalCallMinutes = Math.ceil(((callDurationAgg._sum?.durationSeconds as number) ?? 0) / 60);
      weeklyData = await this.buildWeeklyTrend(organizationId, days).catch(() => ({ labels: [], conversations: [], calls: [] }));

      recentCalls = await prisma.callLog.findMany({
        where: { organizationId },
        take: 10,
        orderBy: { startedAt: 'desc' },
      }).catch(() => []);

      recentConversations = await prisma.conversation.findMany({
        where: { organizationId },
        take: 5,
        orderBy: { lastMessageAt: 'desc' },
        include: { contact: true },
      }).catch(() => []);
    } catch (err: any) {
      console.error('[AnalyticsService] Error retrieving dashboard summary:', err.message);
    }

    const totalTickets = openTickets + resolvedTickets;
    const resolutionRate = totalTickets > 0 ? Math.round((resolvedTickets / totalTickets) * 100) : null;
    const aiReplyRate = totalMessages > 0 ? Math.round((totalAiMessages / totalMessages) * 100) : null;
    const handoverRate = totalConversations > 0 ? Math.round((totalTickets / totalConversations) * 100) : null;

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
        periodCalls,
        periodConversations,
        periodLeads,
        periodBookings,
      },
      aiMetrics: {
        resolutionRate,
        aiReplyRate,
        handoverRate,
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

  private async buildWeeklyTrend(organizationId: string, days: number) {
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days + 1);
    startDate.setHours(0, 0, 0, 0);

    const conversations = await prisma.conversation.findMany({
      where: { organizationId, createdAt: { gte: startDate, lte: endDate } },
      select: { createdAt: true },
    }).catch(() => []);

    const calls = await prisma.callLog.findMany({
      where: { organizationId, startedAt: { gte: startDate, lte: endDate } },
      select: { startedAt: true },
    }).catch(() => []);

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
