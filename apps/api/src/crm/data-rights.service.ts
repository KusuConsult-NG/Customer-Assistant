import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { prisma, recordAgencyAudit, Prisma, type Actor } from '@ace/database';

const ERASED = '[erased at the citizen’s request]';

/**
 * A citizen's rights over what the agency holds about them (PRD §18,
 * Nigeria Data Protection Act 2023: access and erasure).
 *
 * ── Export ──────────────────────────────────────────────────────────────────
 * Everything keyed to the contact, in one JSON document: the record, every
 * message, call, case, callback, booking, note and consent record. What a
 * citizen who asks "what do you have on me?" is entitled to see.
 *
 * ── Erasure ─────────────────────────────────────────────────────────────────
 * ANONYMISES rather than deletes. The personal content goes — name, number,
 * email, address, message text, transcripts, recordings, case descriptions,
 * notes — and the fact that a conversation, call or case EXISTED stays,
 * because the agency's own record of service (and its statistics) is not the
 * citizen's personal data, and deleting the rows would silently rewrite
 * history every dashboard and report depends on.
 *
 * It is irreversible, so it needs `confirm: "ERASE"` and a reason, is
 * OWNER/ADMIN only, is audited, and leaves a consent record saying processing
 * was withdrawn. Open callbacks are cancelled: nobody should ring a number
 * that has been erased.
 */
@Injectable()
export class DataRightsService {
  private async contact(organizationId: string, contactId: string) {
    const c = await prisma.contact.findFirst({ where: { id: contactId, organizationId } });
    if (!c) throw new NotFoundException('Contact not found.');
    return c;
  }

  async export(organizationId: string, contactId: string, actor: Actor) {
    const contact = await this.contact(organizationId, contactId);
    const [conversations, calls, cases, callbacks, bookings, reservations, notes, consents, leads] = await Promise.all([
      prisma.conversation.findMany({
        where: { organizationId, contactId },
        include: { messages: { orderBy: { sentAt: 'asc' }, select: { sender: true, content: true, mediaType: true, sentAt: true } } },
      }),
      prisma.callLog.findMany({
        where: { organizationId, contactId },
        select: { direction: true, status: true, startedAt: true, endedAt: true, durationSeconds: true, transcript: true, summary: true },
      }),
      prisma.ticket.findMany({
        where: { organizationId, contactId },
        select: { ticketNumber: true, subject: true, description: true, category: true, caseStage: true, lga: true, createdAt: true, resolutionOutcome: true },
      }),
      prisma.callbackRequest.findMany({
        where: { organizationId, contactId },
        select: { phoneNumber: true, reason: true, status: true, dueAt: true, createdAt: true },
      }),
      prisma.booking.findMany({ where: { organizationId, contactId } }),
      prisma.reservation.findMany({ where: { organizationId, contactId } }),
      prisma.note.findMany({ where: { contactId }, select: { content: true, createdAt: true } }),
      prisma.consentRecord.findMany({ where: { organizationId, contactId }, orderBy: { createdAt: 'asc' } }),
      prisma.lead.findMany({ where: { organizationId, contactId } }),
    ]);
    await recordAgencyAudit(actor, organizationId, {
      action: 'citizen.data_exported',
      targetType: 'Contact',
      targetId: contactId,
    });
    return {
      exportedAt: new Date().toISOString(),
      contact: {
        fullName: contact.fullName,
        phoneNumber: contact.phoneNumber,
        email: contact.email,
        address: contact.address,
        city: contact.city,
        state: contact.state,
        preferredLanguage: contact.preferredLanguage,
        createdAt: contact.createdAt,
      },
      conversations: conversations.map((c) => ({ channel: c.channel, startedAt: c.createdAt, messages: c.messages })),
      calls,
      cases,
      callbacks,
      bookings,
      reservations,
      notes,
      leads,
      consents: consents.map((c) => ({ purpose: c.purpose, granted: c.granted, channel: c.channel, text: c.evidence, at: c.createdAt })),
    };
  }

  async erase(organizationId: string, contactId: string, actor: Actor, body: { confirm?: string; reason?: string }) {
    if (body?.confirm !== 'ERASE') throw new BadRequestException('Type ERASE to confirm. This cannot be undone.');
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestException('Record why the data is being erased (for example, the citizen’s request and its date).');
    const contact = await this.contact(organizationId, contactId);
    if (contact.phoneNumber.startsWith('erased-')) throw new BadRequestException('This contact has already been erased.');

    const convIds = (await prisma.conversation.findMany({ where: { organizationId, contactId }, select: { id: true } })).map((c) => c.id);
    const ticketIds = (await prisma.ticket.findMany({ where: { organizationId, contactId }, select: { id: true } })).map((t) => t.id);

    const counts = await prisma.$transaction(async (tx) => {
      const messages = await tx.message.updateMany({ where: { conversationId: { in: convIds } }, data: { content: ERASED, mediaUrl: null, metadata: Prisma.DbNull } });
      const calls = await tx.callLog.updateMany({
        where: { organizationId, contactId },
        data: { transcript: null, summary: ERASED, recordingUrl: null, fromNumber: 'erased', toNumber: 'erased' },
      });
      const cases = await tx.ticket.updateMany({ where: { id: { in: ticketIds } }, data: { subject: ERASED, description: ERASED, summary: null, community: null, ward: null } });
      await tx.caseEvent.updateMany({ where: { ticketId: { in: ticketIds } }, data: { body: ERASED } });
      await tx.callbackRequest.updateMany({
        where: { organizationId, contactId, status: { in: ['PENDING', 'DUE', 'IN_PROGRESS'] } },
        data: { status: 'CANCELLED', failureReason: 'Citizen data erased' },
      });
      const callbacks = await tx.callbackRequest.updateMany({ where: { organizationId, contactId }, data: { phoneNumber: 'erased', reason: ERASED, preferredTime: null } });
      await tx.booking.updateMany({ where: { organizationId, contactId }, data: { notes: null } });
      await tx.reservation.updateMany({ where: { organizationId, contactId }, data: { specialRequests: null } });
      await tx.lead.updateMany({ where: { organizationId, contactId }, data: { notes: null } });
      await tx.note.updateMany({ where: { contactId }, data: { content: ERASED } });
      await tx.contact.update({
        where: { id: contactId },
        data: {
          fullName: 'Erased citizen',
          // Unique per agency, and no longer a number anyone can match or ring.
          phoneNumber: `erased-${contactId}`,
          email: null,
          address: null,
          city: null,
          state: null,
          tags: [],
          metadata: Prisma.DbNull,
        },
      });
      await tx.consentRecord.create({
        data: { organizationId, contactId, purpose: 'DATA_PROCESSING', granted: false, channel: 'DASHBOARD', evidence: `Erased: ${reason}` },
      });
      return { messages: messages.count, calls: calls.count, cases: cases.count, callbacks: callbacks.count };
    });

    await recordAgencyAudit(actor, organizationId, {
      action: 'citizen.data_erased',
      targetType: 'Contact',
      targetId: contactId,
      newValue: { reason, ...counts },
    });
    return { erased: true, ...counts };
  }
}
