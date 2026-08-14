import {
  ConversationContext,
  OrchestrationResult,
  HandoffReason,
  ChannelType,
} from '@ace/shared-types';
import { prisma } from '@ace/database';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface QdrantSearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Maximum characters we pass as a RAG query to the vector store.
 * Prevents excessive embedding token cost and latency on long messages.
 * At ~4 chars/token, 500 chars ≈ 125 tokens — sufficient for semantic search.
 */
const RAG_QUERY_MAX_CHARS = 500;

/**
 * Maximum number of vector chunks to retrieve per query.
 * Keeping this tight (3) prevents context window bloat in the LLM prompt.
 */
const RAG_TOP_K = 3;

/**
 * Appointment duration in minutes. Should come from organization config in a
 * future iteration — currently a platform-wide default.
 */
const DEFAULT_APPOINTMENT_DURATION_MINUTES = 30;

/**
 * Returns tomorrow at 10:00 Africa/Lagos as a Date, regardless of the server's
 * local timezone.
 *
 * Lagos is UTC+1 year-round (no DST), so 10:00 Lagos === 09:00 UTC.
 * The previous implementation used setHours(10, ...) which is interpreted in the
 * SERVER's timezone — correct only if TZ=Africa/Lagos. In a Docker container
 * (default TZ=UTC) every "10 AM" booking landed at 11:00 Lagos.
 */
function tomorrowAt10Lagos(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(9, 0, 0, 0); // 09:00 UTC == 10:00 Africa/Lagos (UTC+1, no DST)
  return d;
}

/**
 * Find the next conflict-free slot for an AI-created booking.
 *
 * The old executeBookAppointment created bookings unconditionally (its comment
 * claimed a read-before-write conflict check that did not exist). This scans
 * business hours (10:00–17:00 Lagos, 30-min slots) starting tomorrow, up to 14
 * days out, and returns the first slot with no overlapping active booking.
 *
 * One query per day (all active bookings for that day), overlap resolved in
 * memory — bounded at 14 queries worst case. Still read-then-write: two truly
 * concurrent requests can race into the same slot. Acceptable at SME volume;
 * at >500 bookings/day wrap the create in a serializable transaction.
 */
