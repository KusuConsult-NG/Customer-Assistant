import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { AceLogger } from '../config/logger';

export interface CustomerTimelineItem {
  id: string;
  type: 'CALL' | 'WHATSAPP_MESSAGE' | 'BOOKING' | 'DEAL_UPDATE' | 'TICKET_CREATED' | 'NOTE';
  timestamp: Date;
  title: string;
  description: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class CrmTimelineService {
  private logger = new AceLogger('CrmTimelineService');

  async getCustomerTimeline(contactId: string, organizationId: string): Promise<{
    contact: any;
    healthScore: number;
    timeline: CustomerTimelineItem[];
  }> {
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, organizationId },
      include: {
        leads: true,
        deals: true,
        tickets: true,
      },
    });

    if (!contact) {
      throw new Error('Contact not found');
    }

    // Fetch related CallLogs
    const callLogs = await prisma.callLog.findMany({
      where: { organizationId, fromNumber: contact.phoneNumber },
      orderBy: { startedAt: 'desc' },
      take: 20,
    });

    // Fetch related Bookings
    const bookings = await prisma.booking.findMany({
      where: { contactId, organizationId },
      orderBy: { startTime: 'desc' },
      take: 10,
    });

    const timeline: CustomerTimelineItem[] = [];

    // Map calls
    callLogs.forEach((call) => {
      timeline.push({
        id: call.id,
        type: 'CALL',
        timestamp: call.startedAt,
        title: `Voice Call (${call.direction})`,
        description: `Duration: ${call.durationSeconds}s. Status: ${call.status}. ${call.summary || ''}`,
        metadata: { durationSeconds: call.durationSeconds, callSid: call.callSid },
      });
    });

    // Map bookings
    bookings.forEach((bk) => {
      timeline.push({
        id: bk.id,
        type: 'BOOKING',
        timestamp: bk.startTime,
        title: `Booking: ${bk.serviceName}`,
        description: `Staff: ${bk.staffName || 'Unassigned'}. Status: ${bk.status}`,
        metadata: { status: bk.status },
      });
    });

    // Map deals
    contact.deals.forEach((deal) => {
      timeline.push({
        id: deal.id,
        type: 'DEAL_UPDATE',
        timestamp: deal.createdAt,
        title: `Deal: ${deal.title}`,
        description: `Amount: ₦${deal.amount.toLocaleString()}. Stage: ${deal.stage}`,
        metadata: { amount: deal.amount, stage: deal.stage },
      });
    });

    // Map tickets
    contact.tickets.forEach((t) => {
      timeline.push({
        id: t.id,
        type: 'TICKET_CREATED',
        timestamp: t.createdAt,
        title: `Ticket #${t.ticketNumber}: ${t.subject}`,
        description: `Priority: ${t.priority}. Status: ${t.status}`,
        metadata: { priority: t.priority, status: t.status },
      });
    });

    // Sort timeline chronologically
    timeline.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Calculate AI Customer Health Score (0 - 100)
    let healthScore = 85;
    const openUrgentTickets = contact.tickets.filter((t) => t.status === 'OPEN' && (t.priority === 'URGENT' || t.priority === 'HIGH'));
    if (openUrgentTickets.length > 0) healthScore -= 25;
    const wonDeals = contact.deals.filter((d) => d.stage === 'CLOSED_WON');
    if (wonDeals.length > 0) healthScore += 10;
    healthScore = Math.min(100, Math.max(0, healthScore));

    return {
      contact,
      healthScore,
      timeline,
    };
  }
}
