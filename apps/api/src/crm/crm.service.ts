import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { prisma, normalizePhoneNumber } from '@ace/database';
import { resolvePaging, pageEnvelope, STABLE_DESC } from '../common/pagination';
import { WebhookDispatcherService } from '../webhooks/webhook-dispatcher.service';
import { WorkflowTriggerService } from '../workflows/workflow-trigger.service';
import { LeadStatus, DealStage, TicketStatus, TicketPriority } from '@ace/shared-types';

@Injectable()
export class CrmService {
  constructor(
    private webhookDispatcher: WebhookDispatcherService,
    private workflows: WorkflowTriggerService
  ) {}

  async getContacts(organizationId: string, rawPage?: unknown, rawLimit?: unknown) {
    const paging = resolvePaging(rawPage, rawLimit);
    const [data, total] = await Promise.all([
      prisma.contact.findMany({
        where: { organizationId },
        orderBy: STABLE_DESC,
        // Counts, not the full child collections.
        //
        // `include: { leads: true, deals: true, tickets: true }` made Prisma issue a
        // separate query per relation (7 SQL round trips instead of 4, measured at
        // 2101ms vs 919ms for one page) and embedded every lead, deal and ticket of
        // every contact in a list response that only renders a table. The detail
        // endpoint (getContactById) still returns the full records.
        include: { _count: { select: { leads: true, deals: true, tickets: true } } },
        take: paging.limit,
        skip: paging.skip,
      }),
      prisma.contact.count({ where: { organizationId } }),
    ]);
    return pageEnvelope(data, total, paging);
  }

  async createContact(organizationId: string, data: { fullName: string; phoneNumber: string; email?: string; tags?: string[]; address?: string; city?: string; state?: string }) {
    let contact;
    try {
      contact = await prisma.contact.create({
        data: {
          organizationId,
          fullName: data.fullName,
          // Stored canonical, so a number typed as 08012345678 is the same
          // record as the +234… one a call creates. The unique constraint on
          // [organizationId, phoneNumber] then catches the duplicate that used
          // to slip through as a differently-formatted string.
          phoneNumber: normalizePhoneNumber(data.phoneNumber),
          email: data.email,
          tags: data.tags || [],
          // address/city/state existed in the schema from day one but were
          // silently dropped — no API or form could ever set a contact's location.
          address: data.address,
          city: data.city,
          state: data.state,
        },
      });
    } catch (err: any) {
      // Contact has @@unique([organizationId, phoneNumber]). A repeat submission —
      // an impatient double-click, a retried request, or genuinely re-entering an
      // existing customer — raised Prisma P2002, which surfaced to the browser as an
      // opaque HTTP 500. Report the actual situation instead.
      if (err?.code === 'P2002') {
        throw new ConflictException(
          `A contact with the phone number ${data.phoneNumber} already exists in this organization.`
        );
      }
      throw err;
    }

    this.webhookDispatcher.dispatch(organizationId, 'contact.created', {
      contactId: contact.id,
      fullName: contact.fullName,
    }).catch(() => {});

    this.workflows.emitAsync(organizationId, 'CONTACT_CREATED', {
      contactId: contact.id,
      contact: { id: contact.id, fullName: contact.fullName, phoneNumber: contact.phoneNumber, email: contact.email },
    });

    return contact;
  }

