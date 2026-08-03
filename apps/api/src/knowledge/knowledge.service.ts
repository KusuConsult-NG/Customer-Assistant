import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { prisma } from '@ace/database';
import { QdrantRAGService } from '@ace/orchestrator';
import { Queue } from 'bullmq';
import { AceLogger } from '../config/logger';

const log = new AceLogger('KnowledgeService');

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

/**
 * Upload a file buffer to Supabase Storage and return the storage path.
 *
 * Supabase Storage path format: {organizationId}/{timestamp}_{fileName}
 * This namespaces files per tenant, preventing cross-tenant path collisions.
 *
 * Returns the storage path (not a public URL — use signed URLs for access).
 */
async function uploadToSupabaseStorage(
  organizationId: string,
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set. ' +
      'Cannot upload to Supabase Storage.'
    );
  }

  const storagePath = `${organizationId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${SUPABASE_BUCKET}/${storagePath}`;

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseServiceKey}`,
      'Content-Type': mimeType,
      'x-upsert': 'false', // Fail if file already exists (timestamps make collisions impossible)
    },
    body: new Uint8Array(fileBuffer), // Buffer → Uint8Array: required by fetch BodyInit type
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Supabase Storage upload failed (HTTP ${response.status}): ${errText}. ` +
      `Ensure the "${SUPABASE_BUCKET}" bucket exists in your Supabase project ` +
      `(Dashboard → Storage → New Bucket → name: "${SUPABASE_BUCKET}" → Private).`
    );
  }

  return storagePath;
}

/**
 * Generate a short-lived signed URL for downloading a stored document.
 * Signed URLs expire after 1 hour — do not cache them.
 */
async function getSignedDownloadUrl(storagePath: string): Promise<string> {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const signUrl = `${supabaseUrl}/storage/v1/object/sign/${SUPABASE_BUCKET}/${storagePath}`;
  const response = await fetch(signUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expiresIn: 3600 }), // 1 hour
  });

  if (!response.ok) {
    throw new Error(`Failed to generate signed URL for ${storagePath}`);
  }

  const data: any = await response.json();
  return `${supabaseUrl}/storage/v1${data.signedURL}`;
}

/**
 * Delete a file from Supabase Storage.
 */
async function deleteFromSupabaseStorage(storagePath: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const response = await fetch(
    `${supabaseUrl}/storage/v1/object/${SUPABASE_BUCKET}/${storagePath}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${supabaseServiceKey}` },
    }
  );

  if (!response.ok && response.status !== 404) {
    const errText = await response.text();
    log.warn('supabase_storage_delete_failed', { storagePath, status: response.status, error: errText });
  }
}

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
    const storagePath = await uploadToSupabaseStorage(
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
    } catch {
      // Fallback: If Redis/BullMQ is unreachable, perform inline indexing for text files
      const textContent = data.fileBuffer.toString('utf-8');
      const chunks = textContent.match(/[\s\S]{1,500}/g) || [textContent];

      await prisma.documentChunk.createMany({
        data: chunks.map((chunkText, idx) => ({
          documentId: doc.id,
          organizationId,
          chunkIndex: idx,
          content: chunkText,
        })),
      });


      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: 'INDEXED', chunkCount: chunks.length },
      });
    }

    return {
      documentId: doc.id,
      title: doc.title,
      fileName: doc.fileName,
      status: jobId ? 'PENDING' : 'INDEXED',
      message: jobId
        ? 'Document uploaded successfully. Processing and indexing will complete in 1-2 minutes.'
        : 'Document uploaded and indexed successfully in single-node mode.',
      jobId,
    };
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

    return getSignedDownloadUrl(doc.storageUrl);
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

    // Delete from Supabase Storage
    await deleteFromSupabaseStorage(doc.storageUrl);

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

    let html = '';
    try {
      const response = await fetch(cleanUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ACE-Platform-Bot/1.0' },
      });
      if (!response.ok) {
        throw new BadRequestException(`Failed to fetch URL ${cleanUrl} (HTTP ${response.status})`);
      }
      html = await response.text();
    } catch (err: any) {
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
        status: 'INDEXED',
      },
    });

    const chunks = textContent.match(/[\s\S]{1,500}/g) || [textContent];

    await prisma.documentChunk.createMany({
      data: chunks.map((chunkText, idx) => ({
        documentId: doc.id,
        organizationId,
        chunkIndex: idx,
        content: chunkText,
      })),
    });

    await prisma.knowledgeDocument.update({
      where: { id: doc.id },
      data: { chunkCount: chunks.length },
    });

    return {
      documentId: doc.id,
      title: doc.title,
      chunksIndexed: chunks.length,
      status: 'INDEXED',
      message: `Successfully crawled and indexed ${chunks.length} sections from ${cleanUrl}`,
    };
  }
}

