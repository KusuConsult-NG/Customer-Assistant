import { ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
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
 * Where uploaded files live. ONE driver per deployment, chosen explicitly.
 *
 *   supabase — SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (the Render deployment)
 *   local    — STORAGE_DIR, a PERMANENT directory on the server (the single
 *              VPS deployment: a mounted, backed-up volume)
 *   dev      — neither, outside production: ./uploads, for a developer's machine
 *   none     — neither, in production: uploads are REFUSED with the reason
 *
 * This used to fall back silently: a Supabase upload that failed was written
 * to the container's own disk instead and reported as stored — on Render that
 * disk is wiped by every deploy, so the file was lost with nothing saying so.
 * Its signed-URL fallback returned every file as `data:image/jpeg`, PDFs
 * included, and its last resort was `/api/public/selfie-asset/…`, a route that
 * never existed. Now a configured driver either works or says it did not.
 */
export type StorageDriver = 'supabase' | 'local' | 'dev' | 'none';

export function storageDriver(): StorageDriver {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) return 'supabase';
  if (process.env.STORAGE_DIR?.trim()) return 'local';
  return process.env.NODE_ENV === 'production' ? 'none' : 'dev';
}

function localRoot(): string {
  return path.resolve(process.env.STORAGE_DIR?.trim() || path.join(process.cwd(), 'uploads'));
}

function supabase(): { url: string; key: string } {
  return { url: process.env.SUPABASE_URL!.replace(/\/+$/, ''), key: process.env.SUPABASE_SERVICE_ROLE_KEY! };
}

function authHeaders(key: string): Record<string, string> {
  // Supabase Storage needs BOTH headers — with only the bearer token every
  // request fails with a misleading 400/403.
  return { Authorization: `Bearer ${key}`, apikey: key };
}

const NOT_CONFIGURED =
  'File storage is not set up on this deployment, so the file was not saved. Contact the State platform team.';

/** A bucket and path that cannot climb out of the storage root. */
export function safeObjectPath(bucket: string, storagePath: string): string | null {
  if (!BUCKETS.has(bucket)) return null;
  const parts = String(storagePath ?? '').split('/');
  if (parts.length < 2 || parts.some((p) => !p || p === '.' || p === '..' || !/^[A-Za-z0-9._-]+$/.test(p))) return null;
  const root = localRoot();
  const full = path.resolve(root, bucket, ...parts);
  return full.startsWith(path.join(root, bucket) + path.sep) ? full : null;
}

/** Uploads bytes and returns the storage path (never a URL). Throws if it was not stored. */
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

  if (driver === 'none') {
    log.error('storage_not_configured', new Error('Neither SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY nor STORAGE_DIR is set'));
    throw new ServiceUnavailableException(NOT_CONFIGURED);
  }

  if (driver === 'supabase') {
    const { url, key } = supabase();
    let detail = '';
    try {
      const response = await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, {
        method: 'POST',
        headers: { ...authHeaders(key), 'Content-Type': mimeType, 'x-upsert': 'false' },
        body: new Uint8Array(bytes),
      });
      if (response.ok) return storagePath;
      detail = `HTTP ${response.status} ${await response.text().catch(() => '')}`.trim();
    } catch (e: any) {
      detail = e?.message ?? String(e);
    }
    log.error('supabase_upload_failed', new Error(detail), { bucket });
    throw new ServiceUnavailableException('The file could not be saved to storage just now, so it was not uploaded. Please try again.');
  }

  // local / dev: a real directory. In `local` it is the server's permanent volume.
  const full = safeObjectPath(bucket, storagePath);
  if (!full) throw new ServiceUnavailableException('That file name cannot be stored.');
  try {
    // Owner and group only, whatever the process umask: these are citizens'
    // photographs, call recordings and agency documents.
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o750 });
    fs.writeFileSync(full, bytes, { mode: 0o640 });
    fs.writeFileSync(`${full}.meta.json`, JSON.stringify({ mimeType, fileName }), { mode: 0o640 });
    return storagePath;
  } catch (e: any) {
    log.error('local_storage_failed', e instanceof Error ? e : new Error(String(e)), { bucket });
    throw new ServiceUnavailableException('The file could not be saved to storage just now, so it was not uploaded. Please try again.');
  }
}

