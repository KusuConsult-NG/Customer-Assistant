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
import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { relevantPassage } from './relevant-passage';
import { prisma, normalizePhoneNumber, phoneNumberVariants, ensureContactForPhone, isPlaceholderContactName, loadServiceCatalogue, locationsInLga, resolveLocation, resolveLga, upsertEnrollee, findAvailableSlots, serviceHoursFrom, formatLagos, BUSY_BOOKING_STATUSES, callbackReference, bookingReference, nextServiceTime, outboundContactHoursFrom, OPEN_CALLBACK_STATUSES } from '@ace/database';
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

  /**
   * The caller's contact record, so tools have someone to attach to.
   *
   * Delegates to the shared helper rather than carrying its own copy. The copy
   * that used to live here differed in three ways that each cost something: it
   * created a row for a withheld number (one record shared by every withheld
   * caller in the State), it had no retry when two first calls arrived at once
   * (so a booking failed and the caller was handed to a human), and it wrote a
   * fourth placeholder format. It also never wrote the name the caller gave
   * back to the record the greeting is read from.
   */
  private async contactFor(organizationId: string, phoneNumber: string, fullName?: string) {
    const contact = await ensureContactForPhone(prisma, organizationId, phoneNumber, fullName);
    if (!contact) {
      // Withheld number. Say so rather than filing against a shared row.
      throw new BadRequestException(
        'I could not tell what number you are calling from, so I cannot look up or save your record. ' +
        'Let me put you through to a colleague.'
      );
    }
    return contact;
  }

  // ── Identify the caller ────────────────────────────────────────────────────
  /**
   * Who is calling, and what we already owe them.
   *
   * ── What was wrong ──────────────────────────────────────────────────────────
   *
   * This returned the name and nothing else. So a citizen with an appointment
   * the next morning, an open complaint and a callback we had promised rang in
   * and was asked "how can I help you today?" — by a system that had just read
   * her record and knew all three. The caller then has to explain, from memory,
   * business the agency is already holding, and an agency that cannot recall
   * its own promise is the thing a care line exists to stop being.
   *
   * It is one query per kind of pending business, for the record we already
   * found, and the result is SAID rather than only returned: anything handed
   * over as loose data is something the model may leave out.
   *
   * Nothing here is inferred. An absent appointment is reported as none, never
   * softened into "I think you had something with us".
   */
  async lookupCustomer(organizationId: string, phoneNumber: string): Promise<ToolResult> {
    try {
      const contact = await prisma.contact.findFirst({
        where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
        select: { id: true, fullName: true, email: true, city: true, address: true, preferredLanguage: true, metadata: true },
      });
      if (!contact) {
        return {
          ok: true,
          speak: "I don't have you on file yet — could I take your name?",
          data: { known: false },
        };
      }

      const now = new Date();
      const [upcoming, openCallback, openTickets, pastCalls] = await Promise.all([
        // Only a booking that is still standing and still ahead of us. A
        // cancelled or past one read out as "your appointment" sends somebody
        // to an office on a day nobody expects them.
        prisma.booking.findFirst({
          where: {
            organizationId,
            contactId: contact.id,
            status: { in: BUSY_BOOKING_STATUSES as unknown as string[] } as any,
            startTime: { gte: now },
          },
          orderBy: { startTime: 'asc' },
          select: { id: true, serviceName: true, startTime: true, staffName: true },
        }),
        prisma.callbackRequest.findFirst({
          where: {
            organizationId,
            contactId: contact.id,
            status: { in: [...OPEN_CALLBACK_STATUSES] },
          },
          orderBy: { dueAt: 'asc' },
          select: { id: true, promisedText: true, dueAt: true, reason: true },
        }),
        prisma.ticket.count({
          where: {
            organizationId,
            contactId: contact.id,
            status: { in: ['OPEN', 'IN_PROGRESS', 'PENDING_CUSTOMER'] as any },
          },
        }),
        prisma.callLog.findMany({
          where: { organizationId, contactId: contact.id },
          orderBy: { startedAt: 'desc' },
          take: 2,
          select: { startedAt: true, summary: true, durationSeconds: true },
        }),
      ]);

      const recentCallSummary = pastCalls
        .map((c) => c.summary?.trim())
        .filter(Boolean)
        .join('; ');

      const occupation = ((contact.metadata as Record<string, any>)?.occupation as string) ?? null;
      const ours = isPlaceholderContactName(contact.fullName);
      const prefLang = (contact.preferredLanguage || '').trim().toLowerCase();

      let greetingSentence: string;
      if (ours) {
        greetingSentence = recentCallSummary
          ? 'Welcome back! Let me check our notes from your previous call and help you right away.'
          : "Welcome! I don't have your name on file yet — may I know who I have the pleasure of speaking with?";
      } else if (prefLang.startsWith('ha')) {
        greetingSentence = `Barka da dawowa, ${contact.fullName}${contact.city ? ` daga ${contact.city}` : ''}! Da me zan iya taimaka maka a yau?`;
      } else if (prefLang.includes('pidgin') || prefLang === 'pcm') {
        greetingSentence = `Welcome back, ${contact.fullName}! How body today? Wetin you wan make I help you with today?`;
      } else if (prefLang.startsWith('yo')) {
        greetingSentence = `E kaabo pada, ${contact.fullName}! Bawo ni mo se le ran yin lowo loni?`;
      } else if (prefLang.startsWith('ig')) {
        greetingSentence = `Nnoo, ${contact.fullName}! Kedu ka m ga-esi nyere gi aka taa?`;
      } else if (prefLang.includes('berom')) {
        greetingSentence = `Sho, mwin sho ${contact.fullName}! Welcome back! How can I help you today?`;
      } else if (prefLang.includes('ngas') || prefLang.includes('angas')) {
        greetingSentence = `Mwa gi, ${contact.fullName}! Kwaram! Welcome back — how can I help you today?`;
      } else if (prefLang.includes('mwag') || prefLang.includes('mangu')) {
        greetingSentence = `Wu na, ${contact.fullName}! Shagal! Welcome back — how can I help you today?`;
      } else if (prefLang.includes('tarok')) {
        greetingSentence = `Mbin, i kat ${contact.fullName}! Umi! Welcome back — how can I help you today?`;
      } else {
        greetingSentence = `Welcome back, ${contact.fullName}! How can I assist you with Plateau State services today?`;
      }

      const sentences: string[] = [greetingSentence];

      if (upcoming) {
        sentences.push(
          `You have ${upcoming.serviceName} booked for ${formatLagos(upcoming.startTime)}.`
        );
      }
      if (openCallback) {
        sentences.push(
          `We also owe you a call back about ${openCallback.reason.trim()} — reference ` +
          `${callbackReference(openCallback.id)}, ${openCallback.promisedText.toLowerCase()}.`
        );
      }
      if (openTickets > 0 && !prefLang.startsWith('ha')) {
        sentences.push(
          openTickets === 1
            ? 'You have one open case with us as well.'
            : `You have ${openTickets} open cases with us as well.`
        );
      }

      return {
        ok: true,
        speak: sentences.join(' '),
        data: {
          known: !ours,
          contactId: contact.id,
          fullName: ours ? null : contact.fullName,
          nameIsPlaceholder: ours,
          lga: contact.city ?? null,
          homeAddress: contact.address ?? null,
          occupation,
          preferredLanguage: contact.preferredLanguage ?? null,
          recentCallSummary: recentCallSummary || null,
          prompt: ours
            ? recentCallSummary
              ? `NOTE: Although the contact record still has a placeholder name, recentCallSummary contains details from their previous call: "${recentCallSummary}". Use any name/details mentioned in recentCallSummary, DO NOT claim their details are missing, and call update-caller-profile to save them!`
              : 'The caller is a new caller and not yet profiled. Collect their 5 profile details one question at a time: (1) full name, (2) LGA, (3) home/street address, (4) occupation, and (5) preferred language (English, Hausa, Pidgin, Yoruba, Igbo, or Plateau language). Once collected, call update-caller-profile and immediately switch to their chosen language!'
            : `KNOWN RETURNING CALLER — DO NOT CLAIM THEIR DETAILS ARE MISSING AND DO NOT ASK FOR PROFILE DETAILS AGAIN! Full profile on file: Name="${contact.fullName}", LGA="${contact.city ?? 'N/A'}", Address="${contact.address ?? 'N/A'}", Occupation="${occupation ?? 'N/A'}", PreferredLanguage="${contact.preferredLanguage ?? 'English'}". Refer to ${contact.fullName} by name and speak in ${contact.preferredLanguage ?? 'English'} immediately (if Hausa, call language_detection with 'ha' right now and speak 100% in natural Hausa).`,
          upcomingBooking: upcoming
            ? {
                bookingId: upcoming.id,
                serviceName: upcoming.serviceName,
                startTime: upcoming.startTime.toISOString(),
                label: formatLagos(upcoming.startTime),
                staffName: upcoming.staffName ?? null,
              }
            : null,
          openCallback: openCallback
            ? {
                callbackId: openCallback.id,
                reference: callbackReference(openCallback.id),
                promisedText: openCallback.promisedText,
                dueAt: openCallback.dueAt.toISOString(),
              }
            : null,
          openTickets,
        },
      };
    } catch (e) {
      return this.failed('lookup_customer', e);
    }
  }

  /**
   * Save or update the caller's identity (name, LGA, address, occupation, language) in their contact record.
   */
  async updateCallerProfile(
    organizationId: string,
    body: {
      phoneNumber: string;
      fullName?: string;
      lga?: string;
      homeAddress?: string;
      occupation?: string;
      preferredLanguage?: string;
      notes?: string;
    }
  ): Promise<ToolResult> {
    try {
      const phone = (body?.phoneNumber || '').trim();
      const rawName = (body?.fullName || '').trim();
      if (!phone) {
        return { ok: false, speak: 'No phone number was provided.', data: {} };
      }

      const contact = await ensureContactForPhone(prisma, organizationId, phone, rawName);
      if (!contact) {
        return { ok: false, speak: 'Could not resolve a contact record for this number.', data: {} };
      }

      const prevMeta = (contact.metadata as Record<string, any>) || {};
      const metaUpdates: Record<string, any> = {};

      const updateData: any = {};
      if (rawName && !isPlaceholderContactName(rawName)) {
        updateData.fullName = rawName;
      }
      if (body.lga?.trim()) {
        updateData.city = body.lga.trim();
      }
      if (body.homeAddress?.trim()) {
        updateData.address = body.homeAddress.trim();
      }
      if (body.occupation?.trim()) {
        metaUpdates.occupation = body.occupation.trim();
      }
      if (body.preferredLanguage?.trim()) {
        updateData.preferredLanguage = body.preferredLanguage.trim();
      }
      if (body.notes?.trim()) {
        metaUpdates.lastInquiryNote = body.notes.trim();
      }
      if (Object.keys(metaUpdates).length > 0) {
        updateData.metadata = {
          ...prevMeta,
          ...metaUpdates,
          updatedAt: new Date().toISOString(),
        };
      }

      const updated = await prisma.contact.update({
        where: { id: contact.id },
        data: updateData,
      });

      const savedName = updated.fullName && !isPlaceholderContactName(updated.fullName) ? updated.fullName : null;
      const langNorm = (updated.preferredLanguage || '').trim().toLowerCase();
      let speak: string;
      let languageInstruction: string | undefined;

      if (langNorm.startsWith('ha')) {
        speak = savedName
          ? `Toh madalla, ${savedName}! Na adana bayanan ka. Daga yanzu za mu ci gaba da Hausa. Da me zan iya taimaka maka a yau?`
          : 'Toh madalla! Na adana bayanan ka. Da me zan iya taimaka maka a yau?';
        languageInstruction =
          "CRITICAL: The caller chose Hausa. Immediately call language_detection with 'ha' and speak 100% in natural Northern Nigerian Hausa for the rest of the conversation!";
      } else if (langNorm.includes('pidgin') || langNorm === 'pcm') {
        speak = savedName
          ? `Correct, ${savedName}! I don save your details well well. Na Pidgin we go take talk now. Wetin you wan make I help you with today?`
          : 'Correct! I don save your details well well. Wetin you wan make I help you with today?';
        languageInstruction =
          'CRITICAL: The caller chose Nigerian Pidgin. Immediately switch to warm, authentic Nigerian Pidgin for the rest of the conversation!';
      } else if (langNorm.startsWith('yo')) {
        speak = savedName
          ? `E se pupo, ${savedName}! Mo ti fi oruko ati alaye yin pamo. Lati isinsinyi lo, ede Yoruba ni a o ma fi soro. Bawo ni mo se le ran yin lowo loni?`
          : 'E se pupo! Mo ti fi alaye yin pamo. Bawo ni mo se le ran yin lowo loni?';
        languageInstruction =
          'CRITICAL: The caller chose Yoruba. Immediately switch to warm, natural conversational Yoruba for the rest of the conversation!';
      } else if (langNorm.startsWith('ig')) {
        speak = savedName
          ? `Daalu nke ukwuu, ${savedName}! Echekwara m nkowa gi niile. Site ugbua gawa, anyi ga-asu Igbo. Kedu ka m ga-esi nyere gi aka taa?`
          : 'Daalu nke ukwuu! Echekwara m nkowa gi. Kedu ka m ga-esi nyere gi aka taa?';
        languageInstruction =
          'CRITICAL: The caller chose Igbo. Immediately switch to warm, natural conversational Igbo for the rest of the conversation!';
      } else if (
        /berom|ngas|angas|mwag|tarok|goemai|afizere|izere|irigwe|bache|rukuba|ron|kulere|mupun|mushere|pyem|bogghom|pan|kofyar|montol/.test(
          langNorm
        )
      ) {
        speak = savedName
          ? `Thank you so much, ${savedName}! I have saved your details and your Plateau heritage language (${updated.preferredLanguage}). How can I assist you today?`
          : `Thank you! I have saved your details and your Plateau language preference (${updated.preferredLanguage}). How can I assist you today?`;
        languageInstruction = `The caller selected the Plateau State indigenous language ${updated.preferredLanguage}. Warmly use ${updated.preferredLanguage} greetings and expressions alongside clear Hausa, Pidgin, or Nigerian English so every detail is crystal clear!`;
      } else {
        speak = savedName
          ? `Thank you so much, ${savedName}! I've saved your details. How can I help you today?`
          : "Thank you! I've saved your details. How can I help you today?";
      }

      return {
        ok: true,
        speak,
        data: {
          contactId: updated.id,
          fullName: updated.fullName,
          lga: updated.city,
          address: updated.address,
          occupation: (updated.metadata as any)?.occupation ?? null,
          preferredLanguage: updated.preferredLanguage,
          ...(languageInstruction ? { instruction: languageInstruction } : {}),
        },
      };
    } catch (e) {
      return this.failed('update_caller_profile', e);
    }
  }

  // ── Bookings ───────────────────────────────────────────────────────────────
  /**
   * The appointment times that are actually free.
   *
   * Without this the agent had no way to know. It asked the caller to name a
   * time, called `book-appointment`, and learned the answer from an exclusion
   * violation — "that time is not available, could we try another?" On a busy
   * diary that is a guess-and-retry loop on a live phone call, while the
   * orchestrator offers real openings on WhatsApp. Same platform, same
   * customer, two different experiences.
   *
   * The search itself is the SHARED one in `@ace/database`, so the times this
   * reads out and the times the orchestrator offers cannot disagree about the
   * same diary — two implementations of "what is free" drift into a double
   * booking that both engines believed was legitimate.
   */
  async checkAvailability(
    organizationId: string,
    input: { durationMinutes?: number; limit?: number } = {}
  ): Promise<ToolResult> {
    try {
      const duration = Number(input.durationMinutes) > 0 ? Number(input.durationMinutes) : 30;
      const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10);

      // The agency's own hours, not a platform-wide working week.
      const hours = await serviceHoursFrom(prisma, organizationId);

      const slots = await findAvailableSlots(
        (from, to) =>
          prisma.booking.findMany({
            where: {
              organizationId,
              status: { in: BUSY_BOOKING_STATUSES as unknown as string[] } as any,
              startTime: { gte: from, lte: to },
            },
            select: { startTime: true, endTime: true },
          }),
        duration,
        limit,
        hours
      );

      if (slots.length === 0) {
        // Honest: not "pick another day", which invites the caller to guess at
        // a diary we have just established is full.
        return {
          ok: false,
          speak:
            'I do not have anything free in the next two weeks. Let me put you through to a ' +
            'colleague who can look further ahead.',
          handoff: true,
          data: { slots: [] },
        };
      }

      return {
        ok: true,
        speak: `The next available times are: ${slots.map((s) => formatLagos(s.start)).join('; ')}.`,
        data: {
          slots: slots.map((s) => ({
            startTime: s.start.toISOString(),
            endTime: s.end.toISOString(),
            label: formatLagos(s.start),
          })),
        },
      };
    } catch (e) {
      return this.failed('check_availability', e);
    }
  }

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
        speak: `You are booked for ${booking.serviceName} on ${when}. Your reference is ${bookingReference(booking.id)}.`,
        data: { bookingId: booking.id, reference: bookingReference(booking.id), startTime: booking.startTime },
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

  /**
   * The appointment the caller means — or a refusal to guess.
   *
   * ── What was wrong ──────────────────────────────────────────────────────────
   *
   * `cancel-booking` and `reschedule-booking` took a phone number and acted on
   * whichever booking came next. A citizen with a clinic review on Thursday and
   * a land registration the following week says "cancel my appointment", and
   * Thursday went, whatever they meant. The agent had no way to name one, and
   * the caller learned which had gone from the service name in the
   * confirmation, after it was already done.
   *
   * The orchestrator never behaved this way: its cancel flow reads the booking
   * back and waits for a yes. That is the rule this repo already holds —
   * anything that CHANGES or DESTROYS an existing record keeps the read-back —
   * and the voice path was the exception.
   *
   * So: one upcoming booking, act. Several and no reference, offer them with
   * the references the citizen was quoted when they booked, and change
   * nothing. A reference that matches nothing is said plainly rather than
   * falling back to the next one, because falling back is the bug.
   */
  private async resolveBooking(
    organizationId: string,
    phoneNumber: string,
    reference?: string
  ): Promise<
    | { kind: 'none' }
    | { kind: 'one'; booking: { id: string; serviceName: string; startTime: Date } }
    | { kind: 'ambiguous'; speak: string; options: Array<{ bookingId: string; reference: string; serviceName: string; startTime: string; label: string }>; unmatched?: boolean }
  > {
    const contact = await prisma.contact.findFirst({
      where: { organizationId, phoneNumber: { in: phoneNumberVariants(phoneNumber) } },
      select: { id: true },
    });
    if (!contact) return { kind: 'none' };

    const upcoming = await prisma.booking.findMany({
      where: {
        organizationId,
        contactId: contact.id,
        status: { in: BUSY_BOOKING_STATUSES as unknown as string[] } as any,
        startTime: { gte: new Date() },
      },
      orderBy: { startTime: 'asc' },
      take: 10,
      select: { id: true, serviceName: true, startTime: true },
    });

    if (upcoming.length === 0) return { kind: 'none' };

    const options = upcoming.map((b) => ({
      bookingId: b.id,
      reference: bookingReference(b.id),
      serviceName: b.serviceName,
      startTime: b.startTime.toISOString(),
      label: formatLagos(b.startTime),
    }));

    if (reference?.trim()) {
      // As a caller says it back: the prefix drops, the case goes, and the
      // dashes do not survive being read down a phone line.
      const asked = reference.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^AP/, '');
      const match = options.find(
        (o) => o.reference.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^AP/, '') === asked
      );
      if (match) {
        const booking = upcoming.find((b) => b.id === match.bookingId)!;
        return { kind: 'one', booking };
      }
      return {
        kind: 'ambiguous',
        unmatched: true,
        options,
        speak:
          `I could not find an appointment with that reference. ` +
          `What I have for you is ${this.listBookings(options)}. Which of those did you mean?`,
      };
    }

    if (upcoming.length === 1) return { kind: 'one', booking: upcoming[0] };

    return {
      kind: 'ambiguous',
      options,
      speak:
        `You have more than one appointment with us: ${this.listBookings(options)}. ` +
        `Which one did you mean?`,
    };
  }

  /** The appointments spoken as a sentence, never as a list read aloud. */
  private listBookings(
    options: Array<{ reference: string; serviceName: string; label: string }>
  ): string {
    const parts = options.map(
      (o) => `${o.serviceName} on ${o.label}, reference ${o.reference}`
    );
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
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
    reason?: string,
    reference?: string
  ): Promise<ToolResult> {
    try {
      const found = await this.resolveBooking(organizationId, phoneNumber, reference);
      if (found.kind === 'none') {
        return {
          ok: false,
          speak: "I can't find an upcoming appointment under this number. Are you sure you have a booking with us?",
          data: { found: false },
        };
      }
      if (found.kind === 'ambiguous') {
        // Nothing is cancelled while the caller decides. `ok` reflects whether
        // we could act, so an unmatched reference is a failure and a genuine
        // choice is not.
        return {
          ok: !found.unmatched,
          speak: found.speak,
          data: { needsChoice: true, bookings: found.options },
        };
      }

      const booking = found.booking;
      await this.scheduling.cancelBooking(organizationId, booking.id, reason, 'system:hosted-agent');
      return {
        ok: true,
        speak: `Your ${booking.serviceName} appointment on ${formatLagos(booking.startTime)} has been cancelled.`,
        data: { bookingId: booking.id, reference: bookingReference(booking.id) },
      };
    } catch (e) {
      return this.failed('cancel_booking', e);
    }
  }

  async rescheduleBooking(
    organizationId: string,
    phoneNumber: string,
    newStartTime: string,
    reference?: string
  ): Promise<ToolResult> {
    try {
      const found = await this.resolveBooking(organizationId, phoneNumber, reference);
      if (found.kind === 'none') {
        return {
          ok: false,
          speak: "I can't find an upcoming appointment under this number. Are you sure you have a booking with us?",
          data: { found: false },
        };
      }
      if (found.kind === 'ambiguous') {
        return {
          ok: !found.unmatched,
          speak: found.speak,
          data: { needsChoice: true, bookings: found.options },
        };
      }
      const booking = found.booking;
      const updated = await this.scheduling.rescheduleBooking(
        organizationId,
        booking.id,
        newStartTime,
        undefined,
        'system:hosted-agent'
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
  /**
   * Promise to ring the caller back, and record the promise.
   *
   * Shares the CallbackRequest shape and the service-hours clamp with the
   * orchestrator's callback flow rather than writing its own row: a citizen
   * who asks the voice agent and one who asks on WhatsApp must end up in the
   * same queue, or an officer working one list misses half the promises.
   *
   * `whenMinutes` comes from the caller's own choice. It is clamped to the
   * agency's serving hours, so a request at 17:50 for "within the hour" falls
   * due when somebody is actually there — a promise due at 18:50 is broken at
   * the moment it is made.
   */
  async requestCallback(
    organizationId: string,
    input: {
      phoneNumber: string;
      reason: string;
      whenMinutes?: number;
      fullName?: string;
      callbackNumber?: string;
      numberConfirmed?: boolean | string;
    }
  ): Promise<ToolResult> {
    try {
      if (!input?.phoneNumber?.trim()) {
        return this.failed('request-callback', new Error('no phone number to call back'));
      }
      if (!input?.reason?.trim()) {
        return {
          ok: false,
          speak: 'Before I arrange that, could you tell me what the call should be about?',
          data: { reason: 'missing_reason' },
        };
      }

      // A callback is a promise to ring a specific number. It is not filed until
      // the caller has heard the number read back and said yes — otherwise the
      // promise can be made to a number nobody is waiting at.
      const confirmed = input.numberConfirmed === true || String(input.numberConfirmed).toLowerCase() === 'true';
      const requested = (input.callbackNumber?.trim() || input.phoneNumber).trim();
      if (!confirmed) {
        const digits = normalizePhoneNumber(requested).replace(/\D/g, '');
        const spoken = digits.split('').join(' ');
        return {
          ok: false,
          speak: input.callbackNumber?.trim()
            ? `Just to be sure I have it right — I will call you back on ${spoken}. Is that correct?`
            : `Before I book your call back — shall we call you on the number you are calling from, ${spoken}, or would you prefer a different number?`,
          data: {
            reason: 'number_not_confirmed',
            numberToConfirm: normalizePhoneNumber(requested),
            instruction:
              'Read the number back digit by digit and wait for a clear yes. If they give a different number, read THAT one back too. Only then call request-callback again with numberConfirmed=true and callbackNumber set to the confirmed number.',
          },
        };
      }
      const targetNumber = normalizePhoneNumber(requested);

      const contact = await this.contactFor(organizationId, input.phoneNumber, input.fullName);

      // An open promise is not duplicated: two officers ringing the same
      // citizen about the same thing is worse than one.
      const existing = await prisma.callbackRequest.findFirst({
        where: {
          organizationId,
          phoneNumber: { in: phoneNumberVariants(input.phoneNumber) },
          status: { in: [...OPEN_CALLBACK_STATUSES] },
        },
        orderBy: { dueAt: 'asc' },
      });
      if (existing) {
        return {
          ok: true,
          speak:
            `You already have a callback booked, reference ${callbackReference(existing.id)}, ` +
            `${existing.promisedText.toLowerCase()}. I have not booked a second one.`,
          data: { callbackId: existing.id, reference: callbackReference(existing.id), duplicate: true },
        };
      }

      const minutes = Number.isFinite(input.whenMinutes) ? Number(input.whenMinutes) : 60;
      const promisedText =
        minutes <= 60 ? 'Within the hour' : minutes <= 240 ? 'Later today' : 'Tomorrow';

      // Outbound contact hours, matching the orchestrator's callback flow —
      // the same promise made on a voice call and on WhatsApp must fall due
      // at the same time.
      const hours = await outboundContactHoursFrom(prisma, organizationId);
      const dueAt = nextServiceTime(new Date(Date.now() + minutes * 60_000), hours);

      const row = await prisma.callbackRequest.create({
        data: {
          organizationId,
          contactId: contact.id,
          phoneNumber: targetNumber,
          reason: input.reason.trim().slice(0, 1000),
          promisedText,
          dueAt,
        },
      });

      return {
        ok: true,
        speak:
          `That is arranged — your reference is ${callbackReference(row.id)}. ` +
          `Someone will call you back ${promisedText.toLowerCase()} on ${targetNumber.replace(/\D/g, '').split('').join(' ')}.`,
        data: { callbackId: row.id, reference: callbackReference(row.id), dueAt: dueAt.toISOString(), callbackNumber: targetNumber },
      };
    } catch (err) {
      return this.failed('request-callback', err);
    }
  }

  async createTicket(
    organizationId: string,
    input: {
      phoneNumber: string;
      fullName?: string;
      subject: string;
      description: string;
      category?: string;
      location?: string;
      occurredAt?: string;
      isOngoing?: boolean | string;
      victimsOrInjuries?: string;
    }
  ): Promise<ToolResult> {
    try {
      const contact = await this.contactFor(organizationId, input.phoneNumber, input.fullName);
      const text = `${input.subject} ${input.description} ${input.category ?? ''} ${input.victimsOrInjuries ?? ''}`.toLowerCase();

      // ── Incident / emergency triage ───────────────────────────────────────
      // A citizen reporting an attack, fire, flood or injury needs two things a
      // callback does not give them: the right emergency number NOW, and a
      // record an officer can act on without phoning back to ask "where?".
      const SECURITY = /attack|gunmen|gunman|bandit|kidnap|abduct|shoot|shot |killed|killing|robber|armed|raid|riot|violence|clash|mob|assault|rape|stab|burn(ed|t) down|arson|invad/i;
      const FIRE = /\bfire\b|explosion|gas leak|inferno/i;
      const DISASTER = /flood|collapse|landslide|storm|windstorm|rainstorm|erosion/i;
      const MEDICAL = /bleeding|unconscious|not breathing|labou?r|accident|crash|injur|dying|poison|snake ?bite/i;
      const kind = SECURITY.test(text)
        ? 'security'
        : FIRE.test(text)
        ? 'fire'
        : DISASTER.test(text)
        ? 'disaster'
        : MEDICAL.test(text)
        ? 'medical'
        : null;
      const ongoing = input.isOngoing === true || String(input.isOngoing).toLowerCase() === 'true';

      // A citizen reporting that they were asked for money, refused service or
      // mistreated is a service-integrity complaint at ANY agency, not only a
      // hospital — so the escalation is kept and only the health-specific
      // wording is gone. What the citizen is told names no scheme, no card and
      // no helpline the agency may not have.
      const isIntegrityComplaint =
        !kind && /extortion|illegal|bribe|demand|money|cash|pay|refus|deny|denied|stockout|mistreat/i.test(text);

      const priority = kind || isIntegrityComplaint ? TicketPriority.URGENT : TicketPriority.HIGH;
      const subject = kind
        ? `[URGENT ${kind.toUpperCase()} INCIDENT] ${input.subject}`
        : isIntegrityComplaint
        ? `[INTEGRITY ESCALATION] ${input.subject}`
        : input.subject;

      const details = [
        input.description,
        input.location ? `Location: ${input.location}` : null,
        input.occurredAt ? `When: ${input.occurredAt}` : null,
        kind ? `Still ongoing: ${ongoing ? 'YES' : 'no / unknown'}` : null,
        input.victimsOrInjuries ? `Victims / injuries: ${input.victimsOrInjuries}` : null,
        `Reported by phone: ${input.phoneNumber}`,
      ]
        .filter(Boolean)
        .join('\n');

      const ticket = await this.crm.createTicket(organizationId, {
        contactId: contact.id,
        subject,
        description: details,
        priority,
      });

      if (isIntegrityComplaint || kind) {
        await prisma.note.create({
          data: {
            contactId: contact.id,
            content: kind
              ? `🚨 URGENT ${kind.toUpperCase()} INCIDENT REPORTED (${ticket.ticketNumber}): ${input.subject} — ${input.location ?? 'location not given'}.`
              : `🚨 URGENT SERVICE-INTEGRITY COMPLAINT LOGGED: ${input.subject} — escalated for review.`,
          },
        }).catch(() => {});
      }

      if (kind) {
        // Who to call depends on what is happening. 112 leads every time: it is
        // the one national number that reaches every service.
        const authority =
          kind === 'security'
            ? 'The fastest route for anything happening now is 1 1 2. You can also reach Operation Enduring Peace, the joint military task force, on their toll-free line 0 8 0 0 0 0 2 0 2 0 3, and Operation Rainbow, the State early-warning and security outfit, on their toll-free line 0 8 0 0 0 0 2 2 3 3 4 4 or their control room 0 9 0 6 4 0 0 0 1 1 2. For crimes like robbery or kidnapping, the Police Plateau Command is on 0 8 0 3 2 4 1 9 3 3 6.'
            : kind === 'fire'
            ? 'Please call 1 1 2 or the Plateau State Fire Service on 0 7 0 4 0 0 0 7 2 8 3 right away, and keep everyone away from the building.'
            : kind === 'disaster'
            ? 'The Plateau State Emergency Management Agency, SEMA, handles floods and disasters — their line is 0 8 0 3 7 8 0 8 2 1 8 — and 1 1 2 will also connect you.'
            : 'Please call 1 1 2 for an ambulance, or get to the nearest hospital as fast as you safely can.';
        return {
          ok: true,
          speak:
            `You did the right thing by reporting this. I have logged it as an urgent incident and flagged it to our team, and your reference is ${ticket.ticketNumber}. ` +
            authority,
          data: {
            ticketId: ticket.id,
            ticketNumber: ticket.ticketNumber,
            isEscalated: true,
            incidentKind: kind,
            instruction:
              'Say the reference and the contacts, and give the caller CONFIDENCE the way a calm, experienced officer would: thank them for reporting, tell them their report is on record and flagged urgent with the State team, explain which agency does what (Operation Enduring Peace = military joint task force that responds to attacks and communal violence; Operation Rainbow = State early-warning/community security network that passes threats to the forces; Police = crimes such as robbery and kidnapping; Fire Service = fires; SEMA = floods/disasters; 112 = reaches all of them), remind them that reporting quickly and giving exact location is what gets help moving, and tell them to quote the reference. Be warm and steady, not scripted. Do NOT promise police, soldiers or rescue will arrive by a certain time. Offer a confirmed-number callback only if they want a follow-up. Never ask them to repeat details they already gave.',
          },
        };
      }

      // `ticket.ticketNumber`, not `ticket.id.slice(0, 8)`.
      //
      // The dashboard's ticket table shows `ticketNumber` (TCK-…) and that is
      // what an officer searches by; the orchestrator quotes the same column on
      // WhatsApp. This read out the first eight characters of a uuid instead —
      // a reference the citizen was told to keep that matches NOTHING any
      // officer can look up, for the same complaint that WhatsApp references
      // correctly. Two engines, one complaint, two references, one of them
      // useless.
      return {
        ok: true,
        speak: isIntegrityComplaint
          ? `I have logged this as an urgent complaint for review. Your reference number is ${ticket.ticketNumber} — please keep it. Someone will look into this as a priority and come back to you on this number.`
          : `I have logged this for our team. Your reference is ${ticket.ticketNumber}, and someone will come back to you on this number.`,
        data: { ticketId: ticket.id, ticketNumber: ticket.ticketNumber, isEscalated: isIntegrityComplaint },
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

      // Score every active FAQ by keyword overlap with the query.
      //
      // ORDERED BY sortOrder, like the orchestrator. This query had no
      // ordering at all, so on a score tie the answer a citizen got was
      // whichever row Postgres happened to return first — while the same
      // question on WhatsApp got the one the agency had put at the top. Two
      // engines, two answers, from the same FAQ table.
      //
      // `.sort()` is stable per spec, so sorting by score below preserves this
      // order within a tie: position decides, exactly as it does on the other
      // path. Both paths must keep the same guarantees, and what an agency is
      // told its ordering controls is one of them.
      const faqs = await prisma.faqEntry.findMany({
        where: { organizationId, isActive: true },
        select: { question: true, answer: true },
        orderBy: { sortOrder: 'asc' },
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
      // The passage that answers the question, not the first 500 characters
      // of whichever document ranked first. See relevant-passage.ts.
      const results = await this.knowledge.searchPlayground(organizationId, q).catch(() => null);
      const contents = (Array.isArray(results) ? results : [])
        .slice(0, 3)
        .map((r: any) => (r?.content ? stripMd(String(r.content)) : ''))
        .filter(Boolean);
      const passage = relevantPassage(contents, q);
      if (passage) {
        return { ok: true, speak: passage, data: { source: 'knowledge' } };
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

      // Policy: no live transfers unless explicitly enabled. Desk officers are
      // not on the line, so the agent promises a callback instead — after
      // confirming the number with the caller.
      if (process.env.ENABLE_LIVE_TRANSFER !== 'true') {
        return {
          ok: true,
          speak:
            'Our desk officers are attending to other citizens right now, so I will arrange for one of them to call you back. ',
          data: {
            transferred: false,
            liveTransferDisabled: true,
            instruction:
              'Do NOT transfer. Ask the caller to confirm the number for the call back (the number they are calling from, or another), read it back digit by digit, wait for a yes, then call request-callback with callbackNumber and numberConfirmed=true, and read out the reference it returns.',
          },
        };
      }

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
        speak: `I cannot put you through myself, but I have logged this for our team. Your reference is ${ticket.ticketNumber}, and someone will call you back on this number.`,
        handoff: true,
        data: { transferred: false, ticketId: ticket.id, ticketNumber: ticket.ticketNumber },
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

  // ── Service registration ───────────────────────────────────────────────────
  /**
   * Creates (or updates) a contact record with enrollment details collected
   * during the call, then fires the selfie-capture link to their WhatsApp.
   *
   * The agent calls this once it has collected: full name, LGA, phone (the
   * caller's number is injected by the platform, never supplied by the model),
   * NIN, and plan type. The record itself is written by `upsertEnrollee` in
   * `@ace/database` — the SAME function the WhatsApp flow calls — because a
   * citizen who registers by phone and one who registers by message must end up
   * as the same shape of record. This method keeps only what is specific to a
   * voice call: the guards that tell the agent which field to ask for next, the
   * selfie request, and what is said back.
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
          speak: 'Could you tell me your age or date of birth so we can include it on your registration?',
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

      // The agency's own services and locations, read once. Everything below
      // checks against these rather than against a directory compiled into
      // the platform.
      const catalogue = await loadServiceCatalogue(prisma, organizationId);
      const lgaFacilities = locationsInLga(catalogue, input.lga);

      // Guard: planType must be provided.
      //
      // This read "Formal Sector, Informal Sector, BHCPF, or the free Equity
      // Programme" — one health scheme's four plans, spoken to the caller of
      // whichever agency the agent was answering for. The catalogue is loaded
      // above now so this names what the agency actually offers, the same way
      // the location guard below already did.
      if (!input.planType?.trim()) {
        const offered = catalogue.options.slice(0, 4).map((o) => o.name).join(', ');
        return {
          ok: false,
          speak: offered
            ? `Which of these would you like to register for? ${offered}.`
            : 'Which service would you like to register for?',
          data: { reason: 'missing_plan_type' },
        };
      }

      // Guard: a location must be provided, where the agency has any here.
      if (!input.preferredHospital?.trim() && lgaFacilities.length > 0) {
        const facs = lgaFacilities.slice(0, 3).map((f) => f.name).join(', ');
        return {
          ok: false,
          speak: `Which of our locations in ${input.lga} would you prefer? For example: ${facs}.`,
          data: { reason: 'missing_preferred_hospital' },
        };
      }

      // Guard: we must know who is calling.
      //
      // This used to invent one — `+23480${8 random digits}` — when the caller's
      // number was missing, which writes a fabricated phone number into a real
      // CRM: staff ring it and reach a stranger, and it can collide with an
      // actual enrollee's number, at which point one person's health record
      // hangs off another person's phone. The number is injected by the
      // platform from the call itself, so absent means something upstream broke
      // and the right move is to say so.
      if (!input.phoneNumber?.trim()) {
        return {
          ok: false,
          speak:
            'I could not read the number you are calling from. Could you tell me the phone number to register you with?',
          data: { reason: 'missing_phone_number' },
        };
      }

      // Guard: the LGA has to be a real one. Checked against the State's own
      // list, not against this agency's coverage — an LGA where the agency has
      // no office is still where somebody lives, and they can still register.
      if (!resolveLga(input.lga)) {
        return {
          ok: false,
          speak:
            `I could not match ${input.lga} to a Plateau State Local Government Area. ` +
            `Which LGA do you live in?`,
          data: { reason: 'unknown_lga' },
        };
      }

      // Guard: where the agency HAS locations in that LGA, the one named must
      // be among them. A record against a location that does not serve them is
      // a wasted journey, found out on arrival.
      //
      // Awaited, and that matters: this was `if (!resolveFacility(...))` after
      // the function became async, so the condition tested a Promise — always
      // truthy, so the guard never fired and any name at all was accepted.
      if (lgaFacilities.length > 0 && !resolveLocation(catalogue, input.lga, input.preferredHospital)) {
        const options = lgaFacilities.slice(0, 3).map((f) => f.name).join(', ');
        return {
          ok: false,
          speak:
            `That is not one of our locations in ${input.lga}. ` +
            `The options there include: ${options}. Which would you prefer?`,
          data: { reason: 'unaccredited_facility' },
        };
      }

      const enrolled = await upsertEnrollee(organizationId, {
        phoneNumber: input.phoneNumber,
        fullName: input.fullName,
        lga: input.lga,
        planType: input.planType,
        residentialAddress: input.residentialAddress,
        ageOrDob: input.ageOrDob,
        nin: input.nin,
        preferredHospital: input.preferredHospital,
        notes: input.notes,
      });
      const contact = { id: enrolled.contactId };
      const selectedFacility = enrolled.facility;
      const normalizedPlan = enrolled.planType;
      const isEquity = enrolled.isEquity;

      // Create the selfie request so the post-call webhook can find it and
      // send the link via Twilio SMS right after this call ends.
      // We do NOT attempt delivery during the call — WhatsApp and SMS delivery
      // during an active voice call is unreliable. Instead, the ElevenLabs
      // post-call webhook (elevenlabs-webhook.service.ts → sendPostCallSms)
      // fires the SMS the moment ElevenLabs confirms the call is finished.
      const selfieResult = await this.onboarding.requestSelfie(organizationId, {
        contactId: contact.id,
        channel: 'VOICE',
        purpose: isEquity ? 'Eligibility verification for a no-cost service' : 'Service registration',
        expiresInHours: 48,
      });

      const refId = enrolled.refId;
      const firstName = input.fullName.split(' ')[0];

      if (isEquity) {
        return {
          ok: true,
          speak: `You are registered, ${firstName}. I have recorded you in ${input.lga}, with ${selectedFacility} as your chosen location, and there is no payment required for this. Your reference number is ${refId} — please keep it safe. Right after this call we will text you a secure link to add your photograph. Our team will review your eligibility and contact you on this number. Is there anything else I can help you with?`,
          data: {
            contactId: contact.id,
            refId,
            selfieRequestId: selfieResult.id,
            uploadUrl: selfieResult.uploadUrl,
            postCallSmsScheduled: true,
            isEquity: true,
          },
        };
      }

      return {
        ok: true,
        speak: `You are registered, ${firstName}. Your ${normalizedPlan} record has been created in ${input.lga}, with ${selectedFacility} as your chosen location. Your reference is ${refId} — please keep it safe. Right after this call we will text you a link to add your photograph. Our team will take it from there and contact you on this number. Is there anything else I can help you with today?`,
        data: {
          contactId: contact.id,
          refId,
          selfieRequestId: selfieResult.id,
          uploadUrl: selfieResult.uploadUrl,
          postCallSmsScheduled: true,
        },
      };
    } catch (e) {
      return this.failed('register_enrollee', e);
    }
  }
}
