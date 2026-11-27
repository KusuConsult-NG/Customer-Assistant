import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AceLogger } from '../config/logger';

const log = new AceLogger('ObjectStorage');

export const KNOWLEDGE_BUCKET = 'knowledge-documents';
export const SELFIE_BUCKET = 'onboarding-selfies';
/** Audio of calls answered by the server's own voice pipeline (voice-local). */
export const CALL_RECORDING_BUCKET = 'call-recordings';
const BUCKETS = new Set([KNOWLEDGE_BUCKET, SELFIE_BUCKET, CALL_RECORDING_BUCKET]);

/**
 * Where uploaded files live — ONE decision, made from configuration.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * A failed Supabase upload fell back, with a warning, to a folder inside the
 * container. Every upload then LOOKED stored: the row was written, the
 * officer saw it in the list. But a container's disk is wiped on every
 * redeploy, so the file was gone at the next release, and nothing anywhere
 * said that the upload had never reached real storage. Reading it back had
 * the same habit: a local copy came back as a `data:image/jpeg` link
 * whatever the file was (a PDF, a Word document), and a missing one as a link
 * to `/api/public/selfie-asset/…`, a route that does not exist.
 *
 * ── What it is now ──────────────────────────────────────────────────────────
 *
 *  - `supabase` when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set. A
 *    refused upload is an error the caller sees, never a quiet local copy.
 *  - `local` when STORAGE_DIR is set: files on a disk that persists (on the
 *    single server, a Docker volume that is backed up nightly). They are read
 *    through `GET /api/files/…` with a link that expires and is signed, so a
 *    link cannot be guessed, reused later or altered to reach another file.
 *  - Outside production with neither, `local` in ./uploads, for development.
 *  - In PRODUCTION with neither, uploads are REFUSED with the reason. Writing
 *    to a disk that does not survive a redeploy is how files were being lost.
 */
export type StorageDriver = 'supabase' | 'local' | 'none';

export function storageDriver(): StorageDriver {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return 'supabase';
  if (process.env.STORAGE_DIR?.trim()) return 'local';
  return process.env.NODE_ENV === 'production' ? 'none' : 'local';
}

/** The directory the local driver writes to. */
export function storageRoot(): string {
  return path.resolve(process.env.STORAGE_DIR?.trim() || path.join(process.cwd(), 'uploads'));
}

const NOT_CONFIGURED =
  'File storage is not configured on this server, so the file was not saved. ' +
  'Set STORAGE_DIR (a persistent directory) or SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.';

function supabase(): { url: string; key: string } {
  return { url: process.env.SUPABASE_URL!.replace(/\/+$/, ''), key: process.env.SUPABASE_SERVICE_ROLE_KEY! };
}

/** Supabase Storage needs BOTH headers; with only the bearer every request fails 400/403. */
function supabaseHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

/**
 * The file a bucket path names, refusing anything that would leave the bucket
 * (`..`, an absolute path, a NUL). Paths are written by this module
 * (`<organizationId>/<time>_<safe name>`), but a read takes one from a URL.
 */
function localFile(bucket: string, storagePath: string): string {
  if (!BUCKETS.has(bucket)) throw new NotFoundException('No such file.');
  // Every segment a plain name: what this module writes is
  // `<organizationId>/<time>_<safe name>`, so anything else (`..`, an empty
  // segment, a NUL, a character outside the safe set) is refused before the
  // resolved-path check below, not only by it.
  const parts = String(storagePath ?? '').split('/');
  if (
    !storagePath ||
    path.isAbsolute(storagePath) ||
    parts.length < 2 ||
    parts.some((p) => !p || p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))
  ) {
    throw new BadRequestException('Invalid file path.');
  }
  const root = path.join(storageRoot(), bucket);
  const file = path.resolve(root, storagePath);
  if (!file.startsWith(root + path.sep)) throw new BadRequestException('Invalid file path.');
  return file;
}

interface LocalMeta {
  contentType: string;
  fileName: string;
}

const metaPath = (file: string) => `${file}.meta.json`;