async function findNextFreeSlot(
  organizationId: string,
  durationMinutes: number
): Promise<{ startTime: Date; endTime: Date }> {
  const SLOT_MS = 30 * 60 * 1000;
  const DAY_START_UTC_HOUR = 9;   // 10:00 Lagos
  const LAST_START_UTC_HOUR = 16; // 17:00 Lagos (last slot starts 16:30 Lagos)

  for (let dayOffset = 1; dayOffset <= 14; dayOffset++) {
    const dayStart = new Date();
    dayStart.setUTCDate(dayStart.getUTCDate() + dayOffset);
    dayStart.setUTCHours(DAY_START_UTC_HOUR, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCHours(LAST_START_UTC_HOUR, 30, 0, 0);

    const dayBookings = await prisma.booking.findMany({
      where: {
        organizationId,
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        startTime: { lt: new Date(dayEnd.getTime() + SLOT_MS) },
        endTime: { gt: dayStart },
      },
      select: { startTime: true, endTime: true },
    });

    for (let t = dayStart.getTime(); t <= dayEnd.getTime() - SLOT_MS; t += SLOT_MS) {
      const slotStart = t;
      const slotEnd = t + durationMinutes * 60 * 1000;
      const clash = dayBookings.some(
        (b: { startTime: Date; endTime: Date }) =>
          b.startTime.getTime() < slotEnd && b.endTime.getTime() > slotStart
      );
      if (!clash) {
        return { startTime: new Date(slotStart), endTime: new Date(slotEnd) };
      }
    }
  }

  // Fully booked for 14 days — extremely unlikely at SME scale. Fall back to
  // tomorrow 10:00 so the customer still gets a booking a human can then move.
  const fallback = tomorrowAt10Lagos();
  return {
    startTime: fallback,
    endTime: new Date(fallback.getTime() + durationMinutes * 60 * 1000),
  };
}

// ─── RAG Service ─────────────────────────────────────────────────────────────

/**
 * QdrantRAGService
 *
 * Production path: Generates an OpenAI embedding for the query text, then
 * performs a vector similarity search against the organization's Qdrant collection.
 *
 * The Qdrant collection name is namespaced per organization (org_{organizationId})
 * to enforce multi-tenant isolation at the vector database layer.
 *
 * Fallback: If the OPENAI_API_KEY is not set, or if Qdrant is unreachable,
 * we fall back to a PostgreSQL full-text ILIKE search. This is NOT equivalent
 * in quality but prevents a complete blackout of the RAG pipeline during outages.
 * The fallback is clearly logged so operators can detect it.
 *
 * Assumption: The Qdrant collection is pre-populated by the KnowledgeService
 * document ingestion pipeline (chunking → embedding → upsert).
 */
export class QdrantRAGService {
  private readonly qdrantUrl: string;
  private readonly apiKey: string | undefined;
  private readonly openAiKey: string | undefined;

  constructor() {
    this.qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    this.apiKey = process.env.QDRANT_API_KEY;
    this.openAiKey = process.env.OPENAI_API_KEY;
  }

  async searchKnowledgeBase(
    organizationId: string,
    query: string,
    topK: number = RAG_TOP_K
  ): Promise<QdrantSearchResult[]> {
    // Clamp query length to prevent token abuse
    const clampedQuery = query.slice(0, RAG_QUERY_MAX_CHARS);
    const collectionName = `org_${organizationId}`;

    if (this.openAiKey) {
      try {
        return await this.vectorSearch(collectionName, clampedQuery, topK);
      } catch (vectorErr: any) {
        console.error(JSON.stringify({
          level: 'warn',
          service: 'QdrantRAGService',
          event: 'qdrant_vector_search_failed_using_pg_fallback',
          error: vectorErr.message,
          organizationId,
        }));
      }
    }

    // PostgreSQL full-text fallback
    return this.postgresFullTextFallback(organizationId, clampedQuery, topK);
  }

  /**
   * Generate OpenAI text-embedding-3-small vector then query Qdrant.
   */
  private async vectorSearch(collectionName: string, query: string, topK: number): Promise<QdrantSearchResult[]> {
    // Step 1: Generate embedding
    const embeddingResponse = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openAiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'text-embedding-3-small',
        input: query,
      }),
    });

    if (!embeddingResponse.ok) {
      const errText = await embeddingResponse.text();
      throw new Error(`OpenAI Embeddings API error: ${embeddingResponse.status} ${errText}`);
    }

    const embeddingData: any = await embeddingResponse.json();
    const queryVector: number[] = embeddingData.data?.[0]?.embedding;

    if (!queryVector || queryVector.length === 0) {
      throw new Error('OpenAI returned an empty embedding vector');
    }

    // Step 2: Qdrant vector search
    const qdrantHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) qdrantHeaders['api-key'] = this.apiKey;

    const searchResponse = await fetch(`${this.qdrantUrl}/collections/${collectionName}/points/search`, {
      method: 'POST',
      headers: qdrantHeaders,
      body: JSON.stringify({
        vector: queryVector,
        limit: topK,
        with_payload: true,
      }),
    });

    if (!searchResponse.ok) {
      const errText = await searchResponse.text();
      throw new Error(`Qdrant search error: ${searchResponse.status} ${errText}`);
    }

    const searchData: any = await searchResponse.json();
    const results: any[] = searchData.result ?? [];

    return results.map((r) => ({
      chunkId: r.payload?.chunkId ?? r.id,
      documentId: r.payload?.documentId ?? '',
      content: r.payload?.content ?? '',
      score: r.score ?? 0,
    }));
  }

  /**
   * PostgreSQL ILIKE fallback when Qdrant is unavailable.
   * Clearly inferior to vector search — treats this as a degraded-mode signal.
   * Returns empty results if the database is also unreachable (unit test mode).
   */
  private async postgresFullTextFallback(
    organizationId: string,
    query: string,
    topK: number
  ): Promise<QdrantSearchResult[]> {
    try {
      const docChunks = await prisma.documentChunk.findMany({
        where: {
          organizationId,
          content: { contains: query, mode: 'insensitive' },
        },
        take: topK,
        orderBy: { chunkIndex: 'asc' },
      });

      return docChunks.map((chunk: any, idx: number) => ({
        chunkId: chunk.id,
        documentId: chunk.documentId,
        content: chunk.content,
        score: 0.6 - idx * 0.05, // Degraded score to signal fallback mode
      }));
    } catch (dbErr: any) {
      // Database is also unavailable — return empty results
      // The orchestrator will produce a generic "I'll have someone follow up" reply
      console.error(JSON.stringify({
        level: 'warn',
        service: 'QdrantRAGService',
        event: 'postgres_fallback_also_failed',
        error: dbErr.message,
        organizationId,
        action: 'returning_empty_rag_results',
      }));
      return [];
    }
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * ConversationOrchestrator
 *
 * Channel-agnostic AI conversation state machine.
 *
 * Assumptions made explicit:
 *   1. The organization already has a row in the `organizations` table.
 *   2. context.customerPhoneNumber is a valid E.164 phone number string.
 *      If it's undefined (e.g. webchat), contacts are created without a phone.
 *   3. The AI reply text is safe to send directly over WhatsApp/SMS —
 *      no markdown-to-plain-text conversion is applied here. Format appropriately
 *      for the channel in the channel adapter layer.
 *   4. Booking conflict detection uses a database read before write. At very high
 *      concurrency (>100 req/sec per org) this is not sufficient — a PostgreSQL
 *      advisory lock or serializable transaction would be needed. For Nigerian SME
 *      scale (< 500 bookings/day), the read-before-write pattern is acceptable.
 *
 * Breaking point at scale:
 *   - Intent matching is keyword-based. At 10+ distinct intent categories, a
 *     proper NLU model (fine-tuned GPT-4o function calling) is required.
 *   - The orchestrator instantiates a new QdrantRAGService per class instance.
 *     At high call rates, this does NOT cause connection pool issues (Qdrant is
 *     stateless HTTP), but the OpenAI embedding API calls add ~150-300ms latency.
 *     For voice calls (target: < 500ms response), RAG must be pre-warmed or cached.
 */
export class ConversationOrchestrator {
  private ragService: QdrantRAGService;

  constructor() {
    this.ragService = new QdrantRAGService();
  }

  async processIncomingMessage(
    context: ConversationContext,
    userMessageText: string
  ): Promise<OrchestrationResult> {
    const cleanInput = (userMessageText ?? '').trim();
    if (!cleanInput) {
      return {
        replyText: 'I received your message but it appears empty. Could you please try again?',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    const lowerInput = cleanInput.toLowerCase();

    // ── 1. Active human handoff check ────────────────────────────────────────
    if (context.isHumanHandoffActive) {
      return {
        replyText: '',
        confidenceScore: 1.0,
        shouldHandoff: true,
        handoffReason: HandoffReason.CUSTOMER_REQUEST,
      };
    }

    // ── 2. Explicit escalation request ───────────────────────────────────────
    const ESCALATION_PHRASES = [
      'speak to human', 'human agent', 'representative',
      'customer care agent', 'talk to a person', 'agent please',
      'i need a person', 'real person',
    ];
    if (ESCALATION_PHRASES.some((p) => lowerInput.includes(p))) {
      return {
        replyText: 'Connecting you to a live human agent right away. Please hold on a moment...',
        confidenceScore: 1.0,
        shouldHandoff: true,
        handoffReason: HandoffReason.CUSTOMER_REQUEST,
      };
    }

    // ── 3. Tool: Appointment Booking ─────────────────────────────────────────
    const APPOINTMENT_PHRASES = ['appointment', 'schedule consultation', 'book a doctor', 'reserve slot', 'book an appointment', 'book appointment'];
    if (APPOINTMENT_PHRASES.some((p) => lowerInput.includes(p))) {
      const toolResult = await this.executeBookAppointment(context);
      return {
        replyText: `✅ Your appointment has been confirmed for *${toolResult.time}*.\n\nYou'll receive a confirmation shortly. Is there anything else I can help with?`,
        intentDetected: 'BOOK_APPOINTMENT',
        confidenceScore: 0.98,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'book_appointment', result: toolResult }],
      };
    }

    // ── 4. Tool: Reservation ─────────────────────────────────────────────────
    const RESERVATION_PHRASES = ['reservation', 'book room', 'book table', 'book a room', 'book a table', 'reserve a table', 'make a reservation'];
    if (RESERVATION_PHRASES.some((p) => lowerInput.includes(p))) {
      const toolResult = await this.executeManageReservation(context);
      return {
        replyText: `✅ Your reservation for *${toolResult.partySize} guest(s)* at *${toolResult.time}* is confirmed. We look forward to hosting you!`,
        intentDetected: 'MANAGE_RESERVATION',
        confidenceScore: 0.96,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'manage_reservation', result: toolResult }],
      };
    }

    // ── 5. Tool: Check Booking / Reservation Status ──────────────────────────
    const CHECK_BOOKING_PHRASES = [
      'my booking', 'my appointment', 'my reservation', 'check my booking',
      'when is my appointment', 'booking status', 'reservation status', 'view my booking',
    ];
    if (CHECK_BOOKING_PHRASES.some((p) => lowerInput.includes(p))) {
      const result = await this.executeCheckBookingStatus(context);
      return {
        replyText: result.message,
        intentDetected: 'CHECK_BOOKING_STATUS',
        confidenceScore: 0.95,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'check_booking_status', result }],
      };
    }

    // ── 6. Tool: Cancel Booking / Reservation ─────────────────────────────────
    const CANCEL_BOOKING_PHRASES = [
      'cancel my booking', 'cancel my appointment', 'cancel appointment',
      'cancel my reservation', 'cancel reservation', 'i want to cancel',
      'please cancel', 'cancel booking',
    ];
    if (CANCEL_BOOKING_PHRASES.some((p) => lowerInput.includes(p))) {
      const result = await this.executeCancelBookingOrReservation(context);
      return {
        replyText: result.message,
        intentDetected: 'CANCEL_BOOKING',
        confidenceScore: 0.97,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'cancel_booking', result }],
      };
    }

    // ── 7. Tool: Reschedule Booking / Reservation ─────────────────────────────
    const RESCHEDULE_PHRASES = [
      'reschedule', 'change my appointment', 'move my booking', 'postpone',
      'change my booking', 'change my reservation', 'move my reservation',
      'different time', 'another time', 'change the date',
    ];
    if (RESCHEDULE_PHRASES.some((p) => lowerInput.includes(p))) {
      const result = await this.executeRescheduleBookingOrReservation(context);
      return {
        replyText: result.message,
        intentDetected: 'RESCHEDULE_BOOKING',
        confidenceScore: 0.96,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'reschedule_booking', result }],
      };
    }

    // ── 8. Tool: Request Refund ───────────────────────────────────────────────
    const REFUND_PHRASES = [
      'refund', 'money back', 'want my money back', 'give me my money',
      'request refund', 'i need a refund', 'charge back', 'chargeback',
      'return my money', 'reimburse', 'reimbursement',
    ];
    if (REFUND_PHRASES.some((p) => lowerInput.includes(p))) {
      const result = await this.executeRequestRefund(context, cleanInput);
      return {
        replyText: result.message,
        intentDetected: 'REQUEST_REFUND',
        confidenceScore: 0.97,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'request_refund', result }],
      };
    }

    const QUOTATION_PHRASES = ['quotation', 'price quote', 'how much for', 'billing breakdown', 'get a quote', 'cost of', 'pricing'];
    if (QUOTATION_PHRASES.some((p) => lowerInput.includes(p))) {
      const quoteResult = await this.executeGenerateQuotation(context, cleanInput);
      return {
        replyText: quoteResult.summaryText,
        intentDetected: 'REQUEST_QUOTATION',
        confidenceScore: 0.96,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'request_quotation', result: quoteResult }],
      };
    }

    // ── 10. Tool: Support Ticket ───────────────────────────────────────────────
    const TICKET_PHRASES = ['file a complaint', 'open ticket', 'issue with service', 'report problem', 'complaint', 'not working', 'broken'];
    if (TICKET_PHRASES.some((p) => lowerInput.includes(p))) {
      const ticketResult = await this.executeCreateTicket(context, cleanInput);
      return {
        replyText: `I've opened support ticket *#${ticketResult.ticketNumber}* for your inquiry. Our team has been notified and will follow up with you shortly.`,
        intentDetected: 'CREATE_TICKET',
        confidenceScore: 0.95,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'create_support_ticket', result: ticketResult }],
      };
    }

    // ── 11. Tool: AI Service Payment Guidance & Account Details ────────────────
    const PAYMENT_GUIDANCE_PHRASES = [
      'how to pay', 'how do i pay', 'account number', 'bank details', 'payment options',
      'payment link', 'pay for booking', 'ussd code', 'i want to pay', 'payment method',
      'transfer details', 'pay now', 'make payment', 'send payment details', 'how much to pay'
    ];
    if (PAYMENT_GUIDANCE_PHRASES.some((p) => lowerInput.includes(p))) {
      const guidanceResult = await this.executeProvidePaymentGuidance(context);
      return {
        replyText: guidanceResult.replyText,
        intentDetected: 'PROVIDE_PAYMENT_GUIDANCE',
        confidenceScore: 0.98,
        shouldHandoff: false,
        toolCallsExecuted: [{ toolName: 'provide_payment_guidance', result: guidanceResult }],
      };
    }

    // ── 11. RAG Knowledge Search ──────────────────────────────────────────────
    const searchResults = await this.ragService.searchKnowledgeBase(
      context.organizationId,
      cleanInput,
      RAG_TOP_K
    );

    let kbContextText = '';
    if (searchResults.length > 0) {
      // Only use high-confidence results (score > 0.5)
      const relevant = searchResults.filter((r) => r.score > 0.5);
      kbContextText = relevant.map((r) => r.content).join('\n---\n');
    }

    // ── 12. Persona & GPT-4o response synthesis ──────────────────────────────
    let org: any = null;
    try {
      org = await prisma.organization.findUnique({
        where: { id: context.organizationId },
        select: { name: true, aiPersonaPrompt: true, welcomeMessage: true },
      });
    } catch (dbErr: any) {
      console.error(JSON.stringify({
        level: 'error',
        service: 'ConversationOrchestrator',
        event: 'org_fetch_failed',
        organizationId: context.organizationId,
        error: dbErr.message,
      }));
    }

    if (!org) {
      console.error(JSON.stringify({
        level: 'error',
        service: 'ConversationOrchestrator',
        event: 'organization_not_found',
        organizationId: context.organizationId,
        action: 'returning_generic_response',
      }));
    }

    const orgName = org?.name ?? 'our service';

    // Honest AI disclosure.
    // The previous version denied being an AI ("Haha, no! I'm a customer support
    // representative..."). That is a compliance liability — the EU AI Act's
    // transparency obligations and Meta's WhatsApp Business messaging policies
    // require automated agents to identify as such when asked — and it burns
    // customer trust the moment the deception is noticed.
    const AI_DISCLOSURE_PHRASES = ['are you an ai', 'are you a robot', 'are you ai', 'is this a bot', 'are you human', 'am i talking to a machine'];
    if (AI_DISCLOSURE_PHRASES.some((p) => lowerInput.includes(p))) {
      return {
        replyText:
          `Yes — I'm ${orgName}'s AI assistant. I can help with bookings, payments, and any questions about our services, ` +
          `and I can bring in a human teammate whenever you prefer: just say *"speak to an agent"*.`,
        intentDetected: 'AI_DISCLOSURE',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    // ── GPT-4o synthesis — uses the org's configured persona prompt ───────────
    const openAiKey = process.env.OPENAI_API_KEY;

    // If it's a greeting AND no knowledge base context, just use the welcome message.
    const GREETING_WORDS = ['hello', 'hi', 'good day', 'hey', 'good morning', 'good afternoon', 'good evening'];
    const isGreeting = GREETING_WORDS.some((g) => lowerInput.startsWith(g)) && cleanInput.length < 30;
    if (isGreeting) {
      const synthesizedReply = org?.welcomeMessage ??
        `Hello! Welcome to ${orgName}. How can I help you today?`;
      return {
        replyText: synthesizedReply,
        intentDetected: 'GREETING',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    if (openAiKey) {
      try {
        const systemPrompt = org?.aiPersonaPrompt
          ? org.aiPersonaPrompt
          : `You are a professional customer support assistant for ${orgName}. ` +
            `Be helpful, concise, and friendly. Respond in plain text without markdown unless formatting helps clarity. ` +
            `If you cannot answer something, offer to connect the customer with a human agent.`;

        const userContent = kbContextText
          ? `The following information from our knowledge base may be relevant:\n\n${kbContextText}\n\n---\n\nCustomer message: ${cleanInput}`
          : cleanInput;

        const gptResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openAiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 400,
            temperature: 0.6,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userContent },
            ],
          }),
        });

        if (gptResponse.ok) {
          const gptData: any = await gptResponse.json();
          const aiReply = gptData.choices?.[0]?.message?.content?.trim();
          if (aiReply) {
            return {
              replyText: aiReply,
              intentDetected: kbContextText ? 'KB_ANSWER' : 'GENERAL_INQUIRY',
              confidenceScore: kbContextText ? 0.92 : 0.78,
              shouldHandoff: false,
            };
          }
        } else {
          const errText = await gptResponse.text();
          console.error(JSON.stringify({
            level: 'warn',
            service: 'ConversationOrchestrator',
            event: 'gpt4o_call_failed',
            status: gptResponse.status,
            error: errText.slice(0, 200),
            organizationId: context.organizationId,
          }));
        }
      } catch (gptErr: any) {
        console.error(JSON.stringify({
          level: 'warn',
          service: 'ConversationOrchestrator',
          event: 'gpt4o_exception',
          error: gptErr.message,
          organizationId: context.organizationId,
        }));
      }
    }

    // Fallback: if GPT call fails or key not set, use KB text or a minimal template
    const fallbackReply = kbContextText
      ? `${kbContextText}\n\nIs there anything else I can help you with?`
      : `Thank you for contacting ${orgName}. A member of our team will follow up with you shortly regarding your inquiry. ` +
        `You can also say *"speak to an agent"* to be connected immediately.`;

    return {
      replyText: fallbackReply,
      intentDetected: 'GENERAL_INQUIRY',
      confidenceScore: kbContextText ? 0.72 : 0.50,
      shouldHandoff: false,
    };
  }

  // ─── Booking Management Tool Implementations ────────────────────────────────

  /**
   * Check the customer's most recent active booking or reservation.
   */
  private async executeCheckBookingStatus(context: ConversationContext) {
    const phone = context.customerPhoneNumber;
    if (!phone) {
      return { message: 'I was unable to locate your booking — please provide your phone number.' };
    }

    // Check bookings first, then reservations
    const booking = await prisma.booking.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: phone },
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { startTime: 'desc' },
    });

    if (booking) {
      const timeStr = booking.startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
      return {
        bookingId: booking.id,
        type: 'BOOKING',
        message:
          `📅 *Your Booking Details*\n\n` +
          `• Service: ${booking.serviceName}\n` +
          `• Date & Time: ${timeStr}\n` +
          `• Staff: ${booking.staffName ?? 'Any available'}\n` +
          `• Status: ${booking.status}\n` +
          `• Reference: #${booking.id.slice(-8).toUpperCase()}\n\n` +
          `To *cancel* or *reschedule*, just say so and I'll handle it for you.`,
      };
    }

    const reservation = await prisma.reservation.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: phone },
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { reservationTime: 'desc' },
    });

    if (reservation) {
      const timeStr = reservation.reservationTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
      return {
        reservationId: reservation.id,
        type: 'RESERVATION',
        message:
          `🍽️ *Your Reservation Details*\n\n` +
          `• Party Size: ${reservation.partySize} guest(s)\n` +
          `• Date & Time: ${timeStr}\n` +
          `• Table/Room: ${reservation.tableOrRoomNumber ?? 'To be assigned'}\n` +
          `• Special Requests: ${reservation.specialRequests ?? 'None'}\n` +
          `• Status: ${reservation.status}\n` +
          `• Reference: #${reservation.id.slice(-8).toUpperCase()}\n\n` +
          `To *cancel* or *reschedule*, just say so and I'll handle it for you.`,
      };
    }

    return {
      message:
        `I couldn't find an active booking or reservation linked to your number. ` +
        `If you believe this is an error, please say *"speak to an agent"* and a team member will assist you.`,
    };
  }

  /**
   * Cancel the customer's most recent active booking or reservation.
   */
  private async executeCancelBookingOrReservation(context: ConversationContext) {
    const phone = context.customerPhoneNumber;
    if (!phone) {
      return { message: 'I need your phone number on file to cancel a booking. Please contact our team directly.' };
    }

    // Try booking first
    const booking = await prisma.booking.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: phone },
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { startTime: 'desc' },
    });

    if (booking) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CANCELLED', notes: 'Cancelled by customer via AI assistant', updatedAt: new Date() },
      });
      return {
        bookingId: booking.id,
        message:
          `✅ Your booking for *${booking.serviceName}* has been successfully cancelled.\n\n` +
          `Reference: #${booking.id.slice(-8).toUpperCase()}\n\n` +
          `If you paid and would like a refund, please say *"I need a refund"* and I'll raise a request for you.`,
      };
    }

    // Try reservation
    const reservation = await prisma.reservation.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: phone },
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { reservationTime: 'desc' },
    });

    if (reservation) {
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: 'CANCELLED', specialRequests: 'Cancelled by customer via AI assistant', updatedAt: new Date() },
      });
      return {
        reservationId: reservation.id,
        message:
          `✅ Your reservation for *${reservation.partySize} guest(s)* has been successfully cancelled.\n\n` +
          `Reference: #${reservation.id.slice(-8).toUpperCase()}\n\n` +
          `If you paid a deposit and would like a refund, please say *"I need a refund"*.`,
      };
    }

    return {
      message:
        `I couldn't find an active booking or reservation to cancel under your number. ` +
        `If you need help, say *"speak to an agent"* and someone will assist you.`,
    };
  }

  /**
   * Reschedule the customer's most recent active booking/reservation.
   * Since we're in a single-turn conversation (no multi-turn state yet),
   * we reschedule to the next available slot (tomorrow, 10 AM) and invite
   * the customer to call back to pick a specific time.
   *
   * TODO (multi-turn): Implement a slot-picker conversation flow.
   */
  private async executeRescheduleBookingOrReservation(context: ConversationContext) {
    const phone = context.customerPhoneNumber;
    if (!phone) {
      return { message: 'I need your phone number on file to reschedule. Please contact our team directly.' };
    }

    // Try booking
    const booking = await prisma.booking.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: phone },
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { startTime: 'desc' },
    });

    if (booking) {
      const { startTime: newTime, endTime } = await findNextFreeSlot(
        context.organizationId,
        DEFAULT_APPOINTMENT_DURATION_MINUTES
      );
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'RESCHEDULED', startTime: newTime, endTime, updatedAt: new Date() },
      });
      const timeStr = newTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
      return {
        bookingId: booking.id,
        newTime: timeStr,
        message:
          `📅 Your *${booking.serviceName}* appointment has been rescheduled to:\n\n` +
          `*${timeStr}*\n\n` +
          `Reference: #${booking.id.slice(-8).toUpperCase()}\n\n` +
          `If you'd prefer a specific date and time, please call us or say *"speak to an agent"* and we'll arrange it.`,
      };
    }

    // Try reservation
    const reservation = await prisma.reservation.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: phone },
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
      },
      include: { contact: true },
      orderBy: { reservationTime: 'desc' },
    });

    if (reservation) {
      const newTime = tomorrowAt10Lagos(); // reservations have no slot model — default to tomorrow 10:00 Lagos
      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: 'RESCHEDULED', reservationTime: newTime, updatedAt: new Date() },
      });
      const timeStr = newTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' });
      return {
        reservationId: reservation.id,
        newTime: timeStr,
        message:
          `🍽️ Your reservation for *${reservation.partySize} guest(s)* has been rescheduled to:\n\n` +
          `*${timeStr}*\n\n` +
          `Reference: #${reservation.id.slice(-8).toUpperCase()}\n\n` +
          `Need a specific date or time? Say *"speak to an agent"* and we'll sort it out.`,
      };
    }

    return {
      message:
        `I couldn't find an active booking or reservation to reschedule under your number. ` +
        `Please say *"speak to an agent"* for help.`,
    };
  }

  /**
   * Request a refund — creates a HIGH-priority REF-* ticket visible in admin queue.
   * Works for both bookings and reservations.
   */
  private async executeRequestRefund(context: ConversationContext, messageText: string) {
    const phone = context.customerPhoneNumber;
    if (!phone) {
      return {
        message:
          'To process a refund, I need to locate your booking. ' +
          'Please ensure your phone number is registered with us or say *"speak to an agent"*.',
      };
    }

    const contact = await prisma.contact.findFirst({
      where: { organizationId: context.organizationId, phoneNumber: phone },
    });

    if (!contact) {
      return {
        message:
          `I couldn't find an account linked to this number. ` +
          `Please say *"speak to an agent"* and a team member will process your refund manually.`,
      };
    }

    // Look for most recent completed or cancelled booking/reservation to refund
    const booking = await prisma.booking.findFirst({
      where: {
        organizationId: context.organizationId,
        contactId: contact.id,
        status: { in: ['CONFIRMED', 'RESCHEDULED', 'CANCELLED', 'COMPLETED'] },
      },
      orderBy: { startTime: 'desc' },
    });

    const ticketNumber = `REF-${booking ? 'BK' : 'RS'}-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
    const subject = booking
      ? `Refund Request — ${booking.serviceName} on ${booking.startTime.toLocaleDateString('en-NG')}`
      : `Refund Request — Reservation (${contact.fullName})`;

    const description =
      `Customer requested a refund via AI assistant.\n\n` +
      `Contact: ${contact.fullName} (${phone})\n` +
      (booking ? `Booking: ${booking.serviceName} — ${booking.startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}\n` : '') +
      `\nCustomer message: "${messageText.slice(0, 300)}"`;

    const ticket = await prisma.ticket.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        ticketNumber,
        subject,
        description,
        status: 'OPEN',
        priority: 'HIGH',
        updatedAt: new Date(),
      },
    });

    return {
      ticketId: ticket.id,
      ticketNumber,
      message:
        `💰 *Refund Request Submitted*\n\n` +
        `Your refund request has been raised with our admin team.\n\n` +
        `• Ticket Number: *${ticketNumber}*\n` +
        `• Priority: HIGH\n` +
        `• Expected Response: Within 24–48 business hours\n\n` +
        `Our team will review your request and contact you on this number once approved. ` +
        `Is there anything else I can help you with?`,
    };
  }


  /**
   * Book an appointment at the next CONFLICT-FREE slot (see findNextFreeSlot).
   *
   * Race condition note: still read-then-write without a lock — two truly
   * concurrent requests can race into the same slot. At > 500 bookings/day,
   * wrap in prisma.$transaction(..., { isolationLevel: 'Serializable' }).
   */
  private async executeBookAppointment(context: ConversationContext) {
    const contact = await this.getOrCreateContact(context);

    // Two attempts: find a free slot, then re-check + create inside ONE
    // transaction so a concurrent booking between "find" and "create" is
    // caught. If the slot was taken in that window, re-scan once (the scan
    // now sees the competitor's row). Not fully serializable, but it closes
    // the common single-overlap race without transaction-retry machinery.
    for (let attempt = 0; attempt < 2; attempt++) {
      const { startTime, endTime } = await findNextFreeSlot(
        context.organizationId,
        DEFAULT_APPOINTMENT_DURATION_MINUTES
      );

      const booking = await prisma.$transaction(async (tx: any) => {
        const clash = await tx.booking.findFirst({
          where: {
            organizationId: context.organizationId,
            status: { in: ['CONFIRMED', 'RESCHEDULED'] },
            startTime: { lt: endTime },
            endTime: { gt: startTime },
          },
          select: { id: true },
        });
        if (clash) return null;

        return tx.booking.create({
          data: {
            organizationId: context.organizationId,
            contactId: contact.id,
            serviceName: 'General Consultation',
            startTime,
            endTime,
            status: 'CONFIRMED',
          },
        });
      });

      if (booking) {
        return {
          bookingId: booking.id,
          time: startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }),
        };
      }
    }

    throw new Error(
      `Could not secure a booking slot after 2 attempts (organizationId=${context.organizationId}) — heavy concurrent booking activity.`
    );
  }

  private async executeManageReservation(context: ConversationContext) {
    const contact = await this.getOrCreateContact(context);
    const reservationTime = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const reservation = await prisma.reservation.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        partySize: 2,
        reservationTime,
        status: 'CONFIRMED',
      },
    });

    return {
      reservationId: reservation.id,
      partySize: 2,
      time: reservationTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }),
    };
  }

  /**
   * Quotation request → ticket for the team, honest reply to the customer.
   *
   * The previous version invented a price ("Estimated Total: ₦35,000") for any
   * organization and any service, and linked a PDF at /api/documents/quotation/
   * — an endpoint that does not exist. A chatbot quoting fabricated prices to
   * real customers is a business liability; the honest behavior is to log the
   * request and have the team send a real quotation.
   */
  private async executeGenerateQuotation(context: ConversationContext, promptText: string) {
    const contact = await this.getOrCreateContact(context);
    const quoteNum = `QUO-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

    const ticket = await prisma.ticket.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        ticketNumber: quoteNum,
        subject: `Quotation Request — ${promptText.slice(0, 80)}`,
        description:
          `Customer requested a price quotation via AI assistant.\n\n` +
          `Contact: ${contact.fullName} (${contact.phoneNumber})\n\n` +
          `Customer message: "${promptText.slice(0, 300)}"`,
        status: 'OPEN',
        priority: 'MEDIUM',
        updatedAt: new Date(),
      },
    });

    return {
      quotationNumber: quoteNum,
      ticketId: ticket.id,
      summaryText:
        `📄 *Quotation Request Logged — #${quoteNum}*\n\n` +
        `I've passed your request to our team, who will prepare an official quotation with exact pricing ` +
        `and send it to you on this channel shortly.\n\n` +
        `To speed things up, feel free to reply with any details about what you need ` +
        `(service type, quantity, dates).`,
    };
  }

  private async executeCreateTicket(context: ConversationContext, subjectText: string) {
    const contact = await this.getOrCreateContact(context);
    const ticketNumber = `TCK-${Date.now().toString().slice(-6)}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

    const ticket = await prisma.ticket.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        ticketNumber,
        subject: subjectText.slice(0, 100),
        description: subjectText,
        status: 'OPEN',
        priority: 'MEDIUM',
      },
    });

    return { ticketId: ticket.id, ticketNumber: ticket.ticketNumber };
  }

  /**
   * Payment guidance — uses the organization's CONFIGURED payment details
   * (Settings → payment fields), or honestly defers to a human when none are set.
   *
   * The previous version quoted a hardcoded Providus Bank account (9928374102),
   * fabricated USSD merchant codes, and linked /api/billing/pay-service — an
   * endpoint that does not exist. Customers would have wired real money to a
   * placeholder account. The AI must never invent payment destinations.
   */
  private async executeProvidePaymentGuidance(context: ConversationContext) {
    const org = await prisma.organization.findUnique({
      where: { id: context.organizationId },
      select: { name: true, paymentBankName: true, paymentAccountName: true, paymentAccountNumber: true },
    });
    const orgName = org?.name ?? 'our team';
    const reference = `ACE_PAY_${context.organizationId.slice(0, 6)}_${Date.now().toString().slice(-6)}`;

    const hasBankDetails = !!(org?.paymentBankName && org?.paymentAccountNumber);

    if (hasBankDetails) {
      const replyText =
        `💳 *Payment Details (${orgName})*\n\n` +
        `1️⃣ *Bank Transfer*\n` +
        `• Bank Name: *${org!.paymentBankName}*\n` +
        `• Account Name: *${org!.paymentAccountName ?? orgName}*\n` +
        `• Account Number: \`${org!.paymentAccountNumber}\`\n` +
        `• Payment Reference: \`${reference}\`\n\n` +
        `📌 *After Payment:* Reply *"PAID"* or send a screenshot of your transfer receipt, ` +
        `and our team will confirm your payment.`;

      return {
        reference,
        bankName: org!.paymentBankName,
        accountName: org!.paymentAccountName ?? orgName,
        accountNumber: org!.paymentAccountNumber,
        replyText,
      };
    }

    // No payment details configured — defer instead of inventing an account.
    return {
      reference,
      replyText:
        `I want to make sure your payment goes to the right place, so I won't guess at account details. ` +
        `A teammate from ${orgName} will confirm the payment details with you right away — ` +
        `or say *"speak to an agent"* and I'll connect you now.`,
    };
  }

  /**
   * Find or create a Contact for the conversation.
   *
   * If customerPhoneNumber is missing (e.g. anonymous webchat), we do NOT
   * create a contact — that would pollute the CRM with garbage records.
   * Instead we throw a descriptive error that the caller can handle.
   *
   * This replaces the previous fallback to '+2348000000000' which would have
   * created a single phantom contact absorbing all anonymous sessions.
   */
  private async getOrCreateContact(context: ConversationContext) {
    const phone = context.customerPhoneNumber;
    if (!phone) {
      throw new Error(
        `Cannot create Contact: customerPhoneNumber is missing in ConversationContext. ` +
        `conversationId=${context.conversationId}, channel=${context.channel}`
      );
    }

    // Race-safe upsert: catch unique constraint violation and re-query
    try {
      const existing = await prisma.contact.findFirst({
        where: { organizationId: context.organizationId, phoneNumber: phone },
      });
      if (existing) return existing;

      return await prisma.contact.create({
        data: {
          organizationId: context.organizationId,
          phoneNumber: phone,
          fullName: `Valued Customer (···${phone.slice(-4)})`,
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Another concurrent request created this contact first
        const contact = await prisma.contact.findFirst({
          where: { organizationId: context.organizationId, phoneNumber: phone },
        });
        if (contact) return contact;
      }
      // Database is genuinely down or misconfigured — rethrow so the caller
      // sees a real error rather than a fake mock_contact_ ID
      throw new Error(
        `Failed to upsert contact for phone ${phone.slice(-4)}: ${err.message}. ` +
        `Check database connectivity (DATABASE_URL, PostgreSQL container status).`
      );
    }
  }
}
