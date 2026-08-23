import {
  ConversationContext,
  OrchestrationResult,
  HandoffReason,
  ChannelType,
} from '@ace/shared-types';
import { createSelfieRequest, prisma, selfieUploadUrl, withWhatsAppCredentials, normalizePhoneNumber, phoneNumberVariants, createTicketWithUniqueNumber } from '@ace/database';
import {
  detectLanguage, asLanguage, t, LANGUAGE_NAMES, SPEAKABLE_LANGUAGES,
  explicitLanguageRequest, wantsLanguageMenu, parseLanguageChoice, LANGUAGE_MENU_MARKER,
  type Language,
} from './languages';
export {
  detectLanguage, asLanguage, t, LANGUAGE_NAMES, SUPPORTED_LANGUAGES, SPEAKABLE_LANGUAGES,
  explicitLanguageRequest, wantsLanguageMenu, parseLanguageChoice, LANGUAGE_MENU_MARKER,
} from './languages';
export type { Language } from './languages';
import { WhatsAppCloudClient } from '@ace/whatsapp-sdk';
import { chatCompletionsUrl, embeddingsUrl, llmConfig } from './llm';

export * from './llm';

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
 * Embedding model and its output dimensionality.
 *
 * These MUST match what document.worker.ts writes, or query vectors will not be
 * comparable with stored ones (Qdrant rejects a dimension mismatch outright).
 */
// Read through llmConfig() so a free OpenAI-compatible provider can be used
// without editing code (see llm.ts). Read per call, not captured at import:
// tests and scripts set these after this module is loaded.
const EMBEDDING_MODEL = () => llmConfig().embeddingModel;
const EMBEDDING_DIMENSIONS = () => llmConfig().embeddingDimensions;

/**
 * Appointment duration in minutes. Should come from organization config in a
 * future iteration — currently a platform-wide default.
 */
const DEFAULT_APPOINTMENT_DURATION_MINUTES = 30;

/** Business timezone for all customer-facing times. */
const BUSINESS_TIMEZONE = 'Africa/Lagos';

/** Operating hours, in West Africa Time (UTC+1, no DST). */
const BUSINESS_OPEN_HOUR_WAT = 8;
const BUSINESS_CLOSE_HOUR_WAT = 18;

/** Prior turns handed to the LLM as conversational context. */
const MAX_HISTORY_TURNS = 12;

// ─── Time helpers ────────────────────────────────────────────────────────────

/**
 * West Africa Time is UTC+1 year-round (no daylight saving), so the offset is a
 * constant. This matters because the previous code used `Date#setHours`, which
 * applies the *server's* local timezone — on a UTC host (every container in
 * render.yaml) "10:00 AM Lagos time" was actually written as 10:00 UTC, i.e. 11:00
 * in Lagos, and then re-rendered with `toLocaleString('en-NG', { timeZone })` so the
 * customer was quoted an hour later than the slot that was reserved.
 */
const WAT_OFFSET_HOURS = 1;

function watHour(date: Date): number {
  return (date.getUTCHours() + WAT_OFFSET_HOURS) % 24;
}

