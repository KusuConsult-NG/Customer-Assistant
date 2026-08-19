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
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { prisma, normalizePhoneNumber, phoneNumberVariants, getFacilitiesForLGA, isAccreditedFacility, facilitiesForLGAAsText } from '@ace/database';
import { TicketPriority } from '@ace/shared-types';
import { SchedulingService } from '../scheduling/scheduling.service';
import { CrmService } from '../crm/crm.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ElevenLabsTakeoverService } from './elevenlabs-takeover.service';
import { OnboardingService } from '../onboarding/onboarding.service';

export interface ToolResult {
  ok: boolean;
  /** The exact sentence the agent should say. Never null. */
  speak: string;
  /** Structured detail, for the agent's own reasoning and for our transcripts. */
  data?: Record<string, unknown>;
  /** True when a human needs to take over. */
  handoff?: boolean;
}

/**
 * Was this "that time is taken", or something actually broken?
 *
 * It used to be decided by regexing the exception's English message for
 * /conflict|already booked|overlap|not available/. SchedulingService throws
 * "That slot is already taken by …" and "That slot was just taken by another
 * booking" — none of which contain any of those four words. So every ordinary
 * slot clash was reported to the customer as "I could not complete that just
 * now. Let me put you through to a member of our team", and escalated to a
 * human, which is precisely the opposite of what the branch was written to do.
 *
 * Reproduced: booking the same slot twice through the tool handed the second
 * caller the failure reply and a handoff.
 *
 * Matching on the HTTP status instead. SchedulingService raises
 * ConflictException — and only for a slot conflict — in both the
 * application-level check and the translation of the database EXCLUDE
 * constraint, so 409 covers both without depending on wording that has already
 * changed once.
 */
function isSlotClash(err: unknown): boolean {
  return err instanceof HttpException && err.getStatus() === HttpStatus.CONFLICT;
}

@Injectable()
export class AgentToolsService {
  private readonly log = new Logger('AgentTools');