/** Uploads bytes and returns the storage path (never a URL). */
export async function uploadObject(
  bucket: string,
  organizationId: string,
  fileName: string,
  bytes: Buffer,
  mimeType: string
): Promise<string> {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${organizationId}/${Date.now()}_${safeName}`;
  const driver = storageDriver();

  if (driver === 'none') throw new ServiceUnavailableException(NOT_CONFIGURED);

  if (driver === 'supabase') {
    const { url, key } = supabase();
    let response: Response;
    try {
      response = await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, {
        method: 'POST',
        headers: { ...supabaseHeaders(key), 'Content-Type': mimeType, 'x-upsert': 'false' },
        body: new Uint8Array(bytes),
      });
    } catch (e: any) {
      log.error('supabase_upload_unreachable', e instanceof Error ? e : new Error(String(e)));
      throw new ServiceUnavailableException('The file could not be stored: file storage could not be reached.');
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      log.warn('supabase_upload_refused', { status: response.status, error: detail.slice(0, 300) });
      throw new ServiceUnavailableException(`The file could not be stored: file storage refused it (HTTP ${response.status}).`);
    }
    return storagePath;
  }

  try {
    writeLocalObject(bucket, storagePath, bytes, mimeType, safeName);
  } catch (e: any) {
    if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
    log.error('local_storage_write_failed', e instanceof Error ? e : new Error(String(e)));
    throw new ServiceUnavailableException('The file could not be stored: the server could not write it to disk.');
  }
  return storagePath;
}

/**
 * Writes one object in the local layout: `<STORAGE_DIR>/<bucket>/<path>` plus
 * a `.meta.json` beside it with its type and name. Exported for the migration
 * script (scripts/copy-supabase-storage.js), so files copied from Supabase are
 * laid out exactly as the API lays out its own — one definition, not two.
 */
export function writeLocalObject(
  bucket: string,
  storagePath: string,
  bytes: Buffer,
  mimeType: string,
  fileName = path.basename(storagePath).replace(/^\d+_/, '')
): string {
  const file = localFile(bucket, storagePath);
  // Owner and group only, whatever the process umask: these are citizens'
  // photographs, call recordings and agency documents.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o750 });
  fs.writeFileSync(file, bytes, { mode: 0o640 });
  const meta: LocalMeta = { contentType: mimeType || 'application/octet-stream', fileName };
  fs.writeFileSync(metaPath(file), JSON.stringify(meta), { mode: 0o640 });
  return file;
}

/** Whether a local object exists, and its size — for idempotent copies. */
export function localObjectSize(bucket: string, storagePath: string): number | null {
  const file = localFile(bucket, storagePath);
  return fs.existsSync(file) ? fs.statSync(file).size : null;
}

/** The stored bytes, wherever they are. Used by the document worker. */
export async function downloadObject(bucket: string, storagePath: string): Promise<Buffer> {
  const driver = storageDriver();
  if (driver === 'none') throw new Error(NOT_CONFIGURED);

  if (driver === 'supabase') {
    const { url, key } = supabase();
    const res = await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, {
      headers: supabaseHeaders(key),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to download "${storagePath}" from Supabase Storage (HTTP ${res.status}). ` +
          `Confirm the "${bucket}" bucket exists and the service-role key is valid.`
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  const file = localFile(bucket, storagePath);
  if (!fs.existsSync(file)) throw new Error(`Stored file "${storagePath}" is missing from ${bucket} on this server.`);
  return fs.readFileSync(file);
}

// ── Signed links for the local driver ─────────────────────────────────────────

/** Longest a link may live, whatever a caller asks for. */
const MAX_LINK_SECONDS = 24 * 60 * 60;

/**
 * The key links are signed with. Derived from JWT_SECRET (which every
 * deployment already has, and has to keep secret) rather than used as is, so
 * a link signature can never be confused with a token signature.
 */
function linkKey(): Buffer {
  const secret = process.env.STORAGE_LINK_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required to sign file links.');
  return createHash('sha256').update(`file-links:${secret}`).digest();
}