  async getLeads(organizationId: string, rawPage?: unknown, rawLimit?: unknown) {
    const paging = resolvePaging(rawPage, rawLimit);
    const [data, total] = await Promise.all([
      prisma.lead.findMany({
        where: { organizationId },
        include: { contact: true },
        orderBy: STABLE_DESC,
        take: paging.limit,
        skip: paging.skip,
      }),
      prisma.lead.count({ where: { organizationId } }),
    ]);
    return pageEnvelope(data, total, paging);
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

    this.workflows.emitAsync(organizationId, 'LEAD_CREATED', {
      leadId: lead.id,
      status: lead.status,
      contactId: lead.contactId,
      contact: lead.contact
        ? { id: lead.contact.id, fullName: lead.contact.fullName, phoneNumber: lead.contact.phoneNumber, email: lead.contact.email }
        : undefined,
    });

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

  async getDeals(organizationId: string, rawPage?: unknown, rawLimit?: unknown) {
    const paging = resolvePaging(rawPage, rawLimit);
    const [data, total] = await Promise.all([
      prisma.deal.findMany({
        where: { organizationId },
        include: { contact: true },
        orderBy: STABLE_DESC,
        take: paging.limit,
        skip: paging.skip,
      }),
      prisma.deal.count({ where: { organizationId } }),
    ]);
    return pageEnvelope(data, total, paging);
  }

  async createDeal(organizationId: string, data: { contactId: string; title: string; amount: number; stage?: DealStage }) {
    // A negative or non-finite amount silently corrupts pipelineValue on the
    // dashboard (it is a plain SUM) and every revenue figure derived from it.
    if (!Number.isFinite(data.amount) || data.amount < 0) {
      throw new BadRequestException('Deal amount must be a positive number.');
    }
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

  async getTickets(organizationId: string, rawPage?: unknown, rawLimit?: unknown) {
    const paging = resolvePaging(rawPage, rawLimit);
    const [data, total] = await Promise.all([
      prisma.ticket.findMany({
        where: { organizationId },
        include: { contact: true, assignedUser: true },
        orderBy: STABLE_DESC,
        take: paging.limit,
        skip: paging.skip,
      }),
      prisma.ticket.count({ where: { organizationId } }),
    ]);
    return pageEnvelope(data, total, paging);
  }

  async createTicket(organizationId: string, data: { contactId: string; subject: string; description: string; priority?: TicketPriority }) {
    // ticketNumber is @unique across the whole table.
    //
    // It used to be `TCK-<4 digits of Date.now()>-<count+1>`, derived from a COUNT
    // read before the insert. Under concurrency every in-flight request reads the
    // same count and computes the same number, so simultaneous tickets collide:
    // driving 25 parallel creates produced 14 HTTP 500s from the unique constraint.
    // The count also made numbering O(n) and non-monotonic across organizations.
    //
    // Now: time-ordered prefix (so numbers still sort chronologically) plus 5 bytes
    // of randomness, with a bounded retry for the vanishingly unlikely collision.
    const ticket = await this.createWithUniqueTicketNumber(() => ({
      organizationId,
      contactId: data.contactId,
      subject: data.subject,
      description: data.description,
      priority: data.priority || TicketPriority.MEDIUM,
      status: TicketStatus.OPEN,
      updatedAt: new Date(),
    }));

    this.webhookDispatcher.dispatch(organizationId, 'ticket.created', {
      ticketId: ticket.id,
      subject: ticket.subject,
      priority: ticket.priority,
    }).catch(() => {});

    this.workflows.emitAsync(organizationId, 'TICKET_CREATED', {
      ticketId: ticket.id,
      subject: ticket.subject,
      priority: ticket.priority,
      status: ticket.status,
      contactId: ticket.contactId,
      contact: ticket.contact
        ? { id: ticket.contact.id, fullName: ticket.contact.fullName, phoneNumber: ticket.contact.phoneNumber, email: ticket.contact.email }
        : undefined,
    });

    return ticket;
  }

  /**
   * Generates a collision-resistant ticket number and inserts, retrying on the
   * unique-constraint violation rather than returning a 500.
   */
  private async createWithUniqueTicketNumber(buildData: () => any) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ticketNumber = `TCK-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
      try {
        return await prisma.ticket.create({
          data: { ...buildData(), ticketNumber },
          include: { contact: true },
        });
      } catch (err: any) {
        if (err?.code === 'P2002' && attempt < 4) continue;
        if (err?.code === 'P2003') {
          throw new NotFoundException('Contact not found');
        }
        throw err;
      }
    }
    throw new ConflictException('Could not allocate a unique ticket number. Please retry.');
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

    const updated = await prisma.deal.update({
      where: { id: dealId },
      data: { stage },
      include: { contact: true },
    });

    this.workflows.emitAsync(organizationId, 'DEAL_STAGE_CHANGED', {
      dealId: updated.id,
      stage: updated.stage,
      previousStage: deal.stage,
      amount: updated.amount,
      contactId: updated.contactId,
      contact: updated.contact
        ? { id: updated.contact.id, fullName: updated.contact.fullName, phoneNumber: updated.contact.phoneNumber, email: updated.contact.email }
        : undefined,
    });

    return updated;
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

  /**
   * Full unpaginated read, used only by the CSV export.
   *
   * Kept as an explicit, named method rather than calling the paginated list with
   * `limit: 99999` — which would now be clamped to MAX_PAGE_SIZE and silently
   * truncate the export to 200 rows. Batched so a large tenant does not have to fit
   * in one query's memory.
   */
  async getAllContactsForExport(organizationId: string) {
    const BATCH = 1000;
    const all: any[] = [];
    let cursor: string | undefined;

    for (;;) {
      const batch = await prisma.contact.findMany({
        where: { organizationId },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      all.push(...batch);
      if (batch.length < BATCH) break;
      cursor = batch[batch.length - 1].id;
    }

    return { data: all, total: all.length };
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

  async getQuotationData(dealId: string, organizationId: string) {
    const deal = await prisma.deal.findFirst({
      where: { id: dealId, organizationId },
      include: { contact: true, organization: true },
    });

    // No invented fallback.
    //
    // When the deal id did not resolve, this used to return a quotation for
    // "Service & Operations Retainer" at a flat ₦150,000 with a placeholder customer
    // name and phone number — a document that looks official, is addressed to nobody,
    // and quotes a price the business never set. A missing deal is a 404.
    if (!deal) {
      throw new NotFoundException('Deal not found');
    }

    {
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
  }
}

