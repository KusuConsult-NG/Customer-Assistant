import { Injectable } from '@nestjs/common';
import { prisma } from '@ace/database';
import { LeadStatus, DealStage, TicketStatus, TicketPriority } from '@ace/shared-types';

@Injectable()
export class CrmService {
  async getContacts(organizationId: string) {
    return prisma.contact.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { leads: true, deals: true, tickets: true },
    });
  }

  async createContact(organizationId: string, data: { fullName: string; phoneNumber: string; email?: string; tags?: string[] }) {
    return prisma.contact.create({
      data: {
        organizationId,
        fullName: data.fullName,
        phoneNumber: data.phoneNumber,
        email: data.email,
        tags: data.tags || [],
      },
    });
  }

  async getLeads(organizationId: string) {
    return prisma.lead.findMany({
      where: { organizationId },
      include: { contact: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createLead(organizationId: string, contactId: string, notes?: string) {
    return prisma.lead.create({
      data: {
        organizationId,
        contactId,
        notes,
        status: LeadStatus.NEW,
      },
      include: { contact: true },
    });
  }

  async updateLeadStatus(leadId: string, status: LeadStatus) {
    return prisma.lead.update({
      where: { id: leadId },
      data: { status },
    });
  }

  async getDeals(organizationId: string) {
    return prisma.deal.findMany({
      where: { organizationId },
      include: { contact: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createDeal(organizationId: string, data: { contactId: string; title: string; amount: number; stage?: DealStage }) {
    return prisma.deal.create({
      data: {
        organizationId,
        contactId: data.contactId,
        title: data.title,
        amount: data.amount,
        stage: data.stage || DealStage.DISCOVERY,
      },
      include: { contact: true },
    });
  }

  async getTickets(organizationId: string) {
    return prisma.ticket.findMany({
      where: { organizationId },
      include: { contact: true, assignedUser: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createTicket(organizationId: string, data: { contactId: string; subject: string; description: string; priority?: TicketPriority }) {
    const count = await prisma.ticket.count({ where: { organizationId } });
    const ticketNumber = `TCK-${Date.now().toString().slice(-4)}-${count + 1}`;

    return prisma.ticket.create({
      data: {
        organizationId,
        contactId: data.contactId,
        ticketNumber,
        subject: data.subject,
        description: data.description,
        priority: data.priority || TicketPriority.MEDIUM,
        status: TicketStatus.OPEN,
      },
      include: { contact: true },
    });
  }

  async updateTicketStatus(ticketId: string, status: TicketStatus) {

    return prisma.ticket.update({
      where: { id: ticketId },
      data: { status },
      include: { contact: true },
    });
  }

  async updateDealStage(dealId: string, stage: DealStage) {
    return prisma.deal.update({
      where: { id: dealId },
      data: { stage },
      include: { contact: true },
    });
  }

  async updateContact(contactId: string, data: { fullName?: string; phoneNumber?: string; email?: string; tags?: string[] }) {
    return prisma.contact.update({
      where: { id: contactId },
      data,
    });
  }

  async deleteContact(contactId: string) {
    return prisma.contact.delete({ where: { id: contactId } });
  }

  async deleteLead(leadId: string) {
    return prisma.lead.delete({ where: { id: leadId } });
  }

  async deleteDeal(dealId: string) {
    return prisma.deal.delete({ where: { id: dealId } });
  }

  async getQuotationData(dealId: string, organizationId: string) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, organizationId },
      include: { contact: true, organization: true },
    });

    if (deal) {
      return {
        quotationNumber: `QUO-${deal.id.slice(0, 8).toUpperCase()}`,
        organizationName: deal.organization?.name || 'ACE Customer Care',
        organizationPhone: deal.organization?.phone || '+234 1 700 8000',
        customerName: deal.contact?.fullName || 'Valued Customer',
        customerPhone: deal.contact?.phoneNumber || '+234 800 000 0000',
        items: [
          { description: deal.title || 'Service Quotation', quantity: 1, unitPrice: deal.amount, totalPrice: deal.amount },
        ],
        subtotal: deal.amount,
        tax: 0,
        grandTotal: deal.amount,
        currency: 'NGN',
        validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      };
    }

    // Fallback if dealId is a custom ref
    const org = await prisma.organization.findUnique({ where: { id: organizationId } });
    return {
      quotationNumber: dealId.toUpperCase(),
      organizationName: org?.name || 'ACE Customer Care',
      organizationPhone: org?.phone || '+234 1 700 8000',
      customerName: 'Valued Customer',
      customerPhone: '+234 800 000 0000',
      items: [
        { description: 'Service & Operations Retainer', quantity: 1, unitPrice: 150000, totalPrice: 150000 },
      ],
      subtotal: 150000,
      tax: 0,
      grandTotal: 150000,
      currency: 'NGN',
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    };
  }
}

