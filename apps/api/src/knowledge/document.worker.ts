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
import { createClient } from 'redis';

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
    // In production: download from S3/GCS using presigned URL or service account
    // For local dev: storageUrl is a local filesystem path
    let rawText = '';
    if (storageUrl.startsWith('http')) {
      const fileResponse = await fetch(storageUrl);
      if (!fileResponse.ok) throw new Error(`Failed to download document: HTTP ${fileResponse.status}`);
      // For PDF: in production, use pdf-parse or AWS Textract
      // For TXT/MD: read directly
      rawText = await fileResponse.text();
    } else {
      const fs = await import('fs/promises');
      rawText = await fs.readFile(storageUrl, 'utf8');
    }

    if (!rawText.trim()) {
      throw new Error(`Document ${documentId} produced empty text after extraction. Check file format.`);
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

// ── Worker factory ─────────────────────────────────────────────────────────────
//
// IMPORTANT: this must stay a factory, not a top-level `new Worker(...)`.
// The previous version instantiated the Worker as an import side effect and
// exported it — but nothing ever imported this file and no deploy manifest ran
// it as a separate process, so with Redis configured every upload sat at
// PENDING forever. It is now started inside the API process by
// DocumentWorkerHost (knowledge.module.ts) when REDIS_URL is set.

export function startDocumentWorker(redisUrl: string): Worker<DocumentJob> {
  const worker = new Worker<DocumentJob>(
    'document-ingestion',
    processDocumentJob,
    {
      connection: {
        url: redisUrl,
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
    redisUrl: redisUrl.replace(/:[^:@]+@/, ':***@'), // Mask password
  }));

  return worker;
}
