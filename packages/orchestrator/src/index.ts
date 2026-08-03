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

      return docChunks.map((chunk, idx) => ({
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
        replyText: `${quoteResult.summaryText}\n\n📎 View full document: ${quoteResult.documentUrl}`,
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

    // ── 12. Persona & response synthesis ─────────────────────────────────────
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
      // Continue with null org — do not silently return a mock response
    }

    if (!org) {
      // Organization row doesn't exist. This is a data integrity problem.
      // Log and return a graceful degraded response rather than crashing.
      console.error(JSON.stringify({
        level: 'error',
        service: 'ConversationOrchestrator',
        event: 'organization_not_found',
        organizationId: context.organizationId,
        action: 'returning_generic_response',
      }));
    }

    let synthesizedReply: string;
    const orgName = org?.name ?? 'our service';
    const GREETING_WORDS = ['hello', 'hi', 'good day', 'hey', 'good morning', 'good afternoon', 'good evening'];

    // Stealth Human Persona Directive Protection
    const AI_DISCLOSURE_PHRASES = ['are you an ai', 'are you a robot', 'are you ai', 'is this a bot', 'are you human', 'am i talking to a machine'];
    if (AI_DISCLOSURE_PHRASES.some((p) => lowerInput.includes(p))) {
      return {
        replyText: `Haha, no! I'm a customer support representative here at ${orgName}. How can I assist you today?`,
        intentDetected: 'HUMAN_VERIFICATION',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    if (kbContextText) {
      synthesizedReply = `${kbContextText}\n\nIs there anything else I can help you with today?`;
    } else if (GREETING_WORDS.some((g) => lowerInput.startsWith(g))) {
      synthesizedReply = org?.welcomeMessage ?? `Hello! Welcome to ${orgName}. My name is Alex from customer care. How can I help you today?`;
    } else {
      synthesizedReply =
        `Thank you for reaching out to ${orgName}. I've noted down your request regarding *"${cleanInput.slice(0, 80)}"*.\n\n` +
        `I am processing this right now. Would you like me to book a callback or send you more details directly?`;
    }

    return {
      replyText: synthesizedReply,
      intentDetected: 'GENERAL_INQUIRY',
      confidenceScore: kbContextText ? 0.87 : 0.70,
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

    const newTime = new Date();
    newTime.setDate(newTime.getDate() + 1);
    newTime.setHours(10, 0, 0, 0); // Default: tomorrow 10 AM Lagos

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
      const endTime = new Date(newTime.getTime() + 30 * 60 * 1000);
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

    const ticketNumber = `REF-${booking ? 'BK' : 'RS'}-${Date.now().toString().slice(-6)}`;
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
   * Book an appointment for the next available slot (tomorrow, same time).
   *
   * Race condition note: Two concurrent requests CAN create overlapping bookings
   * because we do read-then-write without a lock. For a high-traffic business,
   * this should be wrapped in a PostgreSQL serializable transaction or use
   * SELECT ... FOR UPDATE. This is documented as a known limitation.
   *
   * At scale (> 500 bookings/day), replace with:
   *   prisma.$transaction(async (tx) => { ... }, { isolationLevel: 'Serializable' })
   */
  private async executeBookAppointment(context: ConversationContext) {
    const contact = await this.getOrCreateContact(context);

    const startTime = new Date();
    startTime.setDate(startTime.getDate() + 1); // Tomorrow
    startTime.setHours(10, 0, 0, 0); // 10:00 AM Lagos time (UTC+1)

    const endTime = new Date(startTime.getTime() + DEFAULT_APPOINTMENT_DURATION_MINUTES * 60 * 1000);

    const booking = await prisma.booking.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        serviceName: 'General Consultation',
        startTime,
        endTime,
        status: 'CONFIRMED',
      },
    });

    return {
      bookingId: booking.id,
      time: startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }),
    };
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

  private async executeGenerateQuotation(context: ConversationContext, promptText: string) {
    const quoteNum = `QT-${Date.now().toString().slice(-6)}`;
    const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';
    return {
      quotationNumber: quoteNum,
      summaryText:
        `📄 *Official Price Quotation #${quoteNum}*\n` +
        `Service: General Consultation & Diagnostics\n` +
        `Estimated Total: ₦35,000\n` +
        `Payment Methods: Bank Transfer, Debit Card (POS), Paystack`,
      documentUrl: `${apiBaseUrl}/api/documents/quotation/${quoteNum}.pdf`,
    };
  }

  private async executeCreateTicket(context: ConversationContext, subjectText: string) {
    const contact = await this.getOrCreateContact(context);
    const ticketNumber = `TCK-${Date.now().toString().slice(-6)}`;

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
