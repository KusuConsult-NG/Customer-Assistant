import { Injectable, NotFoundException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { LeadStatus, DealStage, TicketStatus, TicketPriority } from '@ace/shared-types';

@Injectable()
export class CrmService {
  constructor(private webhookDispatcher: WebhookDispatcherService) {}

  async getContacts(organizationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        include: { leads: true, deals: true, tickets: true },
        take: limit,
        skip,
      }),
      prisma.contact.count({ where: { organizationId } }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createContact(
    organizationId: string,
    data: { fullName: string; phoneNumber: string; email?: string; tags?: string[]; address?: string; city?: string; state?: string }
  ) {
    // address/city/state existed in the schema from day one but were silently
    // dropped here — no API or form could ever set a contact's location.
    const contact = await prisma.contact.create({
      data: {
        organizationId,
        fullName: data.fullName,
        phoneNumber: data.phoneNumber,
        email: data.email,
        tags: data.tags || [],
        address: data.address,
        city: data.city,
        state: data.state,
      },
    });

    this.webhookDispatcher.dispatch(organizationId, 'contact.created', {
      contactId: contact.id,
      fullName: contact.fullName,
    }).catch(() => {});

    return contact;
  }

  async getLeads(organizationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.lead.findMany({
        where: { organizationId },
        include: { contact: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.lead.count({ where: { organizationId } }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createLead(organizationId: string, contactId: string, notes?: string) {
    const lead = await prisma.lead.create({
      data: {
        organizationId,
        contactId,
        notes,
        status: LeadStatus.NEW,
      },
      include: { contact: true },
    });

    this.webhookDispatcher.dispatch(organizationId, 'lead.captured', {
      leadId: lead.id,
      contactId: lead.contactId,
    }).catch(() => {});

    return lead;
  }

  async updateLeadStatus(leadId: string, status: LeadStatus, organizationId: string) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, organizationId } });
    if (!lead) throw new NotFoundException('Lead not found');
    return prisma.lead.update({
      where: { id: leadId },
      data: { status },
    });
  }

  async getDeals(organizationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.deal.findMany({
        where: { organizationId },
        include: { contact: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.deal.count({ where: { organizationId } }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
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

  async getTickets(organizationId: string, page = 1, limit = 50) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        where: { organizationId },
        include: { contact: true, assignedUser: true },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip,
      }),
      prisma.ticket.count({ where: { organizationId } }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createTicket(organizationId: string, data: { contactId: string; subject: string; description: string; priority?: TicketPriority }) {
    const count = await prisma.ticket.count({ where: { organizationId } });
    // Random suffix: ticketNumber is globally unique, but the old
    // time-slice + per-org-count pair could collide across orgs (and the
    // read-then-create count races with itself), turning into a P2002 500.
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    const ticketNumber = `TCK-${Date.now().toString().slice(-4)}-${count + 1}-${rand}`;

    const ticket = await prisma.ticket.create({
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

    this.webhookDispatcher.dispatch(organizationId, 'ticket.created', {
      ticketId: ticket.id,
      subject: ticket.subject,
      priority: ticket.priority,
    }).catch(() => {});

    return ticket;
  }

  async updateTicketStatus(ticketId: string, status: TicketStatus, organizationId: string) {
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, organizationId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return prisma.ticket.update({
      where: { id: ticketId },
      data: { status },
      include: { contact: true },
    });
  }

  async updateDealStage(dealId: string, stage: DealStage, organizationId: string) {
    const deal = await prisma.deal.findFirst({ where: { id: dealId, organizationId } });
    if (!deal) throw new NotFoundException('Deal not found');
    return prisma.deal.update({
      where: { id: dealId },
      data: { stage },
      include: { contact: true },
    });
  }

  async updateContact(contactId: string, data: { fullName?: string; phoneNumber?: string; email?: string; tags?: string[]; address?: string; city?: string; state?: string }, organizationId: string) {
    const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId } });
    if (!contact) throw new NotFoundException('Contact not found');
    return prisma.contact.update({
      where: { id: contactId },
      data,
    });
  }

  async deleteContact(contactId: string, organizationId: string) {
    const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId } });
    if (!contact) throw new NotFoundException('Contact not found');
    return prisma.contact.delete({ where: { id: contactId } });
  }

  async deleteLead(leadId: string, organizationId: string) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, organizationId } });
    if (!lead) throw new NotFoundException('Lead not found');
    return prisma.lead.delete({ where: { id: leadId } });
  }

  async deleteDeal(dealId: string, organizationId: string) {
    const deal = await prisma.deal.findFirst({ where: { id: dealId, organizationId } });
    if (!deal) throw new NotFoundException('Deal not found');
    return prisma.deal.delete({ where: { id: dealId } });
  }

  async deleteTicket(ticketId: string, organizationId: string) {
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, organizationId } });
    if (!ticket) throw new NotFoundException('Ticket not found');
    return prisma.ticket.delete({ where: { id: ticketId } });
  }

  async getContactById(contactId: string, organizationId: string) {
    const contact = await prisma.contact.findFirst({ where: { id: contactId, organizationId }, include: { leads: true, deals: true, tickets: true } });
    if (!contact) throw new NotFoundException('Contact not found');
    return contact;
  }

  async searchContacts(organizationId: string, query: string) {
    return prisma.contact.findMany({
      where: {
        organizationId,
        OR: [
          { fullName: { contains: query, mode: 'insensitive' } },
          { phoneNumber: { contains: query } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
      },
      include: { leads: true, deals: true },
      take: 50,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Quotation data for a real deal. Unknown dealId → 404.
   *
   * The old fallback fabricated a "Service & Operations Retainer — ₦150,000"
   * quotation with placeholder phone numbers for ANY unknown id — a fake
   * financial document presented as genuine. Quotations are only generated
   * from actual deal records; placeholder contact details are omitted, not
   * invented.
   */
  async getQuotationData(dealId: string, organizationId: string) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, organizationId },
      include: { contact: true, organization: true },
    });

    if (!deal) throw new NotFoundException(`Deal not found: ${dealId}`);

    return {
      quotationNumber: `QUO-${deal.id.slice(0, 8).toUpperCase()}`,
      organizationName: deal.organization?.name || 'Your Organization',
      organizationPhone: deal.organization?.phone || '',
      customerName: deal.contact?.fullName || 'Customer',
      customerPhone: deal.contact?.phoneNumber || '',
      items: [
        { description: deal.title || 'Service Quotation', quantity: 1, unitPrice: deal.amount, totalPrice: deal.amount },
      ],
      subtotal: deal.amount,
      tax: 0,
      grandTotal: deal.amount,
      currency: deal.currency || 'NGN',
      validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    };
  }
}

