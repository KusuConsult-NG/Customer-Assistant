/**
 * Tools a hosted conversational agent calls over HTTP.
 *
 * The platform's business logic stays here. The agent supplies the conversation
 * — turn-taking, speech, language — and calls these to do anything real.
 *
 * ── The contract, and why it is shaped this way ───────────────────────────────
 *
 * Every tool returns a `speak` string: the exact sentence the agent should say.
 * It is not decoration. When a hosted LLM drives the conversation, anything we
 * return as loose data is something it may paraphrase, round, or embellish —
 * and the things these tools return are booking times, reference numbers and
 * bank account details. Returning the finished sentence keeps the wording of
 * consequential facts in this repository, where it can be reviewed and tested,
 * instead of in a prompt.
 *
 * Every tool also FAILS SOFT: no method here throws. A thrown error inside a
 * live call is silence on the line, and the platform's rule is that a customer
 * always gets an honest reply. On failure the tool returns ok:false, a sentence
 * admitting the failure, and handoff:true. This mirrors `toolFailureReply()` in
 * the orchestrator, which exists because an uncaught throw once meant the
 * customer received nothing at all.
 *
 * Tenant scoping comes from the agent key (see agent-key.guard.ts) and is passed
 * in as organizationId — never read from the request body.
 */
import { Injectable, Logger } from '@nestjs/common';
import { prisma, normalizePhoneNumber, phoneNumberVariants } from '@ace/database';
import { TicketPriority } from '@ace/shared-types';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CrmService } from '../crm/crm.service';
import { KnowledgeService } from '../knowledge/knowledge.service';

export interface ToolResult {
  ok: boolean;
  /** The exact sentence the agent should say. Never null. */
  speak: string;
  /** Structured detail, for the agent's own reasoning and for our transcripts. */
  data?: Record<string, unknown>;
  /** True when a human needs to take over. */
  handoff?: boolean;
}

@Injectable()
export class AgentToolsService {
  private readonly log = new Logger('AgentTools');

  constructor(
    private scheduling: SchedulingService,
    private crm: CrmService,
    private knowledge: KnowledgeService
  ) {}

  /**
   * The single place a tool failure becomes words. Keeping it here means no
   * endpoint can invent a cheerier story about what just went wrong.
   */
  private failed(tool: string, err: unknown): ToolResult {
    const message = err instanceof Error ? err.message : String(err);
    this.log.error(`tool_failed tool=${tool} error=${message}`);
    return {
      ok: false,
      speak:
        "I'm sorry — I could not complete that just now. Let me put you through to a member of our team who can help.",
      handoff: true,
      data: { tool, error: message },
    };
  }