function linkSignature(bucket: string, storagePath: string, expires: number): string {
  return createHmac('sha256', linkKey()).update(`${bucket}\n${storagePath}\n${expires}`).digest('base64url');
}

/**
 * The public address of the API, so a link works whether or not the dashboard
 * shares its host. Unset in production the link is relative, which is right on
 * the single server: the dashboard and the API share one origin there.
 */
function publicBase(): string {
  const configured = process.env.API_BASE_URL || process.env.API_URL;
  if (configured) return configured.replace(/\/+$/, '');
  return process.env.NODE_ENV === 'production' ? '' : `http://localhost:${process.env.PORT || 4000}`;
}

/** Short-lived signed URL. Do not cache or persist the result. */
export async function signedUrl(bucket: string, storagePath: string, expiresInSeconds = 300): Promise<string> {
  const driver = storageDriver();
  if (driver === 'none') throw new ServiceUnavailableException(NOT_CONFIGURED);

  if (driver === 'supabase') {
    const { url, key } = supabase();
    const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${storagePath}`, {
      method: 'POST',
      headers: { ...supabaseHeaders(key), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    }).catch((e: any) => {
      log.warn('supabase_signed_url_unreachable', { error: e?.message });
      return null;
    });
    if (!response?.ok) {
      throw new ServiceUnavailableException(
        response ? `File storage refused the download link (HTTP ${response.status}).` : 'File storage could not be reached.'
      );
    }
    const data: any = await response.json();
    return `${url}/storage/v1${data.signedURL}`;
  }

  const file = localFile(bucket, storagePath);
  if (!fs.existsSync(file)) throw new NotFoundException('That file is no longer stored on this server.');
  const seconds = Math.min(Math.max(1, Math.floor(expiresInSeconds)), MAX_LINK_SECONDS);
  const expires = Math.floor(Date.now() / 1000) + seconds;
  const encodedPath = storagePath.split('/').map(encodeURIComponent).join('/');
  return `${publicBase()}/api/files/${bucket}/${encodedPath}?expires=${expires}&sig=${linkSignature(bucket, storagePath, expires)}`;
}

/**
 * Checks a link and returns the file it names, or throws. The link is the
 * only credential: a wrong signature, a path changed after signing and an
 * expired link are all refused the same way, saying nothing about which.
 */
export function openSignedFile(
  bucket: string,
  storagePath: string,
  expires: string | undefined,
  sig: string | undefined
): { file: string; contentType: string; fileName: string } {
  const refused = new NotFoundException('This link has expired or is not valid. Open the file again from the dashboard.');
  const exp = Number(expires);
  if (!sig || !Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) throw refused;
  if (!BUCKETS.has(bucket)) throw refused;
  const expected = Buffer.from(linkSignature(bucket, storagePath, exp));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw refused;

  const file = localFile(bucket, storagePath);
  if (!fs.existsSync(file)) throw new NotFoundException('That file is no longer stored on this server.');
  let meta: LocalMeta = { contentType: 'application/octet-stream', fileName: path.basename(file) };
  try {
    meta = { ...meta, ...JSON.parse(fs.readFileSync(metaPath(file), 'utf8')) };
  } catch {
    // A file without its sidecar is still served, as a download.
  }
  return { file, contentType: meta.contentType, fileName: meta.fileName };
}

/** Deletes an object. A missing object is success — the goal state is "gone". */
export async function deleteObject(bucket: string, storagePath: string): Promise<void> {
  const driver = storageDriver();
  if (driver === 'none') return;

  if (driver === 'supabase') {
    const { url, key } = supabase();
    try {
      await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, { method: 'DELETE', headers: supabaseHeaders(key) });
    } catch (err: any) {
      log.warn('storage_delete_failed', { bucket, storagePath, error: err?.message });
    }
    return;
  }

  const file = localFile(bucket, storagePath);
  for (const f of [file, metaPath(file)]) {
    try {
      fs.unlinkSync(f);
    } catch (e: any) {
      if (e?.code !== 'ENOENT') log.warn('storage_delete_failed', { bucket, storagePath, error: e?.message });
    }
  }
}
