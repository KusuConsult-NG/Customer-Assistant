/**
 * ACE Platform — BullMQ Document Ingestion Worker
 *
 * WHY this exists:
 *   Without a background queue, document uploads are processed synchronously
 *   on the HTTP request thread. A 50-page PDF takes ~5-15 seconds to chunk and
 *   embed. This blocks the Node.js event loop, causing:
 *     - HTTP 504 Gateway Timeout on the upload endpoint
 *     - Delayed processing of concurrent WhatsApp messages
 *     - Out-of-memory crashes on large PDFs (>10MB)
 *
 *   The queue moves all CPU/IO-bound work off the request lifecycle.
 *   The HTTP handler enqueues a job and returns immediately with a 202 Accepted.
 *   This worker processes jobs concurrently up to DOCUMENT_CONCURRENCY.
 *
 * Architecture:
 *   KnowledgeController.uploadDocument()
 *     → prisma.knowledgeDocument.create({ status: 'PENDING' })
 *     → documentQueue.add('process_document', { documentId })
 *     → HTTP 202 { documentId, status: 'PENDING' }
 *
 *   DocumentWorker (this file)
 *     → picks up 'process_document' job from Redis queue
 *     → downloads file from storage (S3 / local disk)
 *     → chunks text into ~512-token segments
 *     → calls OpenAI text-embedding-3-small for each chunk
 *     → upserts vectors into Qdrant collection org_{organizationId}
 *     → updates document status to 'INDEXED'
 *
 * Scaling:
 *   - Run multiple instances of this worker process independently
 *   - BullMQ uses Redis-backed locking to ensure each job is processed exactly once
 *   - Set DOCUMENT_CONCURRENCY = 1 on low-memory machines, up to 5 on large workers
 *
 * Failure modes:
 *   - If the OpenAI API returns a rate limit (429), BullMQ automatically retries
 *     with exponential backoff (configured in DocumentQueue module)
 *   - If Qdrant is unreachable, job fails and document status is set to 'FAILED'
 *   - Failed jobs are kept in the 'failed' queue for inspection and manual retry
 */

import { Worker, Job } from 'bullmq';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const DOCUMENT_CONCURRENCY = parseInt(process.env.DOCUMENT_WORKER_CONCURRENCY || '2', 10);
const CHUNK_SIZE_CHARS = 1800; // ~450 tokens at ~4 chars/token
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

interface DocumentJob {
  documentId: string;
  organizationId: string;
  storageUrl: string;
  mimeType: string;
  fileName: string;
}

/**
 * Split text into overlapping chunks.
 * Overlap of 10% between chunks preserves context across chunk boundaries,
 * improving RAG retrieval quality for questions that span chunk edges.
 */
function chunkText(text: string, chunkSize: number = CHUNK_SIZE_CHARS): string[] {
  const overlap = Math.floor(chunkSize * 0.1);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(i + chunkSize, text.length);
    chunks.push(text.slice(i, end).trim());
    i += chunkSize - overlap;
  }
  return chunks.filter((c) => c.length > 50); // Discard tiny trailing chunks
}

/**
 * Generate an embedding vector for a text string using OpenAI.
 * Returns a 1536-dimension float array (text-embedding-3-small output).
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 8000), // Max token safety clamp
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Embeddings error ${response.status}: ${errText}`);
  }

  const data: any = await response.json();
  return data.data[0].embedding;
}

/**
 * Ensure the Qdrant collection for an organization exists.
 * Vector dimensions must match the embedding model output (1536 for text-embedding-3-small).
 */