/** Day of week in WAT: 0 = Sunday … 6 = Saturday. */
function watDay(date: Date): number {
  const shifted = new Date(date.getTime() + WAT_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.getUTCDay();
}

function isWithinBusinessHours(date: Date): boolean {
  const day = watDay(date);
  if (day === 0 || day === 6) return false; // closed at weekends
  const hour = watHour(date);
  return hour >= BUSINESS_OPEN_HOUR_WAT && hour < BUSINESS_CLOSE_HOUR_WAT;
}

function formatLagos(date: Date): string {
  return date.toLocaleString('en-NG', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── Message parsing helpers ─────────────────────────────────────────────────

/**
 * True when the customer is asking whether they are talking to a machine.
 *
 * Answering honestly is not optional: disclosure on request is required in several
 * of the markets this platform targets (California B.O.T. Act §17941, EU AI Act
 * Art. 50), and this code used to actively deny it.
 */
function isAiDisclosureQuestion(lowerInput: string): boolean {
  const PHRASES = [
    'are you an ai', 'are you ai', 'are you a robot', 'are you a bot',
    'is this a bot', 'is this an ai', 'is this a robot',
    'are you human', 'are you a human', 'are you a person', 'are you a real person',
    'is this a real person', 'is this a human',
    'am i talking to a machine', 'am i talking to a robot', 'am i talking to a bot',
    'am i speaking to a robot', 'am i chatting with a bot',
  ];
  return PHRASES.some((p) => lowerInput.includes(p));
}

/** "table for 6", "party of four", "6 people" → 6 */
function extractPartySize(text: string): number | null {
  const WORDS: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  };

  const numeric = text.match(/\b(?:for|of|party of|table for)\s+(\d{1,2})\b/i)
    ?? text.match(/\b(\d{1,2})\s*(?:people|persons|guests|pax)\b/i);
  if (numeric) {
    const n = parseInt(numeric[1], 10);
    if (n >= 1 && n <= 50) return n;
  }

  const worded = text.match(/\b(?:for|of|party of|table for)\s+(one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b/i);
  if (worded) return WORDS[worded[1].toLowerCase()] ?? null;

  return null;
}

/**
 * Phrases that mean "do something to the booking I already have".
 *
 * ── Why these are module constants and not inline ────────────────────────────
 *
 * They were declared inside their own branches, several sections below the
 * branch that CREATES a booking — and that branch triggered on the bare word
 * "appointment". So it matched first, every time:
 *
 *     "cancel my appointment"      → created a second appointment
 *     "when is my appointment"     → created an appointment
 *     "reschedule my appointment"  → created an appointment
 *
 * A customer trying to cancel was told "I've put you down for..." and left with
 * two bookings and nothing cancelled. Hoisting them here is what lets the
 * create branches ask "is this actually about an existing booking?" before
 * acting, which is the only ordering that cannot silently break again when
 * somebody adds a phrase.
 */
export const CHECK_BOOKING_PHRASES = [
  'my booking', 'my appointment', 'my reservation', 'check my booking',
  'when is my appointment', 'booking status', 'reservation status', 'view my booking',
];

export const CANCEL_BOOKING_PHRASES = [
  'cancel my booking', 'cancel my appointment', 'cancel appointment',
  'cancel my reservation', 'cancel reservation', 'i want to cancel',
  'please cancel', 'cancel booking',
];

export const RESCHEDULE_PHRASES = [
  'reschedule', 'change my appointment', 'move my booking', 'postpone',
  'change my booking', 'change my reservation', 'move my reservation',
  'different time', 'another time', 'change the date',
];

/**
 * NEXT_UPCOMING — how every "my booking" lookup in this file is scoped.
 *
 * Two rules, applied together at each site:
 *
 *   `<time>: { gte: new Date() }` + `orderBy: <time> asc`
 *       The NEXT one, not the latest. These ordered descending with no lower
 *       bound, so a customer with an appointment this Friday and another next
 *       month was told about next month — and "cancel my appointment" cancelled
 *       next month while Friday silently stayed. Past bookings were in scope
 *       too, offered as though they were still to come, while the empty-result
 *       wording said "I can't find an upcoming appointment".
 *
 *   `contact: { phoneNumber: { in: phoneNumberVariants(phone) } }`
 *       Every stored shape, not an exact match. The same person arrives as
 *       "+234…" on a call and "234…" on WhatsApp, so an exact match made a
 *       booking taken on one channel invisible from the other. That is the bug
 *       phoneNumberVariants exists to remove; these sites filter through the
 *       relation rather than the contact, which is why the original sweep
 *       missed them.
 *
 * The refund lookup deliberately does NOT follow this: it wants the most recent
 * PAST booking to refund, so it keeps `desc` and no lower bound.
 */

/** True when the customer is talking about a booking they already have. */
export function isAboutExistingBooking(lowerInput: string): boolean {
  return [...CHECK_BOOKING_PHRASES, ...CANCEL_BOOKING_PHRASES, ...RESCHEDULE_PHRASES].some((p) =>
    lowerInput.includes(p)
  );
}

export const wantsToCancel = (lowerInput: string): boolean =>
  CANCEL_BOOKING_PHRASES.some((p) => lowerInput.includes(p));

export const wantsToReschedule = (lowerInput: string): boolean =>
  RESCHEDULE_PHRASES.some((p) => lowerInput.includes(p));

/**
 * Precedence, most specific first: cancel and reschedule beat "check", and all
 * three beat "book".
 *
 * Without this, guarding only the create branches moved the bug instead of
 * fixing it — "cancel my appointment" contains "my appointment", so the status
 * branch answered with the booking's details and cancelled nothing. Less
 * destructive than creating a second appointment, and still the wrong answer to
 * the question asked.
 */
export const wantsStatusOnly = (lowerInput: string): boolean =>
  CHECK_BOOKING_PHRASES.some((p) => lowerInput.includes(p)) &&
  !wantsToCancel(lowerInput) &&
  !wantsToReschedule(lowerInput);

/**
 * Words that are never a service, however they are arranged.
 *
 * A denylist rather than a language model because the cost of a wrong answer is
 * asymmetric: filing a booking under a filler word puts nonsense in a real
 * calendar and reads it back to the customer as if the business offered it,
 * while falling back to the default merely loses a detail a human can add.
 */
const SERVICE_NAME_FILLER = new Set([
  // Articles, pronouns, prepositions.
  'a', 'an', 'the', 'me', 'us', 'my', 'our', 'myself', 'ourselves',
  'it', 'him', 'her', 'them', 'you', 'your', 'some', 'any',
  'to', 'for', 'of', 'and', 'please', 'now', 'today', 'tomorrow', 'new',
  // The trigger verbs themselves. The pattern anchors on the FIRST of them, so
  // "i want to book an appointment" captures "to book an" — the second verb
  // included — and filed the service as "Book". A verb is never a service, and
  // sacrificing the vanishingly rare "book binding" is worth not putting the
  // word "Book" in every calendar.
  'book', 'schedule', 'arrange', 'need', 'want', 'make', 'get', 'have',
  'take', 'set', 'up', 'like', 'would',
]);

/**
 * The generic word for a booking, standing alone.
 *
 * "I want an appointment" names no service — it says the customer wants one.
 * Filing that as a service called "Appointment" reads, in a calendar, exactly
 * like a service the business offers. The default says the same thing and is
 * honest about being a default.
 *
 * Only when the phrase is nothing BUT this word: "dental consultation" keeps
 * every word of what the customer actually asked for.
 */
const GENERIC_BOOKING_WORDS = new Set([
  'appointment', 'appointments', 'consultation', 'session', 'booking', 'slot',
]);

/**
 * Best-effort service name from the customer's own words, so a booking is not
 * always filed as "General Consultation" regardless of what was asked for.
 *
 * ── Why the filtering, and not just the regex ────────────────────────────────
 *
 * "book me an appointment" used to produce the service name "Me an".
 *
 * The capture group sits between the verb and the word "appointment", and the
 * article group only consumes "a"/"an" — so with "me" in the way it consumed
 * nothing and the lazy capture swallowed "me an" instead. The old guard was a
 * denylist of SINGLE words (`^(a|an|the|me|us|it)$`), so "me" alone would have
 * been caught and "me an" sailed through.
 *
 * The customer was then told "I've put you down for *Me an*", and a staff member
 * opened the calendar to a booking for a service that does not exist. Nothing
 * failed; it just wrote nonsense into a real appointment and read it back as
 * fact — which is invariant 1, in the engine that serves every customer today.
 *
 * So filler is now stripped word by word and what remains has to be substantive.
 * A phrase made entirely of filler falls back to the default, which is honest:
 * it says a service was not identified rather than inventing one.
 *
 * (The TIME is a separate matter and deliberately not read from the message —
 * the caller is offered the next free slot and told plainly which one, with an
 * invitation to change it. That is a design decision, not this bug.)
 */
function extractServiceName(text: string): string {
  const match = text.match(/\b(?:book|schedule|arrange|need|want)\s+(?:an?\s+)?([a-z][a-z\s-]{2,40}?)\s*(?:appointment|consultation|session|for|on|at|tomorrow|today|next|please|$)/i);
  const candidate = match?.[1]?.trim();

  if (candidate) {
    // Filter on the lowercased word but keep the customer's own casing: a
    // business that calls it "MRI Scan" should see "MRI Scan" in the calendar.
    const words = candidate
      .split(/\s+/)
      .filter((w) => w && !SERVICE_NAME_FILLER.has(w.toLowerCase()));
    const cleaned = words.join(' ');
    const saysNothing = words.length === 1 && GENERIC_BOOKING_WORDS.has(words[0].toLowerCase());
    if (cleaned.length >= 3 && !saysNothing) {
      return cleaned.replace(/^./, (c) => c.toUpperCase());
    }
  }

  return 'General Consultation';
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
   * Generate an embedding vector on the configured provider, then query Qdrant.
   */
  private async vectorSearch(collectionName: string, query: string, topK: number): Promise<QdrantSearchResult[]> {
    // Step 1: Generate embedding
    const embeddingResponse = await fetch(embeddingsUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openAiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL(),
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
   * Embeds and upserts document chunks into the organization's Qdrant collection,
   * creating the collection if it does not exist.
   *
   * Both inline ingestion paths in KnowledgeService (the Redis-unavailable fallback
   * and website crawling) wrote chunk rows to PostgreSQL and marked the document
   * INDEXED without ever producing a vector, so `searchKnowledgeBase` could not
   * retrieve any of it semantically.
   */
  async upsertChunks(
    organizationId: string,
    chunks: Array<{ chunkId: string; documentId: string; chunkIndex: number; content: string }>
  ): Promise<void> {
    if (chunks.length === 0) return;
    if (!this.openAiKey) {
      throw new Error('OPENAI_API_KEY is not set — embeddings cannot be generated.');
    }

    const collectionName = `org_${organizationId}`;
    await this.ensureCollection(collectionName);

    // Embed in batches: the OpenAI embeddings endpoint accepts an array of inputs,
    // so one request per chunk would be needlessly slow and rate-limit-prone.
    const BATCH = 64;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const batch = chunks.slice(i, i + BATCH);
      const vectors = await this.embedBatch(batch.map((c) => c.content.slice(0, 8000)));

      const points = batch.map((c, idx) => ({
        id: c.chunkId,
        vector: vectors[idx],
        payload: {
          chunkId: c.chunkId,
          documentId: c.documentId,
          organizationId,
          chunkIndex: c.chunkIndex,
          content: c.content,
        },
      }));

      const res = await fetch(`${this.qdrantUrl}/collections/${collectionName}/points?wait=true`, {
        method: 'PUT',
        headers: this.qdrantHeaders(),
        body: JSON.stringify({ points }),
      });

      if (!res.ok) {
        throw new Error(`Qdrant upsert failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      }
    }
  }

  /**
   * Removes a document's vectors from Qdrant.
   *
   * KnowledgeService.deleteDocument deleted the file and the PostgreSQL rows but left
   * the vectors in place, with a comment claiming the worker would clean them up on
   * re-index — it does not. The stale vectors kept surfacing as RAG context, so the
   * assistant went on quoting documents the operator had deliberately deleted.
   */
  async deleteDocumentVectors(organizationId: string, documentId: string): Promise<void> {
    const res = await fetch(
      `${this.qdrantUrl}/collections/org_${organizationId}/points/delete?wait=true`,
      {
        method: 'POST',
        headers: this.qdrantHeaders(),
        body: JSON.stringify({
          filter: { must: [{ key: 'documentId', match: { value: documentId } }] },
        }),
      }
    );

    // 404 means the collection was never created — nothing to remove.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Qdrant delete failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
  }

  private qdrantHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['api-key'] = this.apiKey;
    return headers;
  }

  /** Creates the per-tenant collection if absent. Vector size matches the model. */
  private async ensureCollection(collectionName: string): Promise<void> {
    const check = await fetch(`${this.qdrantUrl}/collections/${collectionName}`, {
      headers: this.qdrantHeaders(),
    });
    if (check.ok) return;

    const create = await fetch(`${this.qdrantUrl}/collections/${collectionName}`, {
      method: 'PUT',
      headers: this.qdrantHeaders(),
      body: JSON.stringify({ vectors: { size: EMBEDDING_DIMENSIONS(), distance: 'Cosine' } }),
    });
    if (!create.ok) {
      throw new Error(
        `Failed to create Qdrant collection ${collectionName}: ${(await create.text()).slice(0, 300)}`
      );
    }
  }

  private async embedBatch(inputs: string[]): Promise<number[][]> {
    const res = await fetch(embeddingsUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.openAiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL(), input: inputs }),
    });

    if (!res.ok) {
      throw new Error(`Embeddings API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const data: any = await res.json();
    // Responses are not guaranteed to preserve input order; sort by index.
    return (data.data ?? [])
      .slice()
      .sort((a: any, b: any) => a.index - b.index)
      .map((d: any) => d.embedding);
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
      // First try exact phrase match
      let docChunks = await prisma.documentChunk.findMany({
        where: {
          organizationId,
          content: { contains: query, mode: 'insensitive' },
        },
        take: topK,
        orderBy: { chunkIndex: 'asc' },
      });

      // Fallback: if no exact phrase match, search for meaningful keywords (≥4 chars)
      // using OR — any chunk containing at least one keyword is a candidate.
      if (docChunks.length === 0) {
        const stopWords = new Set(['what', 'does', 'how', 'much', 'the', 'for', 'and', 'that', 'this', 'with', 'have', 'will', 'are', 'can', 'from', 'your', 'which', 'about', 'into', 'than', 'more', 'also']);
        const keywords = query
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, '')
          .split(/\s+/)
          .filter((w) => w.length >= 4 && !stopWords.has(w));

        if (keywords.length > 0) {
          docChunks = await prisma.documentChunk.findMany({
            where: {
              organizationId,
              OR: keywords.map((kw) => ({ content: { contains: kw, mode: 'insensitive' } })),
            },
            take: topK,
            orderBy: { chunkIndex: 'asc' },
          });
        }
      }

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

  /**
   * Uniform failure path for every DB-backed tool intent. Any tool can throw
   * (database down, FK violation, missing contact); an uncaught throw bubbles
   * to the channel's catch-all and the customer receives NO reply at all.
   * Every tool branch routes failures here: log the real error, reply
   * honestly, hand off to a human.
   */
  /**
   * Confident match of the visitor's question against the org's curated FAQ
   * entries. Deliberately conservative: it answers ONLY when most of an FAQ
   * question's content words appear in the visitor's message — a weak match
   * falls through to RAG/LLM rather than risk answering the wrong question
   * with high confidence. Never throws; any failure just means "no match".
   */
  private async tryFaqMatch(
    organizationId: string,
    input: string
  ): Promise<{ answer: string; score: number } | null> {
    const STOPWORDS = new Set([
      'what', 'is', 'a', 'an', 'the', 'i', 'you', 'do', 'does', 'how', 'can',
      'where', 'who', 'to', 'for', 'of', 'in', 'on', 'my', 'your', 'it', 'and',
      'or', 'me', 'we', 'be', 'are', 'get', 'much', 'about', 'please',
    ]);
    // Crude singularisation, deliberately: without it "does it work for my
    // business" misses an FAQ titled "…work for businesses?" — a plural is not
    // a different question. Only trailing -es/-s on words long enough that the
    // suffix is unlikely to be part of the stem.
    const singular = (t: string) =>
      t.length > 4 && t.endsWith('es') ? t.slice(0, -2)
      : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1)
      : t;

    const tokenize = (text: string) =>
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t))
        .map(singular);

    try {
      const queryTokens = new Set(tokenize(input));
      if (queryTokens.size === 0) return null;

      const [faqs, org] = await Promise.all([
        prisma.faqEntry.findMany({
          where: { organizationId, isActive: true },
          select: { question: true, answer: true, sortOrder: true },
          orderBy: { sortOrder: 'asc' },
          take: 300,
        }),
        prisma.organization.findUnique({
          where: { id: organizationId },
          select: { name: true },
        }),
      ]);

      // The organization's own name is implicit context, not a keyword the
      // customer has to supply. Someone on GateKipa's website asking "how much
      // does it cost?" means GateKipa; requiring them to say the brand made an
      // FAQ titled "How much does GateKipa cost?" unreachable, and the
      // assistant handed off a question it had a curated answer for.
      const brandTokens = new Set(tokenize(org?.name ?? ''));

      let best: { answer: string; score: number; overlap: number } | null = null;
      for (const faq of faqs) {
        const allTokens = tokenize(faq.question);
        // Score against the question WITHOUT the brand, falling back to the
        // full set when an FAQ is nothing but the brand name.
        const stripped = allTokens.filter((t) => !brandTokens.has(t));
        const questionTokens = stripped.length > 0 ? stripped : allTokens;
        if (questionTokens.length === 0) continue;
        const overlap = questionTokens.filter((t) => queryTokens.has(t)).length;
        const score = overlap / questionTokens.length;
        if (score < 0.6) continue;
        // A single-content-word question ("What is GateKipa?" → {gatekipa})
        // would otherwise win against EVERY message that mentions the brand.
        // It only answers when the visitor's message adds nothing beyond that
        // same word set — "who built gatekipa" must fall through, not get the
        // what-is answer.
        if (
          questionTokens.length === 1 &&
          ![...queryTokens].every((t) => questionTokens.includes(t))
        ) {
          continue;
        }
        // More shared content words beats a higher coverage ratio: the pricing
        // question (2-word overlap) must outrank the brand question (1-word).
        if (!best || overlap > best.overlap || (overlap === best.overlap && score > best.score)) {
          best = { answer: faq.answer, score, overlap };
        }
      }
      return best ? { answer: best.answer, score: best.score } : null;
    } catch {
      // FAQ lookup is an optimization, never a failure mode — fall through to RAG.
      return null;
    }
  }

  private toolFailureReply(intent: string, err: any, lang: Language = 'en'): OrchestrationResult {
    console.error(JSON.stringify({
      level: 'error',
      service: 'ConversationOrchestrator',
      event: 'tool_execution_failed',
      intent,
      error: err?.message ?? String(err),
    }));
    return {
      replyText: t(lang, 'tool_failure'),
      intentDetected: intent,
      confidenceScore: 0.9,
      shouldHandoff: true,
      handoffReason: HandoffReason.TOOL_FAILURE,
    };
  }

  async processIncomingMessage(
    context: ConversationContext,
    userMessageText: string
  ): Promise<OrchestrationResult> {
    const cleanInput = (userMessageText ?? '').trim();
    if (!cleanInput) {
      return {
        replyText: 'I received your message but it appears empty. Could you please try again?',
        intentDetected: 'EMPTY_MESSAGE',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    const lowerInput = cleanInput.toLowerCase();

    // ── 0b. The customer's language ──────────────────────────────────────────
    //
    // Detected conservatively from this message (null means "no signal", never
    // "English"), remembered on the contact so the NEXT conversation opens in
    // it, and resolved contact → organization default → English. The
    // consequential replies below are rendered in it; free-form answers mirror
    // it through the LLM tier's instruction.
    const lang = await this.resolveReplyLanguage(context, cleanInput);

    // ── 1. Active human handoff check ────────────────────────────────────────
    if (context.isHumanHandoffActive) {
      return {
        // Nothing is said: a person is handling this thread and the AI talking
        // over them is the point of handing off in the first place.
        replyText: '',
        // Labelled, so "messages that arrived while a customer waited for a
        // human" is answerable. Unlabelled it was logged as GENERAL_INQUIRY,
        // which it is not.
        intentDetected: 'HUMAN_HANDOFF_ACTIVE',
        confidenceScore: 1.0,
        shouldHandoff: true,
        // NO handoffReason, deliberately. This branch does not know why the
        // conversation was escalated — it only knows that it was. It used to
        // assert CUSTOMER_REQUEST, and WhatsappService writes the reason back on
        // every message, so a conversation escalated because a booking tool
        // failed was relabelled "the customer asked" the moment they typed
        // again. That is the one field telling staff why a thread needs a
        // person. Omitting it leaves the original intact: Prisma treats an
        // undefined field as "not provided" rather than as null.
      };
    }

    // ── 2. Explicit escalation request ───────────────────────────────────────
    // ── 2a. "Are you a bot?" ────────────────────────────────────────────────
    //
    // Checked BEFORE escalation. 'real person' is an escalation trigger, so
    // "is this a real person?" — a question about the assistant — used to be read as
    // "put me through to a real person" and silently handed the customer to a queue
    // instead of answering them.
    if (isAiDisclosureQuestion(lowerInput)) {
      const discloseOrgName = await this.getOrganizationName(context.organizationId);
      return {
        // Translated: the disclosure is a regulatory requirement, and it only
        // counts if the customer can read it.
        replyText: t(lang, 'ai_disclosure', { org: discloseOrgName }),
        intentDetected: 'AI_DISCLOSURE',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    // ── 2a-bis. Choosing a language ─────────────────────────────────────────
    //
    // Detection alone switches SILENTLY, which is right for someone who simply
    // writes in Hausa mid-conversation — confirming would interrupt what they
    // came for. But a customer who ASKS ("hausa please", "change language") is
    // making a request, and a request that produces no acknowledgement reads as
    // having been ignored. This branch is the difference: it confirms, in the
    // language chosen, and remembers it.
    //
    // Sits above the tool branches because a language request must never be
    // consumed by one, and above escalation because "do you speak Hausa?" is a
    // question about the assistant, not a demand for a human.
    const lastAssistantLine = (context.history ?? [])
      .filter((m) => m.sender !== 'CUSTOMER')
      .slice(-1)[0]?.content ?? '';
    const menuJustShown = lastAssistantLine.includes(LANGUAGE_MENU_MARKER);

    // A bare "3" only means a language directly after we offered the menu;
    // anywhere else it is an answer to something entirely different.
    const chosenLanguage =
      explicitLanguageRequest(cleanInput) ??
      (menuJustShown ? parseLanguageChoice(cleanInput) : null);

    if (chosenLanguage) {
      // On a call, three of the five cannot be spoken at all. Confirming a
      // switch we cannot perform would be a promise the next sentence breaks,
      // so say what is true and offer the two routes that actually exist.
      if (context.channel === ChannelType.VOICE && !SPEAKABLE_LANGUAGES.includes(chosenLanguage)) {
        return {
          replyText: t('en', 'language_voice_unavailable', {
            language: LANGUAGE_NAMES[chosenLanguage],
          }),
          intentDetected: 'SET_LANGUAGE_UNAVAILABLE',
          confidenceScore: 1.0,
          shouldHandoff: false,
        };
      }

      await this.persistPreferredLanguage(context, chosenLanguage);
      return {
        replyText: t(chosenLanguage, 'language_set'),
        intentDetected: 'SET_LANGUAGE',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    if (wantsLanguageMenu(cleanInput)) {
      return {
        // Offered in whatever language we are already using, so the menu is
        // readable by the person who asked for it.
        replyText: t(lang, 'language_menu'),
        intentDetected: 'LANGUAGE_MENU',
        confidenceScore: 1.0,
        shouldHandoff: false,
      };
    }

    // ── 2b. Explicit escalation request ─────────────────────────────────────
    const ESCALATION_PHRASES = [
      'speak to human', 'speak to a human', 'human agent', 'representative',
      'customer care agent', 'talk to a person', 'talk to a human', 'agent please',
      'i need a person', 'i want a human', 'speak to a real person',
      'talk to a real person', 'get me a human',
    ];
    if (ESCALATION_PHRASES.some((p) => lowerInput.includes(p))) {
      return {
        replyText: t(lang, 'escalation_connecting'),
        // A customer asking for a person is the single most useful signal a
        // business has about where the agent is failing them. Unlabelled, every
        // one of these was recorded as GENERAL_INQUIRY and the question "how
        // often do customers give up on the AI?" had no answer in the data.
        intentDetected: 'HUMAN_HANDOFF',
        confidenceScore: 1.0,
        shouldHandoff: true,
        handoffReason: HandoffReason.CUSTOMER_REQUEST,
      };
    }

    // ── 3. Tool: Appointment Booking ─────────────────────────────────────────
    //
    // Note on scope: this books the next FREE slot in the organization's working
    // hours and says exactly which slot it took, so the customer can correct it.
    // It used to unconditionally write "tomorrow at 10:00" for a "General
    // Consultation" and reply "✅ Your appointment has been confirmed" — regardless
    // of what the customer asked for, whether the business is open then, or whether
    // that slot was already taken. Customers were told a time nobody was expecting
    // them, and staff got silently double-booked.
    // The bare word "appointment" is in here, so this branch matches almost any
    // sentence about one. It sits ABOVE check, cancel and reschedule, so before
    // the guard "cancel my appointment" created a second appointment and
    // cancelled nothing — the customer was told "I've put you down for...".
    const APPOINTMENT_PHRASES = ['appointment', 'schedule consultation', 'book a doctor', 'reserve slot', 'book an appointment', 'book appointment'];
    if (APPOINTMENT_PHRASES.some((p) => lowerInput.includes(p)) && !isAboutExistingBooking(lowerInput)) {
      try {
        const toolResult = await this.executeBookAppointment(context, cleanInput, lang);
        return {
          replyText: toolResult.message,
          intentDetected: 'BOOK_APPOINTMENT',
          confidenceScore: 0.9,
          shouldHandoff: toolResult.shouldHandoff,
          ...(toolResult.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
          toolCallsExecuted: [{ toolName: 'book_appointment', result: toolResult }],
        };
      } catch (err) {
        return this.toolFailureReply('BOOK_APPOINTMENT', err, lang);
      }
    }

    // ── 4. Tool: Reservation ─────────────────────────────────────────────────
    // Same shape, same guard: "cancel my reservation" contains "reservation".
    const RESERVATION_PHRASES = ['reservation', 'book room', 'book table', 'book a room', 'book a table', 'reserve a table', 'make a reservation'];
    if (RESERVATION_PHRASES.some((p) => lowerInput.includes(p)) && !isAboutExistingBooking(lowerInput)) {
      try {
        const toolResult = await this.executeManageReservation(context, cleanInput);
        return {
          replyText: toolResult.message,
          intentDetected: 'MANAGE_RESERVATION',
          confidenceScore: 0.9,
          shouldHandoff: toolResult.shouldHandoff,
          ...(toolResult.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
          toolCallsExecuted: [{ toolName: 'manage_reservation', result: toolResult }],
        };
      } catch (err) {
        return this.toolFailureReply('MANAGE_RESERVATION', err, lang);
      }
    }

    // ── 5. Tool: Check Booking / Reservation Status ──────────────────────────
    if (wantsStatusOnly(lowerInput)) {
      try {
        const result = await this.executeCheckBookingStatus(context, lang);
        return {
          replyText: result.message,
          intentDetected: 'CHECK_BOOKING_STATUS',
          confidenceScore: 0.95,
          shouldHandoff: false,
          toolCallsExecuted: [{ toolName: 'check_booking_status', result }],
        };
      } catch (err) {
        return this.toolFailureReply('CHECK_BOOKING_STATUS', err, lang);
      }
    }

    // ── 6. Tool: Cancel Booking / Reservation ─────────────────────────────────
    if (CANCEL_BOOKING_PHRASES.some((p) => lowerInput.includes(p))) {
      try {
        const result = await this.executeCancelBookingOrReservation(context, lang);
        return {
          replyText: result.message,
          intentDetected: 'CANCEL_BOOKING',
          confidenceScore: 0.97,
          shouldHandoff: false,
          toolCallsExecuted: [{ toolName: 'cancel_booking', result }],
        };
      } catch (err) {
        return this.toolFailureReply('CANCEL_BOOKING', err, lang);
      }
    }

    // ── 7. Tool: Reschedule Booking / Reservation ─────────────────────────────
    if (RESCHEDULE_PHRASES.some((p) => lowerInput.includes(p))) {
      try {
        const result = await this.executeRescheduleBookingOrReservation(context, lang);
        return {
          replyText: result.message,
          intentDetected: 'RESCHEDULE_BOOKING',
          confidenceScore: 0.96,
          shouldHandoff: false,
          toolCallsExecuted: [{ toolName: 'reschedule_booking', result }],
        };
      } catch (err) {
        return this.toolFailureReply('RESCHEDULE_BOOKING', err, lang);
      }
    }

    // ── 8. Tool: Request Refund ───────────────────────────────────────────────
    const REFUND_PHRASES = [
      'refund', 'money back', 'want my money back', 'give me my money',
      'request refund', 'i need a refund', 'charge back', 'chargeback',
      'return my money', 'reimburse', 'reimbursement',
    ];
    if (REFUND_PHRASES.some((p) => lowerInput.includes(p))) {
      try {
        const result = await this.executeRequestRefund(context, cleanInput);
        return {
          replyText: result.message,
          intentDetected: 'REQUEST_REFUND',
          confidenceScore: 0.97,
          shouldHandoff: false,
          toolCallsExecuted: [{ toolName: 'request_refund', result }],
        };
      } catch (err) {
        return this.toolFailureReply('REQUEST_REFUND', err, lang);
      }
    }

    const QUOTATION_PHRASES = ['quotation', 'price quote', 'how much for', 'billing breakdown', 'get a quote', 'cost of', 'pricing'];
    if (QUOTATION_PHRASES.some((p) => lowerInput.includes(p))) {
      try {
        const quoteResult = await this.executeGenerateQuotation(context, cleanInput);
        return {
          replyText: quoteResult.summaryText,
          intentDetected: 'REQUEST_QUOTATION',
          confidenceScore: 0.9,
          shouldHandoff: quoteResult.shouldHandoff,
          ...(quoteResult.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
          toolCallsExecuted: [{ toolName: 'request_quotation', result: quoteResult }],
        };
      } catch (err) {
        return this.toolFailureReply('REQUEST_QUOTATION', err, lang);
      }
    }

    // ── 10. Tool: Support Ticket ───────────────────────────────────────────────
    const TICKET_PHRASES = ['file a complaint', 'open ticket', 'issue with service', 'report problem', 'complaint', 'not working', 'broken'];
    if (TICKET_PHRASES.some((p) => lowerInput.includes(p))) {
      try {
        const ticketResult = await this.executeCreateTicket(context, cleanInput);
        return {
          replyText: `I've opened support ticket *#${ticketResult.ticketNumber}* for your inquiry. Our team has been notified and will follow up with you shortly.`,
          intentDetected: 'CREATE_TICKET',
          confidenceScore: 0.95,
          shouldHandoff: false,
          toolCallsExecuted: [{ toolName: 'create_support_ticket', result: ticketResult }],
        };
      } catch (err) {
        return this.toolFailureReply('CREATE_TICKET', err, lang);
      }
    }

    // ── 11. Tool: AI Service Payment Guidance & Account Details ────────────────
    const PAYMENT_GUIDANCE_PHRASES = [
      'how to pay', 'how do i pay', 'account number', 'bank details', 'payment options',
      'payment link', 'pay for booking', 'ussd code', 'i want to pay', 'payment method',
      'transfer details', 'pay now', 'make payment', 'send payment details', 'how much to pay'
    ];
    if (PAYMENT_GUIDANCE_PHRASES.some((p) => lowerInput.includes(p))) {
      try {
        const guidanceResult = await this.executeProvidePaymentGuidance(context, lang);
        return {
          replyText: guidanceResult.replyText,
          intentDetected: 'PROVIDE_PAYMENT_GUIDANCE',
          confidenceScore: 0.98,
          shouldHandoff: guidanceResult.shouldHandoff,
          ...(guidanceResult.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
          toolCallsExecuted: [{ toolName: 'provide_payment_guidance', result: guidanceResult }],
        };
      } catch (err) {
        return this.toolFailureReply('PROVIDE_PAYMENT_GUIDANCE', err, lang);
      }
    }

    // ── 12. Tool: Onboarding selfie ────────────────────────────────────────────
    //
    // Two situations, one tool:
    //   - the customer is ready to send their photo and needs a link;
    //   - the customer is on a voice call, where no photo can be sent at all, and the
    //     only honest answer is "I have texted you a link".
    //
    // Note what this deliberately does NOT do: claim the photo verifies anyone. It is
    // captured and passed to a human; nothing here checks liveness or identity.
    const SELFIE_PHRASES = [
      'selfie', 'send my photo', 'send you my photo', 'upload my photo', 'upload a photo',
      'take a picture of myself', 'photo of myself', 'picture of myself', 'where do i send my picture',
      'how do i send my photo', 'verify my identity', 'identity photo', 'id photo',
    ];
    if (SELFIE_PHRASES.some((p) => lowerInput.includes(p))) {
      try {
        const selfieResult = await this.executeRequestSelfie(context);
        return {
          replyText: selfieResult.replyText,
          intentDetected: 'REQUEST_SELFIE',
          confidenceScore: 0.9,
          shouldHandoff: selfieResult.shouldHandoff,
          ...(selfieResult.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
          toolCallsExecuted: [{ toolName: 'request_onboarding_selfie', result: selfieResult }],
        };
      } catch (err) {
        return this.toolFailureReply('REQUEST_SELFIE', err, lang);
      }
    }

    // ── 12.5 "What can you do?" ──────────────────────────────────────────────
    // Placed AFTER every tool branch on purpose: "what can you do about my
    // broken product" must reach the ticket tool, not a menu. Only a message
    // that matched nothing else and asks about the assistant itself lands here.
    const CAPABILITY_PHRASES = [
      'what can you do', 'what do you do', 'what can you help', 'how can you help',
      'what are you able to do', 'what services do you offer', 'what do you offer',
      'what else can you do', 'show me the menu', 'list of services',
    ];
    if (CAPABILITY_PHRASES.some((p) => lowerInput.includes(p))) {
      const capOrgName = await this.getOrganizationName(context.organizationId);
      return {
        replyText: t(lang, 'capabilities', { org: capOrgName }),
        intentDetected: 'CAPABILITIES',
        confidenceScore: 0.95,
        shouldHandoff: false,
      };
    }

    // ── 10.5 FAQ direct match ────────────────────────────────────────────────
    // The dashboard's curated FAQ entries were previously dead knowledge: the
    // RAG path only searches document chunks, so nothing the operator typed
    // into the FAQ manager ever reached a customer. A confident keyword-overlap
    // match on a curated Q→A pair beats LLM synthesis anyway — it is the
    // operator's own wording, deterministic, free, and works with no OpenAI
    // key configured (the exact state of a fresh demo tenant).
    const faqMatch = await this.tryFaqMatch(context.organizationId, cleanInput);
    if (faqMatch) {
      return {
        replyText: faqMatch.answer,
        intentDetected: 'FAQ_MATCH',
        confidenceScore: faqMatch.score,
        shouldHandoff: false,
      };
    }

    // ── 12.6 LLM intent routing — the second chance the keywords never had ───
    //
    // Everything above matches English keywords. A customer writing "ina so in
    // yi rijista" (Hausa: I want to register) or "I'd like to see the doctor on
    // Friday" matched nothing and fell through to RAG synthesis — which can
    // only TALK about booking, never actually book. This pass asks the LLM one
    // narrow question — which of the EXISTING intents is this, if any? — and
    // dispatches to the SAME deterministic executors the keyword branches use.
    //
    // The classifier's authority stops at naming an intent. It never writes a
    // reply, never supplies a phone number, and its output is whitelist-checked;
    // state-changing intents need higher confidence than read-only ones. On any
    // failure — no key, timeout, junk JSON, low confidence — the message falls
    // through to the RAG path exactly as before, so the feature degrades to
    // the status quo, never below it.
    const classified = await this.classifyIntentWithLlm(cleanInput);
    if (classified) {
      const routed = await this.dispatchClassifiedIntent(classified, context, cleanInput, lang);
      if (routed) return routed;
    }

    // ── 11. RAG Knowledge Search ──────────────────────────────────────────────
    const searchResults = await this.ragService.searchKnowledgeBase(
      context.organizationId,
      cleanInput,
      RAG_TOP_K
    );

    // Keep reasonably-confident results. The threshold is `>=` because the Postgres
    // ILIKE fallback assigns descending scores 0.6 / 0.55 / 0.5 — a strict `>` threw
    // away its third hit every time, for no reason.
    const kbContextText = searchResults
      .filter((r) => r.score >= 0.5)
      .map((r) => r.content)
      .join('\n---\n');

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
        const basePrompt = org?.aiPersonaPrompt
          ? org.aiPersonaPrompt
          : `You are a professional customer support assistant for ${orgName}. ` +
            `Be helpful, concise, and friendly. Respond in plain text without markdown unless formatting helps clarity. ` +
            `If you cannot answer something, offer to connect the customer with a human agent.`;

        // Guardrails appended after the tenant's own persona prompt so a
        // well-meaning (or careless) persona cannot instruct the model to claim it is
        // human, or to invent prices, availability or bank details — the exact
        // failure modes this file used to hardcode.
        const systemPrompt =
          `${basePrompt}\n\n` +
          `Non-negotiable rules:\n` +
          `- If asked whether you are an AI, a bot, or a human, say plainly that you are an AI assistant. Never claim to be a person.\n` +
          `- Never invent prices, availability, bank account numbers, USSD codes or payment links. If you do not have a fact, say so and offer a human colleague.\n` +
          `- Only state something as confirmed when the information above shows it was actually done.\n` +
          `- Reply in the language the customer is writing in. You support English, Nigerian Pidgin, Hausa, Igbo and Yoruba; if the customer mixes languages, follow their most recent message.` +
          (lang !== 'en' ? ` This customer has been speaking ${LANGUAGE_NAMES[lang]}.` : '');

        const userContent = kbContextText
          ? `The following information from our knowledge base may be relevant:\n\n${kbContextText}\n\n---\n\nCustomer message: ${cleanInput}`
          : cleanInput;

        // Feed prior turns to the model.
        //
        // ConversationContext.history was populated by every caller
        // (WhatsappService, WidgetService, TwilioMediaStreamHandler) but never read
        // here: only the current message was sent. The assistant therefore had no
        // memory at all — a customer who answered a question it had just asked got a
        // reply that ignored the entire exchange. The final entry is skipped when it
        // is the message we are already sending as `userContent`.
        const priorTurns = (context.history ?? [])
          .filter((m) => m.content?.trim())
          .slice(-MAX_HISTORY_TURNS)
          .filter((m, i, arr) => !(i === arr.length - 1 && m.content.trim() === cleanInput))
          .map((m) => ({
            role: m.sender === 'CUSTOMER' ? ('user' as const) : ('assistant' as const),
            content: m.content,
          }));

        const gptResponse = await fetch(chatCompletionsUrl(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${openAiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: llmConfig().chatModel,
            max_tokens: 400,
            temperature: 0.6,
            messages: [
              { role: 'system', content: systemPrompt },
              ...priorTurns,
              { role: 'user', content: userContent },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
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

    // ── Degraded mode ────────────────────────────────────────────────────────
    //
    // We reach here when the LLM was unavailable (missing key, quota exhausted,
    // network failure) or returned nothing.
    //
    // If the knowledge base answered the question we can still serve the customer.
    // If it did not, the honest outcome is a HANDOFF, not a dead end: the previous
    // behaviour returned "a member of our team will follow up with you shortly" with
    // shouldHandoff:false, so the conversation stayed assigned to an AI that was not
    // working, no agent was ever notified, and nobody followed up. A model outage
    // would have silently swallowed every inbound customer message.
    if (kbContextText) {
      return {
        replyText: `${kbContextText}\n\nIs there anything else I can help you with?`,
        intentDetected: 'KB_ANSWER_DEGRADED',
        confidenceScore: 0.6,
        shouldHandoff: false,
      };
    }

    return {
      replyText:
        `Thanks for getting in touch with ${orgName}. I'm not able to answer that one myself, ` +
        `so I'm passing you to a colleague who can help.`,
      intentDetected: 'AI_UNAVAILABLE',
      confidenceScore: 0,
      shouldHandoff: true,
      handoffReason: HandoffReason.TOOL_FAILURE,
    };
  }

  // ─── Booking Management Tool Implementations ────────────────────────────────

  /**
   * Check the customer's most recent active booking or reservation.
   */
  private async executeCheckBookingStatus(context: ConversationContext, lang: Language = 'en') {
    const phone = context.customerPhoneNumber;
    if (!phone) {
      return { message: 'I was unable to locate your booking — please provide your phone number.' };
    }

    // Check bookings first, then reservations
    const booking = await prisma.booking.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: { in: phoneNumberVariants(phone) } },  // every stored shape — see NEXT_UPCOMING
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        startTime: { gte: new Date() },
      },
      include: { contact: true },
      orderBy: { startTime: 'asc' },  // NEXT_UPCOMING
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
        contact: { phoneNumber: { in: phoneNumberVariants(phone) } },  // every stored shape — see NEXT_UPCOMING
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        reservationTime: { gte: new Date() },
      },
      include: { contact: true },
      orderBy: { reservationTime: 'asc' },  // NEXT_UPCOMING
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
        lang === 'en'
          ? `I couldn't find an active booking or reservation linked to your number. ` +
            `If you believe this is an error, please say *"speak to an agent"* and a team member will assist you.`
          : t(lang, 'no_upcoming_booking'),
    };
  }

  /**
   * Cancel the customer's most recent active booking or reservation.
   */
  private async executeCancelBookingOrReservation(context: ConversationContext, lang: Language = 'en') {
    const phone = context.customerPhoneNumber;
    if (!phone) {
      return { message: 'I need your phone number on file to cancel a booking. Please contact our team directly.' };
    }

    // Try booking first
    const booking = await prisma.booking.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: { in: phoneNumberVariants(phone) } },  // every stored shape — see NEXT_UPCOMING
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        startTime: { gte: new Date() },
      },
      include: { contact: true },
      orderBy: { startTime: 'asc' },  // NEXT_UPCOMING
    });

    if (booking) {
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CANCELLED', notes: 'Cancelled by customer via AI assistant', updatedAt: new Date() },
      });
      return {
        bookingId: booking.id,
        message: t(lang, 'booking_cancelled', {
          service: booking.serviceName,
          ref: booking.id.slice(-8).toUpperCase(),
        }),
      };
    }

    // Try reservation
    const reservation = await prisma.reservation.findFirst({
      where: {
        organizationId: context.organizationId,
        contact: { phoneNumber: { in: phoneNumberVariants(phone) } },  // every stored shape — see NEXT_UPCOMING
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        reservationTime: { gte: new Date() },
      },
      include: { contact: true },
      orderBy: { reservationTime: 'asc' },  // NEXT_UPCOMING
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
        lang === 'en'
          ? `I couldn't find an active booking or reservation to cancel under your number. ` +
            `If you need help, say *"speak to an agent"* and someone will assist you.`
          : t(lang, 'no_upcoming_booking'),
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
  private async executeRescheduleBookingOrReservation(context: ConversationContext, lang: Language = 'en') {
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
        contact: { phoneNumber: { in: phoneNumberVariants(phone) } },  // every stored shape — see NEXT_UPCOMING
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        startTime: { gte: new Date() },
      },
      include: { contact: true },
      orderBy: { startTime: 'asc' },  // NEXT_UPCOMING
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
        contact: { phoneNumber: { in: phoneNumberVariants(phone) } },  // every stored shape — see NEXT_UPCOMING
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        reservationTime: { gte: new Date() },
      },
      include: { contact: true },
      orderBy: { reservationTime: 'asc' },  // NEXT_UPCOMING
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
        lang === 'en'
          ? `I couldn't find an active booking or reservation to reschedule under your number. ` +
            `Please say *"speak to an agent"* for help.`
          : t(lang, 'no_upcoming_booking'),
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
      where: {
        organizationId: context.organizationId,
        phoneNumber: { in: phoneNumberVariants(phone) },
      },
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

    // Same generator, same reason — and the prefix is kept because staff use it
    // to tell a refund request from a support ticket at a glance.
    const refundPrefix = `REF-${booking ? 'BK' : 'RS'}`;
    const subject = booking
      ? `Refund Request — ${booking.serviceName} on ${booking.startTime.toLocaleDateString('en-NG')}`
      : `Refund Request — Reservation (${contact.fullName})`;

    const description =
      `Customer requested a refund via AI assistant.\n\n` +
      `Contact: ${contact.fullName} (${phone})\n` +
      (booking ? `Booking: ${booking.serviceName} — ${booking.startTime.toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}\n` : '') +
      `\nCustomer message: "${messageText.slice(0, 300)}"`;

    const ticket = await createTicketWithUniqueNumber(
      (ticketNumber) =>
        prisma.ticket.create({
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
        }),
      refundPrefix
    );
    const ticketNumber = ticket.ticketNumber;

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
   * Books the next genuinely free slot inside the organization's working hours.
   *
   * Conflicts are checked against existing bookings before writing. Two concurrent
   * requests can still race between the check and the insert; at Nigerian SME volume
   * (< 500 bookings/day) that window is negligible, and closing it properly needs a
   * serializable transaction or a database exclusion constraint on the time range.
   */
  private async executeBookAppointment(
    context: ConversationContext,
    messageText: string,
    lang: Language = 'en',
    // From the LLM intent classifier: the requested service in English, when
    // the message itself is in a language the regex extractor cannot read.
    serviceNameHint?: string
  ) {
    let contact;
    try {
      contact = await this.getOrCreateContact(context);
    } catch {
      return {
        booked: false,
        shouldHandoff: true,
        message:
          `I'd be glad to book that for you — I just need a phone number to put the ` +
          `appointment under. Let me bring in a colleague who can take your details.`,
      };
    }

    const slot = await this.findNextAvailableSlot(
      context.organizationId,
      DEFAULT_APPOINTMENT_DURATION_MINUTES
    );

    if (!slot) {
      return {
        booked: false,
        shouldHandoff: true,
        message:
          `We're fully booked for the next couple of weeks, so I don't want to guess at a ` +
          `time. I'm passing you to a colleague who can find something that works for you.`,
      };
    }

    const serviceName = serviceNameHint?.trim() || extractServiceName(messageText);

    const booking = await prisma.booking.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        serviceName,
        startTime: slot.start,
        endTime: slot.end,
        status: 'CONFIRMED',
        notes: `Booked by AI assistant from: "${messageText.slice(0, 200)}"`,
      },
    });

    const when = formatLagos(slot.start);

    return {
      booked: true,
      shouldHandoff: false,
      bookingId: booking.id,
      serviceName,
      startTime: slot.start.toISOString(),
      // Say what was actually booked and invite a correction, rather than asserting
      // that a time the customer never chose is "confirmed".
      message: t(lang, 'booking_confirmed', {
        service: serviceName,
        when,
        ref: booking.id.slice(-8).toUpperCase(),
      }),
    };
  }

  private async executeManageReservation(context: ConversationContext, messageText: string) {
    let contact;
    try {
      contact = await this.getOrCreateContact(context);
    } catch {
      return {
        booked: false,
        shouldHandoff: true,
        message:
          `Happy to arrange that — I just need a phone number for the reservation. ` +
          `Let me bring in a colleague who can take your details.`,
      };
    }

    // Read the party size out of the message rather than always assuming two people.
    const partySize = extractPartySize(messageText) ?? 2;

    const slot = await this.findNextAvailableSlot(context.organizationId, 90);
    if (!slot) {
      return {
        booked: false,
        shouldHandoff: true,
        message:
          `We're fully booked over the next couple of weeks. I'm passing you to a colleague ` +
          `who can look for a table for you.`,
      };
    }

    const reservation = await prisma.reservation.create({
      data: {
        organizationId: context.organizationId,
        contactId: contact.id,
        partySize,
        reservationTime: slot.start,
        status: 'CONFIRMED',
        specialRequests: `Requested via AI assistant: "${messageText.slice(0, 200)}"`,
      },
    });

    return {
      booked: true,
      shouldHandoff: false,
      reservationId: reservation.id,
      partySize,
      message:
        `I've reserved a table for *${partySize} guest${partySize === 1 ? '' : 's'}* on ` +
        `*${formatLagos(slot.start)}* (West Africa Time).\n\n` +
        `Reference: #${reservation.id.slice(-8).toUpperCase()}\n\n` +
        `Say *"reschedule"* if you'd prefer a different time, or tell me your party size if I got it wrong.`,
    };
  }

  /**
   * Finds the earliest free slot within the organization's operating hours
   * (Mon–Fri, 08:00–18:00 West Africa Time), skipping anything already booked.
   */
  private async findNextAvailableSlot(
    organizationId: string,
    durationMinutes: number
  ): Promise<{ start: Date; end: Date } | null> {
    const SEARCH_HORIZON_DAYS = 14;
    const now = Date.now();
    const horizon = new Date(now + SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000);

    const existing = await prisma.booking.findMany({
      where: {
        organizationId,
        status: { in: ['CONFIRMED', 'RESCHEDULED'] },
        startTime: { gte: new Date(now), lte: horizon },
      },
      select: { startTime: true, endTime: true },
    });

    const busy = existing.map((b) => [b.startTime.getTime(), b.endTime.getTime()] as const);
    const durationMs = durationMinutes * 60 * 1000;

    // Start at the next half-hour boundary, at least an hour out.
    let cursor = new Date(now + 60 * 60 * 1000);
    cursor.setUTCSeconds(0, 0);
    cursor.setUTCMinutes(cursor.getUTCMinutes() > 30 ? 60 : 30);

    while (cursor.getTime() < horizon.getTime()) {
      const end = new Date(cursor.getTime() + durationMs);

      if (isWithinBusinessHours(cursor) && isWithinBusinessHours(new Date(end.getTime() - 1))) {
        const clashes = busy.some(([s, e]) => cursor.getTime() < e && end.getTime() > s);
        if (!clashes) return { start: new Date(cursor), end };
      }

      cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
    }

    return null;
  }

  /**
   * Quotes a price from the organization's own deal history.
   *
   * The previous implementation returned a flat "₦35,000 — General Consultation &
   * Diagnostics" for every business in every industry, labelled it an "Official Price
   * Quotation", and attached a link to `/api/documents/quotation/<n>.pdf`, a route
   * that has never existed — so the customer got a 404 for their "official" quote.
   * We do not invent prices: unless the organization has closed comparable deals we
   * hand the request to a human.
   */
  private async executeGenerateQuotation(context: ConversationContext, promptText: string) {
    const recentDeals = await prisma.deal.findMany({
      where: { organizationId: context.organizationId, stage: 'CLOSED_WON' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { title: true, amount: true, currency: true },
    });

    if (recentDeals.length === 0) {
      return {
        quoted: false,
        shouldHandoff: true,
        summaryText:
          `I'd rather get you an accurate price than guess at one. Let me pass you to a ` +
          `colleague who can put a proper quote together for you.`,
      };
    }

    const amounts = recentDeals.map((d) => d.amount).filter((a) => a > 0).sort((a, b) => a - b);
    const low = amounts[0] ?? 0;
    const high = amounts[amounts.length - 1] ?? 0;
    const currency = recentDeals[0].currency === 'NGN' ? '₦' : recentDeals[0].currency + ' ';

    return {
      quoted: true,
      shouldHandoff: false,
      indicativeLow: low,
      indicativeHigh: high,
      summaryText:
        `Comparable work we've done recently has ranged from *${currency}${low.toLocaleString('en-NG')}* ` +
        `to *${currency}${high.toLocaleString('en-NG')}*, depending on scope.\n\n` +
        `That's indicative, not a formal quote — tell me a bit more about what you need and ` +
        `I'll have a colleague send you an exact figure.`,
    };
  }

  /**
   * Issues a one-time selfie upload link for the current contact.
   *
   * On WhatsApp the customer can simply reply with a photo, so the link is offered as
   * an alternative. On a voice call it is the only route — a phone call carries no
   * image — so the reply says the link has been sent rather than asking the caller to
   * do something the channel cannot do.
   */
  private async executeRequestSelfie(context: ConversationContext) {
    try {
      const contact = await this.getOrCreateContact(context);
      const onVoice = context.channel === ChannelType.VOICE;

      const request = await createSelfieRequest({
        organizationId: context.organizationId,
        contactId: contact.id,
        channel: onVoice ? 'VOICE' : 'WHATSAPP',
        purpose: 'account onboarding',
        conversationId: context.conversationId,
      });

      const url = selfieUploadUrl(request.token);

      if (!onVoice) {
        return {
          replyText:
            `Sure — you can reply here with a photo of yourself, or use this secure link:\n${url}\n\n` +
            'It works once and expires in a day. We will never ask you for your PIN or password.',
          selfieRequestId: request.id,
          delivered: true,
          shouldHandoff: false,
        };
      }

      // Voice. Reading a 43-character token aloud is useless, and it would put the
      // credential into the call recording. The link has to be delivered out of band —
      // and the reply may only say it was sent if it actually was.
      const sent = await this.sendSelfieLinkOverWhatsApp(context.organizationId, contact.phoneNumber, url);

      return sent
        ? {
            replyText:
              "No problem — I've sent a secure upload link to your WhatsApp. Open it and take the photo there; " +
              'it works once and expires in a day. Nobody will ever ask you for your PIN or password.',
            selfieRequestId: request.id,
            delivered: true,
            shouldHandoff: false,
          }
        : {
            replyText:
              "I've started that for you, but I couldn't get the upload link to your phone automatically. " +
              "I'm passing you to a colleague who will send it to you directly.",
            selfieRequestId: request.id,
            delivered: false,
            shouldHandoff: true,
          };
    } catch (err: any) {
      // A failure here means the customer is stuck mid-onboarding. Hand to a human
      // rather than telling them a link is on the way when it is not.
      return {
        replyText:
          "I wasn't able to set up the photo upload just now. I'm passing you to a colleague who can help you finish this.",
        error: err?.message ?? 'unknown error',
        shouldHandoff: true,
      };
    }
  }

  /**
   * Sends the upload link over WhatsApp. Returns whether it genuinely went out —
   * the caller's wording depends on the answer, so a silent failure here would turn
   * into a false statement to a customer.
   */
  private async sendSelfieLinkOverWhatsApp(organizationId: string, phoneNumber: string, url: string): Promise<boolean> {
    try {
      const config = withWhatsAppCredentials(
        await prisma.whatsAppConfig.findFirst({ where: { organizationId, isActive: true } })
      );
      if (!config?.phoneNumberId || !config?.accessToken) return false;

      const client = new WhatsAppCloudClient({
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.webhookVerifyToken ?? '',
      });
      await client.sendTextMessage(
        phoneNumber,
        `Here is your secure photo upload link:\n${url}\n\n` +
          'It works once and expires in a day. We will never ask you for your PIN or password.'
      );
      return true;
    } catch {
      return false;
    }
  }

  private async executeCreateTicket(context: ConversationContext, subjectText: string) {
    const contact = await this.getOrCreateContact(context);

    // The number was `TCK-<last 6 digits of Date.now()>`: a million values,
    // repeating every 16.7 minutes, unique across the WHOLE table and therefore
    // shared with every other tenant, with no retry. A collision raised P2002,
    // the tool reported a failure, and a customer who had just described a fault
    // was told "I ran into a technical problem" with nothing recorded.
    const ticket = await createTicketWithUniqueNumber((ticketNumber) =>
      prisma.ticket.create({
        data: {
          organizationId: context.organizationId,
          contactId: contact.id,
          ticketNumber,
          subject: subjectText.slice(0, 100),
          description: subjectText,
          status: 'OPEN',
          priority: 'MEDIUM',
        },
      })
    );

    return { ticketId: ticket.id, ticketNumber: ticket.ticketNumber };
  }

  /**
   * Tells the customer how to pay, using ONLY the organization's own configured
   * payment details.
   *
   * This method previously read out a hardcoded "Providus Bank / 9928374102" account
   * with the tenant's name spliced in, three invented USSD strings, and a checkout
   * link to `/api/billing/pay-service` — a route that does not exist. Every one of
   * those would have sent a paying customer's money somewhere the business does not
   * control, and the "our AI assistant will automatically confirm your payment"
   * promise had nothing behind it either. If the details are not configured we say
   * so and hand over to a human.
   */
  private async executeProvidePaymentGuidance(context: ConversationContext, lang: Language = 'en') {
    const org = await prisma.organization.findUnique({
      where: { id: context.organizationId },
      select: {
        name: true,
        payoutBankName: true,
        payoutAccountName: true,
        payoutAccountNumber: true,
        payoutUssdCode: true,
      },
    });

    const orgName = org?.name ?? 'our team';
    const reference = `PAY-${context.conversationId.slice(-6).toUpperCase()}`;

    const channels: string[] = [];

    if (org?.payoutBankName && org?.payoutAccountNumber) {
      channels.push(
        `*Bank transfer*\n` +
        `• Bank: *${org.payoutBankName}*\n` +
        `• Account Name: *${org.payoutAccountName ?? orgName}*\n` +
        `• Account Number: \`${org.payoutAccountNumber}\`\n` +
        `• Reference: \`${reference}\``
      );
    }

    if (org?.payoutUssdCode) {
      channels.push(`*USSD*: dial \`${org.payoutUssdCode}\``);
    }

    if (channels.length === 0) {
      return {
        reference,
        configured: false,
        shouldHandoff: true,
        // Invariant 3, in the customer's language: unset details defer to a
        // human — in every language, never an invented account.
        replyText: t(lang, 'payment_unconfigured', { org: orgName }),
      };
    }

    const numbered = channels.map((c, i) => `${i + 1}️⃣ ${c}`).join('\n\n');

    return {
      reference,
      configured: true,
      shouldHandoff: false,
      bankName: org?.payoutBankName ?? null,
      accountNumber: org?.payoutAccountNumber ?? null,
      // English keeps the rich multi-channel card. Other languages get the
      // translated single-sentence rendering — the FIGURES pass through
      // verbatim in both (invariant 3: only the configured payout fields, and
      // a bank account number is never something to paraphrase).
      replyText:
        lang === 'en'
          ? `💳 *How to pay ${orgName}*\n\n${numbered}\n\n` +
            `📌 Once you've paid, reply here with your receipt and a member of our team will confirm it.`
          : t(lang, 'payment_details', {
              account: org?.payoutAccountName ?? orgName,
              bank: org?.payoutBankName ?? '',
              number: org?.payoutAccountNumber ?? '',
            }) +
            (org?.payoutUssdCode
              ? t(lang, 'payment_details_ussd_suffix', { ussd: org.payoutUssdCode })
              : ''),
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
  /**
   * Which language to answer in: this message's own signal, else what we
   * remembered about this customer, else the organization's default, else
   * English. A fresh detection is persisted fire-and-forget — the reply must
   * not wait on a CRM write, and losing one learn is harmless (the customer
   * will say "sannu" again).
   */
  private async resolveReplyLanguage(
    context: ConversationContext,
    messageText: string
  ): Promise<Language> {
    const detected = detectLanguage(messageText);
    try {
      const phone = context.customerPhoneNumber;
      const contact = phone
        ? await prisma.contact.findFirst({
            where: {
              organizationId: context.organizationId,
              phoneNumber: { in: phoneNumberVariants(phone) },
            },
            select: { id: true, preferredLanguage: true },
          })
        : null;

      if (detected && contact && asLanguage(contact.preferredLanguage) !== detected) {
        prisma.contact
          .update({ where: { id: contact.id }, data: { preferredLanguage: detected } })
          .catch(() => {});
      }
      if (detected) return detected;

      const stored = asLanguage(contact?.preferredLanguage);
      if (stored) return stored;

      const org = await prisma.organization.findUnique({
        where: { id: context.organizationId },
        select: { defaultLanguage: true },
      });
      return asLanguage(org?.defaultLanguage) ?? 'en';
    } catch {
      return detected ?? 'en';
    }
  }

  /**
   * The intents the classifier may name, and the confidence each one needs.
   *
   * Writes need more certainty than reads, because the costs are asymmetric: a
   * wrong CHECK shows a customer their own booking; a wrong CANCEL destroys
   * it. Anything not in this table — whatever the model returns — is treated
   * as NONE. The table is the whitelist.
   */
  private static readonly CLASSIFIABLE_INTENTS: Record<string, number> = {
    BOOK_APPOINTMENT: 0.75,
    MANAGE_RESERVATION: 0.75,
    CANCEL_BOOKING: 0.8,
    RESCHEDULE_BOOKING: 0.8,
    REQUEST_REFUND: 0.75,
    REQUEST_QUOTATION: 0.75,
    CREATE_TICKET: 0.75,
    REQUEST_SELFIE: 0.75,
    CHECK_BOOKING_STATUS: 0.6,
    PROVIDE_PAYMENT_GUIDANCE: 0.6,
    HUMAN_HANDOFF: 0.6,
    AI_DISCLOSURE: 0.6,
    CAPABILITIES: 0.6,
  };

  /**
   * Ask the LLM which EXISTING intent a message is — in any of the five
   * supported languages — or null when it is none of them, the model is
   * unsure, no key is configured, or anything at all goes wrong. Null always
   * means "fall through to the RAG path", so this can only add routing, never
   * take any away.
   */
  private async classifyIntentWithLlm(
    messageText: string
  ): Promise<{ intent: string; confidence: number; serviceName: string | null } | null> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;

    const systemPrompt =
      `You classify ONE customer message for a customer-service system. The message may be in ` +
      `English, Nigerian Pidgin, Hausa, Igbo or Yoruba.\n` +
      `Reply with ONLY a JSON object: {"intent": string, "confidence": number 0-1, "serviceName": string|null}\n` +
      `intent must be exactly one of:\n` +
      `BOOK_APPOINTMENT - wants a NEW appointment, consultation, registration or enrollment\n` +
      `MANAGE_RESERVATION - wants a NEW table or room reservation\n` +
      `CHECK_BOOKING_STATUS - asks about an EXISTING booking or reservation\n` +
      `RESCHEDULE_BOOKING - wants to MOVE an existing booking\n` +
      `CANCEL_BOOKING - wants to CANCEL an existing booking\n` +
      `PROVIDE_PAYMENT_GUIDANCE - asks how or where to pay\n` +
      `REQUEST_REFUND - wants money back\n` +
      `REQUEST_QUOTATION - asks the price or cost of a service\n` +
      `CREATE_TICKET - complains or reports a problem\n` +
      `REQUEST_SELFIE - asks about sending their photo or identity picture\n` +
      `HUMAN_HANDOFF - wants to talk to a human being\n` +
      `AI_DISCLOSURE - asks whether they are talking to an AI, robot or human\n` +
      `CAPABILITIES - asks what the assistant can do\n` +
      `NONE - anything else: greetings, questions about the business, general conversation\n` +
      `serviceName: the specific service they want, translated to English — or null.\n` +
      `Use NONE whenever you are not sure. Confidence reflects the MESSAGE's clarity, not your optimism.`;

    try {
      const response = await fetch(chatCompletionsUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: llmConfig().chatModel,
          max_tokens: 120,
          temperature: 0,
          messages: [
            { role: 'system', content: systemPrompt },
            // Truncated: intent lives in the first sentence or two, and the
            // classifier must never become the expensive call on the path.
            { role: 'user', content: messageText.slice(0, 600) },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return null;

      const data: any = await response.json();
      const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
      const jsonText = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonText);

      const intent = typeof parsed.intent === 'string' ? parsed.intent.toUpperCase().trim() : '';
      const threshold = ConversationOrchestrator.CLASSIFIABLE_INTENTS[intent];
      if (threshold === undefined) return null; // NONE, or something invented

      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;
      if (!(confidence >= threshold && confidence <= 1)) return null;

      const serviceName =
        typeof parsed.serviceName === 'string' && parsed.serviceName.trim().length >= 3
          ? parsed.serviceName.trim().slice(0, 80)
          : null;

      return { intent, confidence, serviceName };
    } catch {
      return null; // no JSON, timeout, network — all mean "keywords only today"
    }
  }

  /**
   * Route a classified intent to the SAME executor its keyword branch uses.
   * The return shapes deliberately mirror those branches one for one, so a
   * message routed here is indistinguishable downstream (analytics included)
   * from one that matched a keyword — except by its confidence score.
   */
  private async dispatchClassifiedIntent(
    classified: { intent: string; confidence: number; serviceName: string | null },
    context: ConversationContext,
    cleanInput: string,
    lang: Language
  ) {
    const { intent, confidence, serviceName } = classified;
    try {
      switch (intent) {
        case 'HUMAN_HANDOFF':
          return {
            replyText: t(lang, 'escalation_connecting'),
            intentDetected: 'HUMAN_HANDOFF',
            confidenceScore: confidence,
            shouldHandoff: true,
            handoffReason: HandoffReason.CUSTOMER_REQUEST,
          };
        case 'AI_DISCLOSURE':
          return {
            replyText: t(lang, 'ai_disclosure', {
              org: await this.getOrganizationName(context.organizationId),
            }),
            intentDetected: 'AI_DISCLOSURE',
            confidenceScore: confidence,
            shouldHandoff: false,
          };
        case 'CAPABILITIES':
          return {
            replyText: t(lang, 'capabilities', {
              org: await this.getOrganizationName(context.organizationId),
            }),
            intentDetected: 'CAPABILITIES',
            confidenceScore: confidence,
            shouldHandoff: false,
          };
        case 'BOOK_APPOINTMENT': {
          const result = await this.executeBookAppointment(context, cleanInput, lang, serviceName ?? undefined);
          return {
            replyText: result.message,
            intentDetected: 'BOOK_APPOINTMENT',
            confidenceScore: confidence,
            shouldHandoff: result.shouldHandoff,
            ...(result.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
            toolCallsExecuted: [{ toolName: 'book_appointment', result }],
          };
        }
        case 'MANAGE_RESERVATION': {
          const result = await this.executeManageReservation(context, cleanInput);
          return {
            replyText: result.message,
            intentDetected: 'MANAGE_RESERVATION',
            confidenceScore: confidence,
            shouldHandoff: result.shouldHandoff,
            ...(result.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
            toolCallsExecuted: [{ toolName: 'manage_reservation', result }],
          };
        }
        case 'CHECK_BOOKING_STATUS': {
          const result = await this.executeCheckBookingStatus(context, lang);
          return {
            replyText: result.message,
            intentDetected: 'CHECK_BOOKING_STATUS',
            confidenceScore: confidence,
            shouldHandoff: false,
            toolCallsExecuted: [{ toolName: 'check_booking_status', result }],
          };
        }
        case 'CANCEL_BOOKING': {
          const result = await this.executeCancelBookingOrReservation(context, lang);
          return {
            replyText: result.message,
            intentDetected: 'CANCEL_BOOKING',
            confidenceScore: confidence,
            shouldHandoff: false,
            toolCallsExecuted: [{ toolName: 'cancel_booking', result }],
          };
        }
        case 'RESCHEDULE_BOOKING': {
          const result = await this.executeRescheduleBookingOrReservation(context, lang);
          return {
            replyText: result.message,
            intentDetected: 'RESCHEDULE_BOOKING',
            confidenceScore: confidence,
            shouldHandoff: false,
            toolCallsExecuted: [{ toolName: 'reschedule_booking', result }],
          };
        }
        case 'REQUEST_REFUND': {
          const result = await this.executeRequestRefund(context, cleanInput);
          return {
            replyText: result.message,
            intentDetected: 'REQUEST_REFUND',
            confidenceScore: confidence,
            shouldHandoff: false,
            toolCallsExecuted: [{ toolName: 'request_refund', result }],
          };
        }
        case 'REQUEST_QUOTATION': {
          const result = await this.executeGenerateQuotation(context, cleanInput);
          return {
            replyText: result.summaryText,
            intentDetected: 'REQUEST_QUOTATION',
            confidenceScore: confidence,
            shouldHandoff: result.shouldHandoff,
            ...(result.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
            toolCallsExecuted: [{ toolName: 'request_quotation', result }],
          };
        }
        case 'CREATE_TICKET': {
          const result = await this.executeCreateTicket(context, cleanInput);
          return {
            replyText: `I've opened support ticket *#${result.ticketNumber}* for your inquiry. Our team has been notified and will follow up with you shortly.`,
            intentDetected: 'CREATE_TICKET',
            confidenceScore: confidence,
            shouldHandoff: false,
            toolCallsExecuted: [{ toolName: 'create_support_ticket', result }],
          };
        }
        case 'PROVIDE_PAYMENT_GUIDANCE': {
          const result = await this.executeProvidePaymentGuidance(context, lang);
          return {
            replyText: result.replyText,
            intentDetected: 'PROVIDE_PAYMENT_GUIDANCE',
            confidenceScore: confidence,
            shouldHandoff: result.shouldHandoff,
            ...(result.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
            toolCallsExecuted: [{ toolName: 'provide_payment_guidance', result }],
          };
        }
        case 'REQUEST_SELFIE': {
          const result = await this.executeRequestSelfie(context);
          return {
            replyText: result.replyText,
            intentDetected: 'REQUEST_SELFIE',
            confidenceScore: confidence,
            shouldHandoff: result.shouldHandoff,
            ...(result.shouldHandoff ? { handoffReason: HandoffReason.TOOL_FAILURE } : {}),
            toolCallsExecuted: [{ toolName: 'request_onboarding_selfie', result }],
          };
        }
        default:
          return null;
      }
    } catch (err) {
      // Same contract as every keyword branch: a tool failure is an honest
      // reply plus a handoff, never a throw the customer experiences as silence.
      return this.toolFailureReply(intent, err, lang);
    }
  }

  /**
   * Record a language the customer explicitly chose.
   *
   * Awaited, unlike the fire-and-forget write in `resolveReplyLanguage`: this
   * one backs a sentence that says "from now on", and the reply should not go
   * out before the write it describes has been attempted. A failure is logged
   * rather than escalated — the customer still gets the language they asked for
   * in this conversation, and a preference that has to be re-stated next time
   * is a smaller harm than derailing them into a handoff over it.
   */
  private async persistPreferredLanguage(
    context: ConversationContext,
    language: Language
  ): Promise<void> {
    const phone = context.customerPhoneNumber;
    if (!phone) return;
    try {
      const contact = await prisma.contact.findFirst({
        where: {
          organizationId: context.organizationId,
          phoneNumber: { in: phoneNumberVariants(phone) },
        },
        select: { id: true },
      });
      if (!contact) return;
      await prisma.contact.update({
        where: { id: contact.id },
        data: { preferredLanguage: language },
      });
    } catch (err: any) {
      console.error(JSON.stringify({
        level: 'warn',
        service: 'ConversationOrchestrator',
        event: 'preferred_language_persist_failed',
        organizationId: context.organizationId,
        language,
        error: err?.message,
      }));
    }
  }

  /** Organization display name, with a neutral fallback if the row is unreachable. */
  private async getOrganizationName(organizationId: string): Promise<string> {
    try {
      const org = await prisma.organization.findUnique({
        where: { id: organizationId },
        select: { name: true },
      });
      return org?.name ?? 'our team';
    } catch {
      return 'our team';
    }
  }

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
      // Every shape on the way in, the canonical one on the way out: the same
      // customer reaching this platform by phone and by WhatsApp must land on
      // one contact, not two.
      const existing = await prisma.contact.findFirst({
        where: {
          organizationId: context.organizationId,
          phoneNumber: { in: phoneNumberVariants(phone) },
        },
      });
      if (existing) return existing;

      return await prisma.contact.create({
        data: {
          organizationId: context.organizationId,
          phoneNumber: normalizePhoneNumber(phone),
          fullName: `Valued Customer (···${phone.slice(-4)})`,
        },
      });
    } catch (err: any) {
      if (err.code === 'P2002') {
        // Another concurrent request created this contact first
        const contact = await prisma.contact.findFirst({
          where: {
            organizationId: context.organizationId,
            phoneNumber: { in: phoneNumberVariants(phone) },
          },
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
