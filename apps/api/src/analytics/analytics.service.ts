import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';

@Injectable()
export class AnalyticsService {
  async getDashboardSummary(organizationId: string) {
    const totalCalls = await prisma.callLog.count({ where: { organizationId } });
    const totalConversations = await prisma.conversation.count({ where: { organizationId } });
    const totalContacts = await prisma.contact.count({ where: { organizationId } });
    const totalLeads = await prisma.lead.count({ where: { organizationId } });
    const totalBookings = await prisma.booking.count({ where: { organizationId } });
    const totalReservations = await prisma.reservation.count({ where: { organizationId } });
    const openTickets = await prisma.ticket.count({ where: { organizationId, status: 'OPEN' } });

    const deals = await prisma.deal.findMany({ where: { organizationId } });
    const pipelineValue = deals.reduce((sum: number, d: any) => sum + d.amount, 0);

    const callLogs = await prisma.callLog.findMany({
      where: { organizationId },
      take: 10,
      orderBy: { startedAt: 'desc' },
    });

    const recentConversations = await prisma.conversation.findMany({
      where: { organizationId },
      take: 5,
      orderBy: { lastMessageAt: 'desc' },
      include: { contact: true, messages: { take: 1, orderBy: { sentAt: 'desc' } } },
    });

    const whatsappConversations = await prisma.conversation.count({
      where: { organizationId, channel: 'WHATSAPP' },
    });
    const webchatConversations = await prisma.conversation.count({
      where: { organizationId, channel: 'WEBCHAT' },
    });

    return {
      metrics: {
        totalCalls,
        totalConversations,
        totalContacts,
        totalLeads,
        totalBookings,
        totalReservations,
        openTickets,
        pipelineValue,
      },
      channelBreakdown: [
        { name: 'WhatsApp', value: whatsappConversations },
        { name: 'Voice Calls', value: totalCalls },
        { name: 'Web Chat', value: webchatConversations },
      ],
      recentCalls: callLogs,
      recentConversations,
    };

  }
}
