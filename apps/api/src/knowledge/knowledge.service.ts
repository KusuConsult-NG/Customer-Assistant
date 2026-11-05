import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { prisma, recordAgencyAudit, type Actor } from '@ace/database';
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

  async getDocumentById(organizationId: string, documentId: string) {
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: documentId, organizationId },
      include: {
        chunks: {
          orderBy: { chunkIndex: 'asc' },
          select: { id: true, chunkIndex: true, content: true, qdrantVectorId: true },
        },
      },
    });
    if (!doc) {
      throw new NotFoundException(`Knowledge document ${documentId} not found`);
    }
    return doc;
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
   * Re-vectorise all existing document chunks into Qdrant.
   *
   * Documents were previously chunked and stored in PostgreSQL but never embedded
   * (OpenAI key was invalid / quota exceeded). This method reads the existing
   * chunks, generates embeddings, and upserts them into Qdrant without
   * re-downloading or re-chunking the source files.
   *
   * Called by POST /api/knowledge/reindex (OWNER/ADMIN only).
   */
  async reindexAllDocuments(organizationId: string): Promise<{
    totalDocs: number;
    totalChunks: number;
    vectorised: boolean;
    message: string;
  }> {
    const chunks = await prisma.documentChunk.findMany({
      where: { organizationId },
      orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
      select: { id: true, documentId: true, chunkIndex: true, content: true },
    });

    if (chunks.length === 0) {
      return { totalDocs: 0, totalChunks: 0, vectorised: false, message: 'No chunks found to index.' };
    }

    const docIds = [...new Set(chunks.map(c => c.documentId))];

    try {
      await this.ragService.upsertChunks(
        organizationId,
        chunks.map(c => ({
          chunkId: c.id,
          documentId: c.documentId,
          chunkIndex: c.chunkIndex,
          content: c.content,
        }))
      );

      log.info('knowledge_reindex_complete', { organizationId, chunks: chunks.length, docs: docIds.length });

      return {
        totalDocs: docIds.length,
        totalChunks: chunks.length,
        vectorised: true,
        message: `Successfully vectorised ${chunks.length} chunks from ${docIds.length} documents into Qdrant.`,
      };
    } catch (err: any) {
      log.error(`knowledge_reindex_failed org=${organizationId}: ${err?.message}`);
      throw new ServiceUnavailableException(
        `Re-indexing failed: ${err?.message}. ` +
        `Ensure OPENAI_API_KEY has active credits and Qdrant is running at ${process.env.QDRANT_URL ?? 'http://localhost:6333'}.`
      );
    }
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

    // A CRAWLED page has no stored file: `storageUrl` holds the web address it
    // was read from, not a bucket path (see crawlAndIndexWebsite). Signing that
    // produces a URL to a bucket object named "https://…" which does not
    // exist — a link that 404s, handed out as if it worked. The source address
    // is the honest answer, and it is what the caller actually wants.
    if (/^https?:\/\//i.test(doc.storageUrl)) {
      throw new BadRequestException(
        `"${doc.title}" was indexed by crawling ${doc.storageUrl} — there is no uploaded file to download. Open that address instead.`
      );
    }

    if (!doc.storageUrl?.trim()) {
      throw new BadRequestException(
        `"${doc.title}" has no stored file, so there is nothing to download.`
      );
    }

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
  async deleteDocument(organizationId: string, documentId: string, actor: Actor) {
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
    // A FAILURE HERE STOPS THE DELETE.
    //
    // It used to be swallowed with a warning, and then the row was deleted
    // anyway — which reinstates the exact bug the paragraph above describes,
    // only now with nothing left in the dashboard to point at. The operator
    // sees "removed from knowledge base", the document is gone from the list,
    // and the vectors keep answering citizens with whatever the agency just
    // decided was wrong enough to delete.
    //
    // So the document stays until its vectors are actually gone. The operator
    // is told why, and the delete is safe to repeat: everything here is
    // idempotent, so a second attempt once Qdrant is reachable completes it.
    try {
      await this.ragService.deleteDocumentVectors(organizationId, documentId);
    } catch (err: any) {
      log.error('qdrant_vector_delete_failed', err instanceof Error ? err : new Error(String(err)), {
        organizationId,
        documentId,
      });
      const couldBeIndexed = Boolean(process.env.OPENAI_API_KEY) && (doc.chunkCount ?? 0) > 0;
      if (couldBeIndexed) {
        throw new ServiceUnavailableException(
          `"${doc.title}" was NOT deleted. Its indexed text could not be removed from the ` +
          `search index (${err?.message ?? 'the vector store did not respond'}), and deleting ` +
          `the record while that text remains would leave the assistant quoting this document ` +
          `with nothing in the dashboard to show for it. Try again once the search index is ` +
          `reachable — repeating this is safe.`
        );
      }

      // Otherwise it could not be in the index in the first place: vectors are
      // only ever written when embeddings are configured, and a document with
      // no chunks was never indexed. Refusing these would mean a deployment
      // running on the Postgres fallback — a supported way to run this — could
      // never delete a document, because a Qdrant it does not use is down.
      log.warn('knowledge_vector_cleanup_skipped_not_indexed', {
        organizationId,
        documentId,
        chunkCount: doc.chunkCount ?? 0,
      });
    }

    // Delete chunks and document record from PostgreSQL
    await prisma.documentChunk.deleteMany({ where: { documentId } });
    await prisma.knowledgeDocument.delete({ where: { id: documentId } });

    log.info('knowledge_document_deleted', {
      organizationId,
      documentId,
      event: 'document_deleted',
    }, timer);

    // Deleting a document removes what the assistant can cite, so "why did it
    // stop answering that" needs an answer. The title, because the id is gone.
    await recordAgencyAudit(actor, organizationId, {
      action: 'agency.document.deleted',
      targetType: 'KnowledgeDocument',
      targetId: documentId,
      previousValue: { title: doc.title, fileName: doc.fileName, chunkCount: doc.chunkCount },
    });

    return {
      success: true,
      message: `Document "${doc.title}" removed from knowledge base and storage.`,
    };
  }

  /**
   * Crawl a website URL, extract text content, and index it directly into the Knowledge Base.
   */
  /**
   * Fetch one URL, following redirects WITHOUT weakening the SSRF guard.
   *
   * Refusing redirects outright was safe and useless: a government site that
   * redirects `/mda` to `/mda/` could not be indexed at all, and the operator
   * was told to "supply the final URL directly" — which they cannot know
   * without a browser. Every hop is RE-VALIDATED instead, so a public URL
   * still cannot bounce us onto an internal address; it just takes the hop
   * rather than giving up.
   */
  private async fetchFollowingRedirects(
    startUrl: string,
    maxHops = 5
  ): Promise<{ finalUrl: string; contentType: string; buffer: Buffer }> {
    let url = startUrl;
    for (let hop = 0; hop <= maxHops; hop++) {
      // Re-checked on EVERY hop. Checking only the first is the hole that
      // refusing redirects was working around.
      await assertPublicHttpUrl(url);

      const response = await fetch(url, {
        headers: { 'User-Agent': 'ACE-Platform-Bot/1.0 (+knowledge-base crawler)' },
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new BadRequestException(`${url} answered ${response.status} with no destination.`);
        }
        url = new URL(location, url).toString();
        continue;
      }
      if (!response.ok) {
        throw new BadRequestException(`Failed to fetch URL ${url} (HTTP ${response.status})`);
      }
      return {
        finalUrl: url,
        contentType: response.headers.get('content-type') ?? '',
        buffer: Buffer.from(await response.arrayBuffer()),
      };
    }
    throw new BadRequestException(`${startUrl} redirected more than ${maxHops} times.`);
  }

  /** Same-origin links on a page, for walking a site rather than one page. */
  private sameOriginLinks(html: string, pageUrl: string, limit: number): string[] {
    const origin = new URL(pageUrl).origin;
    const found = new Set<string>();
    for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
      if (found.size >= limit) break;
      try {
        const u = new URL(m[1], pageUrl);
        if (u.origin !== origin) continue;
        if (!/^https?:$/.test(u.protocol)) continue;
        u.hash = '';
        // Assets are not pages. PDFs ARE indexed, so they stay.
        if (/\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?|mp4|zip)$/i.test(u.pathname)) continue;
        found.add(u.toString());
      } catch {
        // A malformed href is not a reason to abandon the page.
      }
    }
    return [...found];
  }

  /** URLs a site advertises about itself. Far better than guessing paths. */
  private async sitemapUrls(origin: string, limit: number): Promise<string[]> {
    const out = new Set<string>();
    for (const path of ['/sitemap.xml', '/wp-sitemap.xml', '/sitemap_index.xml']) {
      if (out.size >= limit) break;
      try {
        const { buffer, contentType } = await this.fetchFollowingRedirects(origin + path);
        if (!/xml|text/i.test(contentType)) continue;
        const xml = buffer.toString('utf-8');
        const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
        for (const loc of locs) {
          if (out.size >= limit) break;
          // A sitemap index points at more sitemaps; follow one level.
          if (/\.xml($|\?)/i.test(loc)) {
            try {
              const sub = await this.fetchFollowingRedirects(loc);
              for (const m of sub.buffer.toString('utf-8').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
                if (out.size >= limit) break;
                if (!/\.xml($|\?)/i.test(m[1])) out.add(m[1]);
              }
            } catch {
              // One unreadable child sitemap must not lose the others.
            }
            continue;
          }
          out.add(loc);
        }
      } catch {
        // No sitemap at this path is normal, not a failure.
      }
    }
    return [...out];
  }

  /**
   * Index a web page, a PDF, or a whole site.
   *
   * Three things this refused to do, each of which made a public government
   * site unindexable while reporting the refusal as a property of the site:
   *
   *  - **Redirects.** `/mda` → `/mda/` ended the crawl with "supply the final
   *    URL directly", which the operator cannot know without a browser.
   *  - **PDFs.** `Only HTML and plain-text pages can be indexed` — while the
   *    upload path has parsed PDFs all along, through the same extractor this
   *    now calls. A state's service booklet is a PDF; refusing it is refusing
   *    the content.
   *  - **More than one page.** One URL per request, so indexing a site meant
   *    guessing its paths by hand.
   *
   * `maxPages > 1` walks the site: the sitemap first, because a site that
   * advertises its own URLs is better than any guess, then same-origin links
   * from the starting page. Bounded, same-origin only, and every hop
   * re-validated against the SSRF guard.
   */
  async crawlAndIndexWebsite(
    organizationId: string,
    websiteUrl: string,
    opts: { maxPages?: number } = {}
  ) {
    let cleanUrl = websiteUrl.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    const maxPages = Math.min(Math.max(opts.maxPages ?? 1, 1), 40);

    // The first page is fetched before anything else, so a bad URL fails as
    // itself rather than as "nothing could be indexed".
    const first = await this.fetchFollowingRedirects(cleanUrl).catch((err) => {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(
        `Could not reach website URL ${cleanUrl}: ${err?.message || 'Network error'}`
      );
    });

    const queue: string[] = [first.finalUrl];
    if (maxPages > 1) {
      const origin = new URL(first.finalUrl).origin;
      for (const u of await this.sitemapUrls(origin, maxPages * 2)) {
        if (!queue.includes(u)) queue.push(u);
      }
      if (queue.length < maxPages && /html/i.test(first.contentType)) {
        for (const u of this.sameOriginLinks(first.buffer.toString('utf-8'), first.finalUrl, maxPages * 2)) {
          if (!queue.includes(u)) queue.push(u);
        }
      }
    }

    const indexed: Array<{ url: string; documentId: string; chunks: number }> = [];
    const skipped: Array<{ url: string; reason: string }> = [];
    const causes: unknown[] = [];

    for (const pageUrl of queue.slice(0, maxPages)) {
      try {
        const page =
          pageUrl === first.finalUrl ? first : await this.fetchFollowingRedirects(pageUrl);
        const result = await this.indexOnePage(organizationId, page);
        indexed.push({ url: page.finalUrl, documentId: result.documentId, chunks: result.chunks });
      } catch (err: any) {
        // One unreadable page must not lose the rest of the site, and the
        // reason is kept rather than reduced to a count.
        skipped.push({ url: pageUrl, reason: err?.message ?? String(err) });
        causes.push(err);
      }
    }

    if (indexed.length === 0) {
      // A page that could not be READ is the caller's problem — a 400 naming
      // it. A database or embedding failure is OURS, and flattening it into a
      // 400 would tell an operator their URL was wrong when the service was
      // broken. The original error is rethrown so it surfaces as what it is.
      const first_cause = causes[0];
      if (first_cause && !(first_cause instanceof BadRequestException)) throw first_cause;
      throw new BadRequestException(
        skipped[0]?.reason ?? 'No readable content could be extracted from that address.'
      );
    }

    const chunksIndexed = indexed.reduce((n, p) => n + p.chunks, 0);
    return {
      // Kept for the single-page callers that read these.
      documentId: indexed[0].documentId,
      title: `Website: ${new URL(indexed[0].url).hostname}`,
      chunksIndexed,
      status: 'INDEXED',
      semanticSearchEnabled: true,
      pagesIndexed: indexed.length,
      pagesFound: queue.length,
      indexed,
      skipped,
      message:
        `Indexed ${indexed.length} page(s), ${chunksIndexed} section(s) from ${first.finalUrl}` +
        (skipped.length ? `; ${skipped.length} could not be read.` : '.'),
    };
  }

  /** One fetched resource → one knowledge document. HTML or PDF or text. */
  private async indexOnePage(
    organizationId: string,
    page: { finalUrl: string; contentType: string; buffer: Buffer }
  ): Promise<{ documentId: string; chunks: number }> {
    const isPdf = /application\/pdf/i.test(page.contentType);
    const isText = /text\/html|text\/plain|application\/xhtml|text\/markdown/i.test(page.contentType);
    if (!isPdf && !isText) {
      throw new BadRequestException(
        `${page.finalUrl} returned "${page.contentType || 'an unknown content type'}", which cannot be read as text.`
      );
    }

    let hostnameForTitle = page.finalUrl;
    try { hostnameForTitle = new URL(page.finalUrl).hostname; } catch {}

    if (isPdf) {
      // Handed to the SAME path an uploaded PDF takes, rather than a second
      // extractor here. `indexDocumentInline` cannot read a PDF and says so
      // ("PDF and DOCX extraction requires the background worker"), because
      // pdf-parse runs in the worker. Routing the bytes through
      // uploadAndIndexDocument stores the file and queues that worker, so a
      // crawled PDF is indexed exactly as an uploaded one is — one
      // implementation, which cannot drift from the other.
      const fileName = (() => {
        try {
          const path = new URL(page.finalUrl).pathname;
          return decodeURIComponent(path.split('/').pop() || 'document.pdf');
        } catch {
          return 'document.pdf';
        }
      })();
      const uploaded = await this.uploadAndIndexDocument(organizationId, {
        title: `${hostnameForTitle}: ${fileName}`,
        fileName,
        fileSize: page.buffer.byteLength,
        mimeType: 'application/pdf',
        fileBuffer: page.buffer,
      });
      // The worker finishes asynchronously, so chunks are not known yet. The
      // caller is told how many pages were taken, not a count invented here.
      return { documentId: (uploaded as any).documentId, chunks: (uploaded as any).chunksIndexed ?? 0 };
    }

    let body: Buffer;
    let mimeType: string;
    {
      const textContent = page.buffer
        .toString('utf-8')
        .replace(/<script\b[^<]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style\b[^<]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!textContent || textContent.length < 50) {
        throw new BadRequestException('No readable text content could be extracted.');
      }
      body = Buffer.from(textContent, 'utf-8');
      mimeType = 'text/plain';
    }

    const hostname = hostnameForTitle;
    const path = (() => { try { return new URL(page.finalUrl).pathname; } catch { return ''; } })();

    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId,
        // The path is in the title because a site indexed page by page
        // otherwise produces a list of identical rows.
        title: `Website: ${hostname}${path && path !== '/' ? path : ''}`,
        fileName: page.finalUrl,
        fileSize: body.byteLength,
        mimeType: 'text/html',
        storageUrl: page.finalUrl,
        status: 'PROCESSING',
      },
    });

    const { chunkCount } = await this.indexDocumentInline(organizationId, doc.id, body, mimeType);
    return { documentId: doc.id, chunks: chunkCount };
  }
}