/** The stored bytes, for the ingestion worker. Throws with the reason. */
export async function downloadObject(bucket: string, storagePath: string): Promise<Buffer> {
  const driver = storageDriver();
  if (driver === 'none') throw new Error(NOT_CONFIGURED);
  if (driver === 'supabase') {
    const { url, key } = supabase();
    const res = await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, {
      headers: authHeaders(key),
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
  const full = safeObjectPath(bucket, storagePath);
  if (!full || !fs.existsSync(full)) throw new Error(`Stored file "${storagePath}" was not found in ${bucket}.`);
  return fs.readFileSync(full);
}

// ── Signed links for the local driver ─────────────────────────────────────
//
// A browser cannot read the server's disk, and the dashboard opens a file by
// URL (a download link, an <img>). So the API serves it at
// /api/storage/:bucket/:org/:file, and the link carries an expiry and an HMAC
// over bucket, path and expiry — exactly what Supabase's signed URLs give:
// short-lived, unguessable, no session needed to follow it.

function signingKey(): string {
  const key = process.env.STORAGE_SIGNING_KEY || process.env.JWT_SECRET;
  if (!key) throw new Error('STORAGE_SIGNING_KEY (or JWT_SECRET) is required to sign file links.');
  return key;
}

function signature(bucket: string, storagePath: string, expires: number): string {
  return createHmac('sha256', signingKey()).update(`${bucket}\n${storagePath}\n${expires}`).digest('base64url');
}

/** True only for an unexpired link signed by this deployment. */
export function verifyObjectLink(bucket: string, storagePath: string, expires: number, sig: string, now = Date.now()): boolean {
  if (!Number.isFinite(expires) || expires * 1000 < now || !sig) return false;
  const want = Buffer.from(signature(bucket, storagePath, expires));
  const got = Buffer.from(String(sig));
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The stored file and its type, for the serving route. Null when absent. */
export function readLocalObject(bucket: string, storagePath: string): { bytes: Buffer; mimeType: string } | null {
  const full = safeObjectPath(bucket, storagePath);
  if (!full || !fs.existsSync(full)) return null;
  let mimeType = 'application/octet-stream';
  try {
    mimeType = JSON.parse(fs.readFileSync(`${full}.meta.json`, 'utf8')).mimeType || mimeType;
  } catch {
    /* an object without its sidecar is still served, as a download */
  }
  return { bytes: fs.readFileSync(full), mimeType };
}

function apiBase(): string {
  // The same fallback the telephony paths keep (invariant 4).
  return (process.env.API_BASE_URL || process.env.API_URL || '').replace(/\/+$/, '');
}

/** Short-lived signed URL. Do not cache or persist the result. Throws if none can be made. */
export async function signedUrl(bucket: string, storagePath: string, expiresInSeconds = 300): Promise<string> {
  const driver = storageDriver();
  if (driver === 'none') throw new ServiceUnavailableException(NOT_CONFIGURED);

  if (driver === 'supabase') {
    const { url, key } = supabase();
    try {
      const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${storagePath}`, {
        method: 'POST',
        headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (response.ok) {
        const data: any = await response.json();
        return `${url}/storage/v1${data.signedURL}`;
      }
      log.warn('supabase_signed_url_refused', { status: response.status, bucket });
    } catch (e: any) {
      log.warn('supabase_signed_url_exception', { error: e?.message, bucket });
    }
    throw new ServiceUnavailableException('The file link could not be created just now. Please try again.');
  }

  if (!safeObjectPath(bucket, storagePath)) throw new ServiceUnavailableException('That file is not available.');
  const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const sig = signature(bucket, storagePath, expires);
  return `${apiBase()}/api/storage/${bucket}/${storagePath}?expires=${expires}&sig=${sig}`;
}

/** Deletes an object. A missing one is success — the goal state is "gone". */
export async function deleteObject(bucket: string, storagePath: string): Promise<void> {
  const driver = storageDriver();
  if (driver === 'supabase') {
    const { url, key } = supabase();
    try {
      await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, { method: 'DELETE', headers: authHeaders(key) });
    } catch (err: any) {
      log.warn('storage_delete_failed', { bucket, storagePath, error: err?.message });
    }
    return;
  }
  const full = safeObjectPath(bucket, storagePath);
  if (!full) return;
  for (const f of [full, `${full}.meta.json`]) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {
      /* best effort, as before */
    }
  }
}