  constructor(
    private scheduling: SchedulingService,
    private crm: CrmService,
    private knowledge: KnowledgeService,
    // One implementation of "move the call", shared with the console's takeover
    // button. A second would be a second thing that can silently stop moving it.
    private takeover: ElevenLabsTakeoverService,
    private onboarding: OnboardingService
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
      if (isSlotClash(e)) {
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
          ok: false,
          speak: "I can't find an upcoming appointment under this number. Are you sure you have a booking with us?",
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
          ok: false,
          speak: "I can't find an upcoming appointment under this number. Are you sure you have a booking with us?",
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
      if (isSlotClash(e)) {
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
      const text = `${input.subject} ${input.description}`.toLowerCase();
      const isHospitalMisconduct =
        /extortion|illegal|bribe|demand|money|cash|pay|refus|deny|denied|stockout|no drug|medicine|mistreat/i.test(text);

      const priority = isHospitalMisconduct ? TicketPriority.URGENT : TicketPriority.HIGH;
      const subject = isHospitalMisconduct
        ? `[QA ESCALATION] ${input.subject}`
        : input.subject;

      const ticket = await this.crm.createTicket(organizationId, {
        contactId: contact.id,
        subject,
        description: input.description,
        priority,
      });

      // If it is hospital misconduct, add an audit note
      if (isHospitalMisconduct) {
        await prisma.note.create({
          data: {
            contactId: contact.id,
            content: `🚨 URGENT HOSPITAL GRIEVANCE LOGGED: ${input.subject} — Escalated to PLASCHEMA Quality Assurance & Standards Division.`,
          },
        }).catch(() => {});
      }

      return {
        ok: true,
        speak: isHospitalMisconduct
          ? `I have logged this as an urgent grievance for our Quality Assurance desk. Your complaint reference number is ${ticket.id.slice(0, 8)}. Our team will investigate with the hospital medical director immediately. Please keep your PLASCHEMA card with you, and call us back on 0700-700-1111 if you need immediate assistance.`
          : `I have logged this for our team. Your reference is ${ticket.id.slice(0, 8)}, and someone will come back to you on this number.`,
        data: { ticketId: ticket.id, isEscalated: isHospitalMisconduct },
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
   * FAQs first (keyword-scored), then the knowledge base.
   * Markdown is stripped from chunk content — a voice agent must never read
   * '#', '**', or '---' aloud.
   */
  async searchKnowledge(organizationId: string, query: string): Promise<ToolResult> {
    try {
      const q = (query ?? '').trim();
      if (!q) {
        return { ok: true, speak: 'Could you tell me a little more about what you need?', data: {} };
      }

      /** Strip markdown so Sarah speaks clean plain-English sentences */
      const stripMd = (text: string): string =>
        text
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/\*\*(.+?)\*\*/g, '$1')
          .replace(/\*(.+?)\*/g, '$1')
          .replace(/^[-*]\s+/gm, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/`{1,3}[^`]*`{1,3}/g, '')
          .replace(/---+/g, '')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

      // Score every active FAQ by keyword overlap with the query
      const faqs = await prisma.faqEntry.findMany({
        where: { organizationId, isActive: true },
        select: { question: true, answer: true },
      });
      const needle = q.toLowerCase();
      const needleWords = needle.split(/\s+/).filter((w) => w.length > 3);

      const scored = faqs
        .map((f) => {
          const qLower = f.question.toLowerCase();
          if (qLower.includes(needle) || needle.includes(qLower)) return { f, score: 100 };
          const hits = needleWords.filter((w) => qLower.includes(w)).length;
          return { f, score: hits };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

      if (scored.length > 0) {
        return { ok: true, speak: scored[0].f.answer, data: { source: 'faq' } };
      }

      // Knowledge base fallback — strip markdown before speaking
      const results = await this.knowledge.searchPlayground(organizationId, q).catch(() => null);
      const top = Array.isArray(results) ? results[0] : null;
      if (top?.content) {
        const spoken = stripMd(String(top.content)).slice(0, 500);
        return { ok: true, speak: spoken, data: { source: 'knowledge' } };
      }

      return {
        ok: true,
        speak: "I don't have that detail to hand. Would you like me to pass you to someone who does?",
        data: { source: 'none' },
      };
    } catch (e) {
      return this.failed('search_knowledge', e);
    }
  }


  // ── Handoff ────────────────────────────────────────────────────────────────
  /**
   * Put the caller through to a person, or say honestly why that did not
   * happen — and leave a record either way.
   *
   * ── What this used to do, and why it was the same bug twice ────────────────
   *
   * It checked whether a forwarding number was CONFIGURED and, if one was, told
   * the agent to say "Connecting you to a member of our team now." Nothing was
   * attempted. The call was never moved. On the orchestrator path a customer
   * hearing that sentence really is being transferred, because
   * TwilioMediaStreamHandler redirects the call BEFORE anything is spoken and
   * chooses the words from what Twilio actually did. Here the sentence was the
   * whole action — the exact bug the voice path was fixed for, reintroduced on
   * the path meant to replace it.
   *
   * Worse, the other branch said "I will log this so a member of our team calls
   * you back" and logged nothing. A promise of a record that does not exist is
   * not a degradation, it is a lie the customer acts on by hanging up and
   * waiting.
   *
   * ── Act, then announce ─────────────────────────────────────────────────────
   *
   * With a conversation id the transfer is ATTEMPTED first, through the same
   * ElevenLabsTakeoverService the console uses — one implementation of "move the
   * call", because a second one is a second thing that can silently stop moving
   * it — and the sentence is chosen from the outcome.
   *
   * Without one, or when the carrier refuses, NOTHING IS CLAIMED. A HIGH
   * priority ticket is filed against the caller's number and the reference is
   * read back, which is exactly what the orchestrator's voice path does when it
   * cannot transfer.
   *
   * ── The conversation id may not arrive, and that is survivable ─────────────
   *
   * It is bound to a provider dynamic variable whose name is documented but has
   * never been confirmed against a live call from this environment — the same
   * caveat as the webhook signature header. So the absent case is not a
   * degraded path bolted on for safety; it is the path that runs until a real
   * call proves otherwise, and it is correct on its own. What arrives is logged
   * so the first real call settles it.
   */
  async handoffTarget(
    organizationId: string,
    input: { phoneNumber?: string; conversationId?: string; reason?: string } = {}
  ): Promise<ToolResult> {
    try {
      const conversationId = input.conversationId?.trim();
      this.log.log(
        `handoff_requested org=${organizationId} conversation=${conversationId ?? '(none supplied)'}`
      );

      if (conversationId) {
        // Act. Throws are caught below and fall through to the ticket, so a
        // provider failure never becomes a promise either.
        const outcome = await this.takeover
          .takeOverConversation(organizationId, conversationId)
          .catch((err) => {
            this.log.warn(`handoff_transfer_error org=${organizationId} error=${String(err?.message ?? err)}`);
            return { taken: false as const, reason: 'the transfer could not be attempted' };
          });

        if (outcome.taken) {
          // Announce, and only now. The call really has moved.
          return {
            ok: true,
            speak: 'You are being connected to a member of our team now.',
            data: { transferred: true, conversationId },
          };
        }
        this.log.warn(
          `handoff_not_transferred org=${organizationId} conversation=${conversationId} reason=${outcome.reason}`
        );
      }

      // Could not transfer — either no call to move, or the carrier refused.
      // Leave the record the wording promises, then say precisely what happened.
      return this.handoffFallback(organizationId, input, conversationId);
    } catch (e) {
      return this.failed('handoff_target', e);
    }
  }

  /**
   * No transfer happened. File the callback the customer is about to be
   * promised, and read back its reference so they have something to quote.
   *
   * With no phone number there is nobody to attach a ticket to, and inventing a
   * contact to hold it would be a record of a customer who does not exist — so
   * that case says plainly that it could not log anything rather than claiming
   * it did.
   */
  private async handoffFallback(
    organizationId: string,
    input: { phoneNumber?: string; reason?: string },
    conversationId?: string
  ): Promise<ToolResult> {
    const phoneNumber = input.phoneNumber?.trim();
    if (!phoneNumber) {
      return {
        ok: false,
        speak:
          'I am not able to put you through myself. Please hold the line and I will stay with you, or call back and ask for a member of the team.',
        handoff: true,
        data: { transferred: false, ticketId: null, reason: 'no caller number to log against' },
      };
    }

    try {
      const contact = await this.contactFor(organizationId, phoneNumber);
      const ticket = await this.crm.createTicket(organizationId, {
        contactId: contact.id,
        subject: 'Caller asked to speak to a person',
        description:
          `The agent could not transfer this caller.` +
          (input.reason ? ` They asked about: ${input.reason}.` : '') +
          (conversationId ? ` ElevenLabs conversation ${conversationId}.` : ''),
        priority: TicketPriority.HIGH,
      });
      return {
        ok: true,
        speak: `I cannot put you through myself, but I have logged this for our team. Your reference is ${ticket.id.slice(0, 8)}, and someone will call you back on this number.`,
        handoff: true,
        data: { transferred: false, ticketId: ticket.id },
      };
    } catch (e) {
      // The ticket is what makes the sentence true, so if it could not be
      // written the sentence must not be said.
      this.log.error(`handoff_ticket_failed org=${organizationId} error=${String((e as any)?.message ?? e)}`);
      return {
        ok: false,
        speak:
          'I am not able to put you through, and I could not log a callback either. Please call back and ask for a member of the team — I am sorry.',
        handoff: true,
        data: { transferred: false, ticketId: null },
      };
    }
  }

  // ── PLASCHEMA enrollment registration ──────────────────────────────────────
  /**
   * Creates (or updates) a contact record with enrollment details collected
   * during the call, then fires the selfie-capture link to their WhatsApp.
   *
   * Sarah calls this once she has collected: full name, LGA, phone (caller
   * phone is injected by the platform), NIN, and plan type. The tool creates
   * the contact, stores the enrollment details, and triggers the onboarding
   * service to send a one-time selfie link via WhatsApp. Sarah then tells the
   * caller to check their WhatsApp for the photo link to complete registration online.
   */
  async registerEnrollee(
    organizationId: string,
    input: {
      phoneNumber?: string;
      fullName: string;
      residentialAddress?: string;
      lga: string;
      ageOrDob?: string;
      nin?: string;
      planType: string;
      preferredHospital?: string;
      notes?: string;
    }
  ): Promise<ToolResult> {
    try {
      // Guard: fullName must be a non-empty string.
      if (!input.fullName?.trim()) {
        return {
          ok: false,
          speak: 'I still need your full name to complete your registration. Could you tell me your full name please?',
          data: { reason: 'missing_full_name' },
        };
      }

      // Guard: ageOrDob must be provided
      if (!input.ageOrDob?.trim()) {
        return {
          ok: false,
          speak: 'Could you tell me your age or date of birth so we can include it on your health profile?',
          data: { reason: 'missing_age_or_dob' },
        };
      }

      // Guard: residentialAddress must be provided
      if (!input.residentialAddress?.trim() || input.residentialAddress.trim().length < 3) {
        return {
          ok: false,
          speak: 'Could you tell me your residential street address or area where you live in Plateau State?',
          data: { reason: 'missing_residential_address' },
        };
      }

      // Guard: lga must be provided
      if (!input.lga?.trim()) {
        return {
          ok: false,
          speak: 'Which Local Government Area in Plateau State do you reside in?',
          data: { reason: 'missing_lga' },
        };
      }

      // Guard: planType must be provided
      if (!input.planType?.trim()) {
        return {
          ok: false,
          speak: 'Which health plan would you like to enroll in? Formal Sector, Informal Sector, BHCPF, or the free Equity Programme?',
          data: { reason: 'missing_plan_type' },
        };
      }

      // Guard: preferredHospital must be provided
      if (!input.preferredHospital?.trim()) {
        const facs = getFacilitiesForLGA(input.lga).slice(0, 3).map((f) => f.name).join(', ');
        return {
          ok: false,
          speak: `Which primary hospital or healthcare facility in ${input.lga} would you prefer? For example: ${facs || 'your nearest General Hospital'}.`,
          data: { reason: 'missing_preferred_hospital' },
        };
      }

      const cleanPhone = input.phoneNumber?.trim()
        ? normalizePhoneNumber(input.phoneNumber)
        : `+23480${Math.floor(10000000 + Math.random() * 90000000)}`;

      // Resolve accredited facility for this LGA
      const lgaFacilities = getFacilitiesForLGA(input.lga);
      let selectedFacility = input.preferredHospital?.trim();
      if (selectedFacility && lgaFacilities.length > 0) {
        const matched = lgaFacilities.find(
          (f) => f.name.toLowerCase() === selectedFacility!.toLowerCase() || f.name.toLowerCase().includes(selectedFacility!.toLowerCase())
        );
        if (matched) selectedFacility = matched.name;
      }
      if (!selectedFacility && lgaFacilities.length > 0) {
        selectedFacility = lgaFacilities[0].name;
      }
      if (!selectedFacility) {
        selectedFacility = input.preferredHospital?.trim() || 'Accredited Primary Healthcare Provider';
      }

      const isEquity = /equity|bhcpf|vulnerable|free/i.test(input.planType);
      const normalizedPlan = isEquity
        ? 'Equity / BHCPF Subsidized Plan'
        : input.planType;

      const existing = await prisma.contact.findFirst({
        where: { organizationId, phoneNumber: { in: phoneNumberVariants(cleanPhone) } },
      });

      const enrollmentDetails = [
        `Address: ${input.residentialAddress || 'N/A'}`,
        `LGA: ${input.lga}`,
        input.ageOrDob ? `Age/DOB: ${input.ageOrDob}` : null,
        `Plan: ${normalizedPlan}`,
        `Primary Facility: ${selectedFacility}`,
        input.nin ? `NIN: ${input.nin}` : null,
        isEquity ? 'Status: 100% State Subsidized (₦0)' : null,
        input.notes || null,
      ]
        .filter(Boolean)
        .join(' | ');

      let contact;
      if (existing) {
        contact = await prisma.contact.update({
          where: { id: existing.id },
          data: {
            fullName: input.fullName.trim(),
            address: input.residentialAddress?.trim() || existing.address,
            city: input.lga.trim(),
            metadata: {
              ...(typeof existing.metadata === 'object' && existing.metadata !== null ? (existing.metadata as Record<string, unknown>) : {}),
              residentialAddress: input.residentialAddress,
              lga: input.lga,
              ageOrDob: input.ageOrDob,
              nin: input.nin,
              planType: normalizedPlan,
              preferredHospital: selectedFacility,
              isEquity,
              enrollmentStatus: isEquity ? 'PENDING_EQUITY_REVIEW' : 'PENDING_SELFIE',
              paymentStatus: isEquity ? 'WAIVED_SUBSIDIZED' : 'PENDING',
              registeredAt: new Date().toISOString(),
            },
            tags: existing.tags.includes('enrollment-pending')
              ? existing.tags
              : [...existing.tags, 'enrollment-pending'],
          },
        });
      } else {
        contact = await prisma.contact.create({
          data: {
            organizationId,
            phoneNumber: cleanPhone,
            fullName: input.fullName.trim(),
            address: input.residentialAddress?.trim(),
            city: input.lga.trim(),
            metadata: {
              residentialAddress: input.residentialAddress,
              lga: input.lga,
              ageOrDob: input.ageOrDob,
              nin: input.nin,
              planType: normalizedPlan,
              preferredHospital: selectedFacility,
              isEquity,
              enrollmentStatus: isEquity ? 'PENDING_EQUITY_REVIEW' : 'PENDING_SELFIE',
              paymentStatus: isEquity ? 'WAIVED_SUBSIDIZED' : 'PENDING',
              registeredAt: new Date().toISOString(),
            },
            tags: ['enrollment-pending'],
          },
        });
      }

      // Save a note for audit/record keeping
      await prisma.note
        .create({
          data: {
            contactId: contact.id,
            content: `Helpline Enrollment Registration: ${enrollmentDetails}`,
          },
        })
        .catch(() => {});

      // Send the selfie link via WhatsApp/SMS
      const selfieResult = await this.onboarding.requestSelfie(organizationId, {
        contactId: contact.id,
        channel: 'VOICE',
        purpose: isEquity ? 'PLASCHEMA Equity free coverage verification' : 'PLASCHEMA health plan registration',
        expiresInHours: 48,
      });

      const refId = contact.id.slice(0, 8).toUpperCase();
      const selfieDelivered = selfieResult.delivery?.delivered ?? false;
      const firstName = input.fullName.split(' ')[0];

      if (selfieDelivered) {
        if (isEquity) {
          return {
            ok: true,
            speak: `Thank you, ${firstName}. I have registered your profile for the free PLASCHEMA Equity Programme in ${input.lga} with ${selectedFacility} as your primary facility. Because you qualify for the state-subsidized programme, you do NOT need to pay any premium. Your enrollment reference is ${refId}. I have just sent a secure photo link to your phone. Please open WhatsApp or SMS, tap the link, and take a quick selfie to finish your registration. Our team will verify your eligibility and issue your health card within 2 business days. Is there anything else I can assist you with?`,
            data: {
              contactId: contact.id,
              refId,
              selfieRequestId: selfieResult.id,
              selfieDelivered: true,
              uploadUrl: selfieResult.uploadUrl,
              isEquity: true,
            },
          };
        } else {
          return {
            ok: true,
            speak: `Thank you, ${firstName}. I have registered your profile for the PLASCHEMA ${input.planType} plan in ${input.lga} with ${selectedFacility} as your primary healthcare facility. Your enrollment reference is ${refId}. I have just sent a secure photo and payment link to your phone. Please open WhatsApp or SMS, tap the link, and take a quick selfie to complete your profile. Our team will activate your health coverage within 2 business days. Is there anything else I can help you with today?`,
            data: {
              contactId: contact.id,
              refId,
              selfieRequestId: selfieResult.id,
              selfieDelivered: true,
              uploadUrl: selfieResult.uploadUrl,
            },
          };
        }
      } else {
        return {
          ok: true,
          speak: `Thank you, ${firstName}. I have registered your profile for the PLASCHEMA ${normalizedPlan} in ${input.lga} with ${selectedFacility} as your primary facility. Your enrollment reference is ${refId}. You can complete your photo upload online at enrollments dot plaschema dot app, or visit any PLASCHEMA desk in ${input.lga} with your reference number. Is there anything else I can assist you with?`,
          data: {
            contactId: contact.id,
            refId,
            selfieRequestId: selfieResult.id,
            selfieDelivered: false,
            uploadUrl: selfieResult.uploadUrl,
          },
        };
      }
    } catch (e) {
      return this.failed('register_enrollee', e);
    }
  }
}
