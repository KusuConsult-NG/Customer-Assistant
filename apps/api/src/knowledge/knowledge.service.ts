import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { prisma } from '@ace/database';
import { assertPublicHttpUrl } from '../common/url-safety';
import { QdrantRAGService } from '@ace/orchestrator';
import { Queue } from 'bullmq';
import { AceLogger } from '../config/logger';
import { KNOWLEDGE_BUCKET, deleteObject, signedUrl, uploadObject } from '../common/object-storage';

const log = new AceLogger('KnowledgeService');

/** Chunk size in characters (~450 tokens), matching document.worker.ts. */
const CHUNK_SIZE_CHARS = 1800;

/** Text-bearing MIME types this process can extract without the worker. */
const INLINE_EXTRACTABLE = ['text/plain', 'text/markdown', 'text/html', 'application/json'];

/**
 * Splits text into overlapping chunks. The 10% overlap preserves context across
 * boundaries so a sentence spanning two chunks is still retrievable.
 */
function chunkText(text: string, chunkSize = CHUNK_SIZE_CHARS): string[] {
  const overlap = Math.floor(chunkSize * 0.1);
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, Math.min(i + chunkSize, text.length)).trim());
    i += chunkSize - overlap;
  }
  return chunks.filter((c) => c.length > 50);
}

/**
 * Extracts plain text from a buffer for the MIME types this process can handle.
 *
 * PDF and DOCX are binary container formats: decoding them as UTF-8 yields mojibake,
 * not prose. The inline path therefore refuses them (the background worker owns real
 * extraction) rather than indexing garbage and reporting success.
 */
function extractPlainText(buffer: Buffer, mimeType: string): string {
  if (!INLINE_EXTRACTABLE.includes(mimeType)) return '';
  const raw = buffer.toString('utf8');
  return mimeType === 'text/html'
    ? raw
        .replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    : raw;
}

/**
 * Supabase Storage bucket name.
 * Create this bucket in: Supabase Dashboard → Storage → New Bucket
 * Set it to PRIVATE (not public) — files are served via signed URLs.
 */
const SUPABASE_BUCKET = 'knowledge-documents';

/**
 * Maximum file size allowed per upload: 50MB.
 * Larger files should be split before upload or processed via streaming.
 */
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Allowed MIME types for knowledge base documents.
 */
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'text/plain',
  'text/markdown',
  'application/json',
];

/**
 * BullMQ queue for async document ingestion.
 * Initialized lazily so the service starts even if Redis is temporarily unavailable.
 */
let documentQueue: Queue | null = null;

function getDocumentQueue(): Queue {
  if (!documentQueue) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      throw new Error(
        'REDIS_URL is not set. Document ingestion queue cannot be initialized. ' +
        'Set REDIS_URL in your .env file and restart the server.'
      );
    }
    documentQueue = new Queue('document-ingestion', {
      connection: { url: redisUrl },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000, // 5s, 10s, 20s
        },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    });
  }
  return documentQueue;
}

// Storage lives in ../common/object-storage. It previously had a private copy here
// that omitted the `apikey` header Supabase Storage requires, so every document upload
// failed with an opaque HTTP 400 — see the note in that module.