  /** Find or create the caller's contact record, so tools have someone to attach to. */
  private async contactFor(organizationId: string, phoneNumber: string, fullName?: string) {
    // Search every shape, store the canonical one. Otherwise the agent creates
    // a second row for a customer it already has, and answers them as a
    // stranger.
    const existing = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
    });
    if (existing) return existing;
    return prisma.contact.create({
      data: {
        organizationId,
        phoneNumber: normalizePhoneNumber(phoneNumber),
        fullName: fullName?.trim() || `Caller (${phoneNumber.slice(-4)})`,
      },
    });
  }

  // ── Identify the caller ────────────────────────────────────────────────────
  async lookupCustomer(organizationId: string, phoneNumber: string): Promise<ToolResult> {
    try {
      const contact = await prisma.contact.findFirst({
        where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
        select: { id: true, fullName: true, email: true },
      });
      if (!contact) {
        return {
          ok: true,
          speak: "I don't have you on file yet — could I take your name?",
          data: { known: false },
        };
      }
      return {
        ok: true,
        speak: `Welcome back, ${contact.fullName}.`,
        data: { known: true, contactId: contact.id, fullName: contact.fullName },
      };
    } catch (e) {
      return this.failed('lookup_customer', e);
    }
  }

  // ── Bookings ───────────────────────────────────────────────────────────────
  async bookAppointment(
    organizationId: string,
    input: {
      phoneNumber: string;
      fullName?: string;
      serviceName: string;
      startTime: string;
      durationMinutes?: number;
      staffName?: string;
      notes?: string;
    }
  ): Promise<ToolResult> {
    try {
      const contact = await this.contactFor(organizationId, input.phoneNumber, input.fullName);
      const booking = await this.scheduling.createBooking(organizationId, {
        contactId: contact.id,
        serviceName: input.serviceName,
        staffName: input.staffName,
        startTime: input.startTime,
        durationMinutes: input.durationMinutes,
        notes: input.notes,
      });

      const when = new Date(booking.startTime).toLocaleString('en-NG', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Africa/Lagos',
      });
      return {
        ok: true,
        speak: `You are booked for ${booking.serviceName} on ${when}. Your reference is ${booking.id.slice(0, 8)}.`,
        data: { bookingId: booking.id, startTime: booking.startTime },
      };
    } catch (e: any) {
      // A slot clash is a legitimate answer, not a malfunction — say so and let
      // the conversation continue rather than escalating to a human.
      const msg = String(e?.message ?? '');
      if (/conflict|already booked|overlap|not available/i.test(msg)) {
        return {
          ok: false,
          speak: 'That time has just been taken. Could we find another time that works for you?',
          data: { reason: 'slot_unavailable' },
        };
      }
      return this.failed('book_appointment', e);
    }
  }

  async checkBooking(organizationId: string, phoneNumber: string): Promise<ToolResult> {
    try {
      const booking = await this.scheduling.getActiveBookingByPhone(organizationId, phoneNumber);
      if (!booking) {
        return {
          ok: true,
          speak: "I can't find an upcoming appointment under this number.",
          data: { found: false },
        };
      }
      const when = new Date(booking.startTime).toLocaleString('en-NG', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Africa/Lagos',
      });
      return {
        ok: true,
        speak: `You have ${booking.serviceName} booked for ${when}.`,
        data: { found: true, bookingId: booking.id, status: booking.status },
      };
    } catch (e) {
      return this.failed('check_booking', e);
    }
  }

  async cancelBooking(
    organizationId: string,
    phoneNumber: string,
    reason?: string
  ): Promise<ToolResult> {
    try {
      const booking = await this.scheduling.getActiveBookingByPhone(organizationId, phoneNumber);
      if (!booking) {
        return {
          ok: true,
          speak: "I can't find an upcoming appointment under this number to cancel.",
          data: { found: false },
        };
      }
      await this.scheduling.cancelBooking(organizationId, booking.id, reason);
      return {
        ok: true,
        speak: `Your ${booking.serviceName} appointment has been cancelled.`,
        data: { bookingId: booking.id },
      };
    } catch (e) {
      return this.failed('cancel_booking', e);
    }
  }

  async rescheduleBooking(
    organizationId: string,
    phoneNumber: string,
    newStartTime: string
  ): Promise<ToolResult> {
    try {
      const booking = await this.scheduling.getActiveBookingByPhone(organizationId, phoneNumber);
      if (!booking) {
        return {
          ok: true,
          speak: "I can't find an upcoming appointment under this number to move.",
          data: { found: false },
        };
      }
      const updated = await this.scheduling.rescheduleBooking(
        organizationId,
        booking.id,
        newStartTime
      );
      const when = new Date(updated.startTime).toLocaleString('en-NG', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'Africa/Lagos',
      });
      return {
        ok: true,
        speak: `Your appointment has been moved to ${when}.`,
        data: { bookingId: updated.id, startTime: updated.startTime },
      };
    } catch (e: any) {
      if (/conflict|already booked|overlap|not available/i.test(String(e?.message ?? ''))) {
        return {
          ok: false,
          speak: 'That new time is not available. Could we try another?',
          data: { reason: 'slot_unavailable' },
        };
      }
      return this.failed('reschedule_booking', e);
    }
  }

  // ── Support ────────────────────────────────────────────────────────────────
  async createTicket(
    organizationId: string,
    input: { phoneNumber: string; fullName?: string; subject: string; description: string }
  ): Promise<ToolResult> {
    try {
      const contact = await this.contactFor(organizationId, input.phoneNumber, input.fullName);
      const ticket = await this.crm.createTicket(organizationId, {
        contactId: contact.id,
        subject: input.subject,
        description: input.description,
        priority: TicketPriority.HIGH,
      });
      return {
        ok: true,
        speak: `I have logged this for our team. Your reference is ${ticket.id.slice(0, 8)}, and someone will come back to you on this number.`,
        data: { ticketId: ticket.id },
      };
    } catch (e) {
      return this.failed('create_ticket', e);
    }
  }

  // ── Payment details ────────────────────────────────────────────────────────
  /**
   * Reads ONLY the organization's configured payout fields. Unset means we say
   * we cannot give account details, never that we improvise plausible ones —
   * an invented account number is money sent to a stranger.
   */
  async paymentDetails(organizationId: string): Promise<ToolResult> {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
          payoutBankName: true,
          payoutAccountName: true,
          payoutAccountNumber: true,
          payoutUssdCode: true,
        },
      });

      if (!org?.payoutBankName || !org?.payoutAccountName || !org?.payoutAccountNumber) {
        return {
          ok: false,
          speak:
            'I am not able to give out account details myself. Let me put you through to a colleague who can take payment safely.',
          handoff: true,
          data: { reason: 'payout_not_configured' },
        };
      }

      const ussd = org.payoutUssdCode ? ` You can also dial ${org.payoutUssdCode}.` : '';
      return {
        ok: true,
        speak: `Payment goes to ${org.payoutAccountName}, ${org.payoutBankName}, account number ${org.payoutAccountNumber}.${ussd}`,
        data: {
          bankName: org.payoutBankName,
          accountName: org.payoutAccountName,
          accountNumber: org.payoutAccountNumber,
          ussdCode: org.payoutUssdCode,
        },
      };
    } catch (e) {
      return this.failed('payment_details', e);
    }
  }

  // ── Knowledge ──────────────────────────────────────────────────────────────
  /**
   * FAQs first, then the knowledge base. Returns the stored answer verbatim so
   * the agent repeats what the business wrote rather than a paraphrase of it.
   */
  async searchKnowledge(organizationId: string, query: string): Promise<ToolResult> {
    try {
      const q = (query ?? '').trim();
      if (!q) {
        return { ok: true, speak: 'Could you tell me a little more about what you need?', data: {} };
      }

      const faqs = await prisma.faqEntry.findMany({
        where: { organizationId },
        select: { question: true, answer: true },
      });
      const needle = q.toLowerCase();
      const hit = faqs.find(
        (f) =>
          f.question.toLowerCase().includes(needle) || needle.includes(f.question.toLowerCase())
      );
      if (hit) return { ok: true, speak: hit.answer, data: { source: 'faq' } };

      const results = await this.knowledge.searchPlayground(organizationId, q).catch(() => null);
      const top = Array.isArray(results) ? results[0] : null;
      if (top?.content) {
        return { ok: true, speak: String(top.content).slice(0, 600), data: { source: 'knowledge' } };
      }

      // Saying "I don't know, let me get someone" is a correct answer here. The
      // alternative — letting the model fill the gap — is how a customer gets
      // told something the business never said.
      return {
        ok: true,
        speak:
          "I don't have that detail to hand. Would you like me to pass you to someone who does?",
        data: { source: 'none' },
      };
    } catch (e) {
      return this.failed('search_knowledge', e);
    }
  }

  // ── Handoff ────────────────────────────────────────────────────────────────
  /**
   * Reports whether a transfer is actually possible. The agent must not promise
   * a transfer this returns false for — announcing one that cannot happen is
   * exactly the bug the voice path was fixed for.
   */
  async handoffTarget(organizationId: string): Promise<ToolResult> {
    try {
      // The forwarding number lives on TelephonyConfig, not Organization — a
      // tenant can exist with no telephony configured at all.
      const telephony = await prisma.telephonyConfig.findFirst({
        where: { organizationId },
        select: { forwardingNumber: true },
      });
      if (!telephony?.forwardingNumber) {
        return {
          ok: false,
          speak:
            'I cannot transfer you right now, but I will log this so a member of our team calls you back on this number.',
          data: { canTransfer: false },
        };
      }
      return {
        ok: true,
        speak: 'Connecting you to a member of our team now. One moment please.',
        data: { canTransfer: true, forwardingNumber: telephony.forwardingNumber },
      };
    } catch (e) {
      return this.failed('handoff_target', e);
    }
  }
}