async function ensureQdrantCollection(organizationId: string): Promise<void> {
  const collectionName = `org_${organizationId}`;
  const qdrantHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.QDRANT_API_KEY) qdrantHeaders['api-key'] = process.env.QDRANT_API_KEY;

  const checkRes = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
    headers: qdrantHeaders,
  });

  if (checkRes.status === 404) {
    const createRes = await fetch(`${QDRANT_URL}/collections/${collectionName}`, {
      method: 'PUT',
      headers: qdrantHeaders,
      body: JSON.stringify({
        vectors: {
          size: 1536,
          distance: 'Cosine',
        },
      }),
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create Qdrant collection ${collectionName}: ${errText}`);
    }
  }
}

/**
 * Upsert chunked vectors into Qdrant.
 * Points are identified by chunkId for idempotent re-processing.
 */
async function upsertVectorsToQdrant(
  organizationId: string,
  points: Array<{ chunkId: string; documentId: string; content: string; vector: number[]; chunkIndex: number }>
): Promise<void> {
  const collectionName = `org_${organizationId}`;
  const qdrantHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.QDRANT_API_KEY) qdrantHeaders['api-key'] = process.env.QDRANT_API_KEY;

  const qdrantPoints = points.map((p) => ({
    id: p.chunkId,
    vector: p.vector,
    payload: {
      chunkId: p.chunkId,
      documentId: p.documentId,
      organizationId,
      content: p.content,
      chunkIndex: p.chunkIndex,
    },
  }));

  const upsertRes = await fetch(`${QDRANT_URL}/collections/${collectionName}/points?wait=true`, {
    method: 'PUT',
    headers: qdrantHeaders,
    body: JSON.stringify({ points: qdrantPoints }),
  });

  if (!upsertRes.ok) {
    const errText = await upsertRes.text();
    throw new Error(`Qdrant upsert failed: ${errText}`);
  }
}

// Lazy import prisma to avoid loading the full NestJS DI container in the worker process
async function getPrisma() {
  const { prisma } = await import('@ace/database');
  return prisma;
}

const SUPABASE_BUCKET = 'knowledge-documents';

/**
 * Downloads a queued document.
 *
 * `storageUrl` is a Supabase Storage object path unless it is an absolute http(s)
 * URL (crawled pages). Supabase objects are in a PRIVATE bucket, so they are fetched
 * with the service-role key rather than anonymously.
 */
async function downloadDocument(storageUrl: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(storageUrl)) {
    const res = await fetch(storageUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Failed to download document: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error(
      'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are required to download queued documents.'
    );
  }

  const res = await fetch(
    `${supabaseUrl}/storage/v1/object/${SUPABASE_BUCKET}/${storageUrl}`,
    {
      headers: { Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(60_000),
    }
  );

  if (!res.ok) {
    throw new Error(
      `Failed to download "${storageUrl}" from Supabase Storage (HTTP ${res.status}). ` +
      `Confirm the "${SUPABASE_BUCKET}" bucket exists and the service-role key is valid.`
    );
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Extracts plain text from a document buffer.
 *
 * PDF and DOCX extraction requires a parser that is not currently a dependency
 * (`pdf-parse` and `mammoth` are the usual choices). Rather than silently indexing
 * binary garbage — which is what decoding them as UTF-8 produced — those formats
 * fail with an actionable message and the document is marked FAILED, so the operator
 * can see that it is not searchable instead of believing that it is.
 */
async function extractText(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  switch (mimeType) {
    case 'text/plain':
    case 'text/markdown':
    case 'application/json':
      return buffer.toString('utf8');

    case 'text/html':
      return buffer
        .toString('utf8')
        .replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    case 'application/pdf':
      return extractWithOptionalParser('pdf-parse', buffer, fileName, 'PDF');

    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return extractWithOptionalParser('mammoth', buffer, fileName, 'DOCX');

    default:
      throw new Error(`Unsupported MIME type for text extraction: ${mimeType}`);
  }
}

/**
 * Uses an optional parser package when it is installed, and otherwise explains
 * exactly what to install. Keeping these optional avoids forcing a heavyweight
 * dependency on deployments that only ingest plain text.
 */
async function extractWithOptionalParser(
  moduleName: 'pdf-parse' | 'mammoth',
  buffer: Buffer,
  fileName: string,
  label: string
): Promise<string> {
  let mod: any;
  try {
    mod = await import(moduleName);
  } catch {
    throw new Error(
      `${label} text extraction requires the "${moduleName}" package, which is not installed. ` +
      `Run: npm install ${moduleName} --workspace @ace/api   (document: ${fileName})`
    );
  }

  if (moduleName === 'pdf-parse') {
    const parse = mod.default ?? mod;
    const result = await parse(buffer);
    return result?.text ?? '';
  }

  const mammoth = mod.default ?? mod;
  const result = await mammoth.extractRawText({ buffer });
  return result?.value ?? '';
}

/**
 * Main document processing job handler.
 */
async function processDocumentJob(job: Job<DocumentJob>): Promise<void> {
  const { documentId, organizationId, storageUrl, mimeType, fileName } = job.data;
  const prisma = await getPrisma();

  console.log(JSON.stringify({
    level: 'info',
    service: 'DocumentWorker',
    event: 'job_started',
    documentId,
    organizationId,
    fileName,
    jobId: job.id,
  }));

  await prisma.knowledgeDocument.update({
    where: { id: documentId },
    data: { status: 'PROCESSING' },
  });

  try {
    // ── Step 1: Fetch document content ──────────────────────────────────────
    //
    // KnowledgeService stores `storageUrl` as a Supabase Storage PATH
    // (`<orgId>/<ts>_<name>.pdf`), not a URL. The previous code branched on
    // `startsWith('http')` and, for everything else, called
    // `fs.readFile(storageUrl)` — which is a path on the Supabase bucket, not on
    // this machine. Every queued document failed with ENOENT, so the whole
    // background ingestion path had never successfully processed a single upload.
    const fileBuffer = await downloadDocument(storageUrl);

    // Extract text according to the actual file format. Reading a PDF or DOCX — both
    // binary containers, DOCX being a ZIP — as UTF-8 yields binary noise, which was
    // then chunked, embedded and stored as if it were the document's prose.
    const rawText = await extractText(fileBuffer, mimeType, fileName);

    if (!rawText.trim()) {
      throw new Error(
        `Document ${documentId} (${mimeType}) produced no extractable text. ` +
        `Scanned PDFs need OCR, which is not configured.`
      );
    }

    // ── Step 2: Chunk text ────────────────────────────────────────────────
    const chunks = chunkText(rawText);
    console.log(JSON.stringify({
      level: 'info',
      service: 'DocumentWorker',
      event: 'document_chunked',
      documentId,
      chunkCount: chunks.length,
    }));

    // ── Step 3: Ensure Qdrant collection exists ───────────────────────────
    await ensureQdrantCollection(organizationId);

    // ── Step 4: Embed and upsert each chunk ────────────────────────────────
    const qdrantPoints: Array<{ chunkId: string; documentId: string; content: string; vector: number[]; chunkIndex: number }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkContent = chunks[i];

      // Save chunk to PostgreSQL first to get a stable UUID
      let chunkRecord = await prisma.documentChunk.findFirst({
        where: { documentId, chunkIndex: i },
      });
      if (!chunkRecord) {
        chunkRecord = await prisma.documentChunk.create({
          data: {
            documentId,
            organizationId,
            chunkIndex: i,
            content: chunkContent,
          },
        });
      }

      // Generate embedding
      const vector = await generateEmbedding(chunkContent);

      qdrantPoints.push({
        chunkId: chunkRecord.id,
        documentId,
        content: chunkContent,
        vector,
        chunkIndex: i,
      });

      // Update Qdrant vector ID in PostgreSQL
      await prisma.documentChunk.update({
        where: { id: chunkRecord.id },
        data: { qdrantVectorId: chunkRecord.id },
      });

      // Report progress to BullMQ (visible in Bull Board dashboard)
      await job.updateProgress(Math.round(((i + 1) / chunks.length) * 100));
    }

    // ── Step 5: Batch upsert all vectors to Qdrant ─────────────────────────
    await upsertVectorsToQdrant(organizationId, qdrantPoints);

    // ── Step 6: Mark document as INDEXED ──────────────────────────────────
    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'INDEXED', chunkCount: chunks.length },
    });

    console.log(JSON.stringify({
      level: 'info',
      service: 'DocumentWorker',
      event: 'job_completed',
      documentId,
      organizationId,
      chunkCount: chunks.length,
    }));

  } catch (err: any) {
    console.error(JSON.stringify({
      level: 'error',
      service: 'DocumentWorker',
      event: 'job_failed',
      documentId,
      organizationId,
      error: err.message,
    }));

    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'FAILED', errorMessage: err.message.slice(0, 500) },
    }).catch(() => {}); // Don't throw if DB update also fails

    throw err; // Re-throw so BullMQ marks the job as failed and schedules retry
  }
}

// ── Start the Worker ───────────────────────────────────────────────────────────

const worker = new Worker<DocumentJob>(
  'document-ingestion',
  processDocumentJob,
  {
    connection: {
      url: REDIS_URL,
    },
    concurrency: DOCUMENT_CONCURRENCY,
  }
);

worker.on('completed', (job: Job) => {
  console.log(JSON.stringify({ level: 'info', service: 'DocumentWorker', event: 'worker_job_done', jobId: job.id }));
});

worker.on('failed', (job: Job | undefined, err: Error) => {
  console.error(JSON.stringify({
    level: 'error',
    service: 'DocumentWorker',
    event: 'worker_job_failed',
    jobId: job?.id,
    error: err.message,
  }));
});

worker.on('error', (err: Error) => {
  console.error(JSON.stringify({ level: 'error', service: 'DocumentWorker', event: 'worker_error', error: err.message }));
});

console.log(JSON.stringify({
  level: 'info',
  service: 'DocumentWorker',
  event: 'worker_started',
  concurrency: DOCUMENT_CONCURRENCY,
  redisUrl: REDIS_URL.replace(/:[^:@]+@/, ':***@'), // Mask password
}));

export { worker };