// ─── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class KnowledgeService {
  private ragService = new QdrantRAGService();

  async getDocuments(organizationId: string) {
    return prisma.knowledgeDocument.findMany({
      where: { organizationId },
      include: { _count: { select: { chunks: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Upload a document to Supabase Storage and enqueue it for async processing.
   *
   * Flow:
   *   1. Validate file type and size
   *   2. Upload raw file to Supabase Storage (tenant-namespaced path)
   *   3. Create KnowledgeDocument record with status='PENDING'
   *   4. Enqueue a 'process_document' job in BullMQ
   *   5. Return immediately with { documentId, status: 'PENDING' }
   *
   * The BullMQ worker (document.worker.ts) picks up the job and:
   *   - Downloads the file from Supabase Storage
   *   - Chunks + embeds + upserts to Qdrant
   *   - Updates status → 'INDEXED'
   *
   * @param fileBuffer - Raw file bytes (from multipart upload)
   */
  async uploadAndIndexDocument(
    organizationId: string,
    data: {
      title: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      fileBuffer: Buffer;
    }
  ) {
    const timer = log.startTimer();

    // ── Validate ─────────────────────────────────────────────────────────
    if (!ALLOWED_MIME_TYPES.includes(data.mimeType)) {
      throw new BadRequestException(
        `File type "${data.mimeType}" is not supported. ` +
        `Allowed types: PDF, DOCX, TXT, Markdown, JSON.`
      );
    }

    if (data.fileSize > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException(
        `File size ${(data.fileSize / 1024 / 1024).toFixed(1)}MB exceeds the 50MB limit. ` +
        `Split the document into smaller files before uploading.`
      );
    }

    // ── Upload to Supabase Storage ────────────────────────────────────────
    const storagePath = await uploadObject(KNOWLEDGE_BUCKET, 
      organizationId,
      data.fileName,
      data.fileBuffer,
      data.mimeType
    );

    log.info('knowledge_file_uploaded', {
      organizationId,
      event: 'file_uploaded_to_supabase',
      fileName: data.fileName,
      storagePath,
      fileSizeKb: Math.round(data.fileSize / 1024),
    }, timer);

    // ── Create document record ────────────────────────────────────────────
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId,
        title: data.title,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        storageUrl: storagePath, // Supabase Storage path (not a public URL)
        status: 'PENDING',
      },
    });

    // ── Enqueue async processing job (with inline fallback) ──────────────
    let jobId: string | undefined = undefined;
    let vectorised = false;

    try {
      const queue = getDocumentQueue();
      const job = await queue.add('process_document', {
        documentId: doc.id,
        organizationId,
        storageUrl: storagePath,
        mimeType: data.mimeType,
        fileName: data.fileName,
        useSupabaseStorage: true,
      });
      jobId = job.id;
    } catch (queueErr: any) {
      // Fallback when Redis/BullMQ is unreachable: index inline.
      //
      // The previous fallback wrote raw 500-character chunks to PostgreSQL, marked
      // the document INDEXED and reported "indexed successfully" — but generated no
      // embeddings and wrote nothing to Qdrant. Semantic search could not find a
      // single word of it. That is now done properly (chunk → embed → upsert), and
      // when embedding is unavailable the document is left in a state that says so.
      log.warn('document_queue_unavailable_indexing_inline', {
        organizationId,
        documentId: doc.id,
        error: queueErr?.message,
      });

      try {
        const result = await this.indexDocumentInline(
          organizationId, doc.id, data.fileBuffer, data.mimeType
        );
        vectorised = result.vectorised;
      } catch (inlineErr: any) {
        await prisma.knowledgeDocument.update({
          where: { id: doc.id },
          data: { status: 'FAILED', errorMessage: String(inlineErr?.message).slice(0, 500) },
        });
        throw new ServiceUnavailableException(
          `Document was uploaded but could not be indexed: ${inlineErr?.message}. ` +
          `It is marked FAILED — retry once REDIS_URL is reachable.`
        );
      }
    }

    return {
      documentId: doc.id,
      title: doc.title,
      fileName: doc.fileName,
      status: jobId ? 'PENDING' : 'INDEXED',
      /** False when only keyword search will find this document. */
      semanticSearchEnabled: jobId ? true : vectorised,
      message: jobId
        ? 'Document uploaded successfully. Processing and indexing will complete in 1-2 minutes.'
        : vectorised
          ? 'Document uploaded and indexed successfully in single-node mode.'
          : 'Document uploaded and indexed for keyword search. Semantic search is unavailable ' +
            'because embeddings could not be generated (check OPENAI_API_KEY and QDRANT_URL).',
      jobId,
    };
  }

  /**
   * Chunks, embeds and stores a document without the background worker.
   * Returns whether vectors were successfully written to Qdrant.
   */
  private async indexDocumentInline(
    organizationId: string,
    documentId: string,
    fileBuffer: Buffer,
    mimeType: string
  ): Promise<{ chunkCount: number; vectorised: boolean }> {
    const text = extractPlainText(fileBuffer, mimeType);
    if (!text.trim()) {
      throw new Error(
        `No text could be extracted from this ${mimeType} file. ` +
        `PDF and DOCX extraction requires the background worker.`
      );
    }

    const chunks = chunkText(text);

    await prisma.documentChunk.deleteMany({ where: { documentId } });
    await prisma.documentChunk.createMany({
      data: chunks.map((content, chunkIndex) => ({
        documentId,
        organizationId,
        chunkIndex,
        content,
      })),
    });

    const stored = await prisma.documentChunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: 'asc' },
      select: { id: true, chunkIndex: true, content: true },
    });

    let vectorised = false;
    try {
      await this.ragService.upsertChunks(
        organizationId,
        stored.map((c) => ({
          chunkId: c.id,
          documentId,
          chunkIndex: c.chunkIndex,
          content: c.content,
        }))
      );
      await prisma.documentChunk.updateMany({
        where: { documentId },
        data: { qdrantVectorId: null },
      });
      vectorised = true;
    } catch (err: any) {
      // Keyword search still works off the PostgreSQL chunks; say so rather than
      // claiming the document is fully searchable.
      log.warn('inline_vectorisation_failed', { organizationId, documentId, error: err?.message });
    }

    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'INDEXED', chunkCount: chunks.length, errorMessage: null },
    });

    return { chunkCount: chunks.length, vectorised };
  }


  /**
   * Get a short-lived signed URL to download a stored document.
   * URL expires in 1 hour.
   */
  async getDocumentDownloadUrl(organizationId: string, documentId: string): Promise<string> {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: documentId, organizationId },
    });

    if (!doc) throw new NotFoundException('Document not found');

    return signedUrl(KNOWLEDGE_BUCKET, doc.storageUrl, 3600);
  }

  /**
   * Search the knowledge base using semantic vector search (RAG).
   */
  async searchPlayground(organizationId: string, query: string) {
    if (!query?.trim()) throw new BadRequestException('Search query cannot be empty');
    return this.ragService.searchKnowledgeBase(organizationId, query.trim(), 5);
  }

  /**
   * Delete a document from both Supabase Storage and the database.
   * Also removes all associated vector chunks from Qdrant (handled by the worker on re-index).
   */
  async deleteDocument(organizationId: string, documentId: string) {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: documentId, organizationId },
    });

    if (!doc) throw new NotFoundException('Document not found');

    const timer = log.startTimer();

    // Delete from Supabase Storage (skipped for crawled pages, whose storageUrl is
    // the source URL rather than a storage path).
    if (!/^https?:\/\//i.test(doc.storageUrl)) {
      await deleteObject(KNOWLEDGE_BUCKET, doc.storageUrl);
    }

    // Remove the vectors too.
    //
    // These were previously left in Qdrant, with a comment claiming the worker would
    // clear them "on re-index" — it never does. The orphaned vectors stayed
    // searchable, so the AI kept quoting deleted documents to customers indefinitely.
    try {
      await this.ragService.deleteDocumentVectors(organizationId, documentId);
    } catch (err: any) {
      log.warn('qdrant_vector_delete_failed', { organizationId, documentId, error: err?.message });
    }

    // Delete chunks and document record from PostgreSQL
    await prisma.documentChunk.deleteMany({ where: { documentId } });
    await prisma.knowledgeDocument.delete({ where: { id: documentId } });

    log.info('knowledge_document_deleted', {
      organizationId,
      documentId,
      event: 'document_deleted',
    }, timer);

    return {
      success: true,
      message: `Document "${doc.title}" removed from knowledge base and storage.`,
    };
  }

  /**
   * Crawl a website URL, extract text content, and index it directly into the Knowledge Base.
   */
  async crawlAndIndexWebsite(organizationId: string, websiteUrl: string) {
    let cleanUrl = websiteUrl.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }

    // SSRF prevention.
    //
    // The previous check inspected the hostname STRING only, so it was defeated by
    // anything that is not a literal private address: a public DNS name that resolves
    // to 169.254.169.254 or a VPC address, decimal/hex notation (`http://2130706433/`),
    // or an IPv6-mapped form (`http://[::ffff:169.254.169.254]/`). The hostname is now
    // RESOLVED and every returned address checked against private ranges before we
    // fetch, and redirects are refused so a public URL cannot bounce us internally.
    await assertPublicHttpUrl(cleanUrl);

    let html = '';
    try {
      const response = await fetch(cleanUrl, {
        headers: { 'User-Agent': 'ACE-Platform-Bot/1.0 (+knowledge-base crawler)' },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });

      if (response.status >= 300 && response.status < 400) {
        throw new BadRequestException(
          `${cleanUrl} redirects elsewhere. Please supply the final URL directly.`
        );
      }
      if (!response.ok) {
        throw new BadRequestException(`Failed to fetch URL ${cleanUrl} (HTTP ${response.status})`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!/text\/html|text\/plain|application\/xhtml/i.test(contentType)) {
        throw new BadRequestException(
          `${cleanUrl} returned "${contentType || 'an unknown content type'}". ` +
          `Only HTML and plain-text pages can be indexed.`
        );
      }

      html = await response.text();
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Could not reach website URL ${cleanUrl}: ${err?.message || 'Network error'}`);
    }

    // Strip scripts, styles, and HTML tags to get clean plain text
    const textContent = html
      .replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!textContent || textContent.length < 50) {
      throw new BadRequestException('No readable text content could be extracted from this website URL.');
    }

    let domain = cleanUrl;
    try { domain = new URL(cleanUrl).hostname; } catch {}
    const title = `Website: ${domain}`;

    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId,
        title,
        fileName: cleanUrl,
        fileSize: Buffer.byteLength(textContent, 'utf-8'),
        mimeType: 'text/html',
        storageUrl: cleanUrl,
        status: 'PROCESSING',
      },
    });

    // Crawled pages go through the same chunk → embed → upsert path as uploads.
    // This used to write raw 500-character slices straight to PostgreSQL and set
    // status INDEXED with no embeddings at all, so semantic search never returned a
    // single crawled page even though the UI reported it as indexed.
    const { chunkCount, vectorised } = await this.indexDocumentInline(
      organizationId,
      doc.id,
      Buffer.from(textContent, 'utf-8'),
      'text/plain'
    );

    return {
      documentId: doc.id,
      title: doc.title,
      chunksIndexed: chunkCount,
      status: 'INDEXED',
      semanticSearchEnabled: vectorised,
      message: vectorised
        ? `Successfully crawled and indexed ${chunkCount} sections from ${cleanUrl}`
        : `Crawled ${chunkCount} sections from ${cleanUrl}, but embeddings could not be ` +
          `generated — only keyword search will find this page.`,
    };
  }
}

