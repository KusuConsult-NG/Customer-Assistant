import { AceLogger } from '../config/logger';

const log = new AceLogger('ObjectStorage');

/**
 * Supabase Storage access.
 *
 * Every path is namespaced by organizationId, and nothing is ever served from a
 * public URL — callers mint a short-lived signed URL at the moment of access. That
 * matters more for selfies than for knowledge documents: a public object URL for a
 * customer's face is permanent, unauthenticated, and un-revocable once it leaks.
 */

export const KNOWLEDGE_BUCKET = 'knowledge-documents';
export const SELFIE_BUCKET = 'onboarding-selfies';

/**
 * Supabase Storage requires BOTH the bearer token and an `apikey` header.
 *
 * With Authorization alone it answers `403 {"message":"Invalid Compact JWS"}` — wrapped
 * by Storage in an HTTP 400, which reads like a malformed request rather than an auth
 * problem. Every upload failed this way, silently, because nothing ever exercised a
 * real upload end to end.
 */
function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

function credentials(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set, so object storage is unavailable. ' +
      'Set both in the API environment.'
    );
  }
  return { url, key };
}

/** Uploads bytes and returns the storage path (never a URL). */
export async function uploadObject(
  bucket: string,
  organizationId: string,
  fileName: string,
  bytes: Buffer,
  mimeType: string
): Promise<string> {
  const { url, key } = credentials();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${organizationId}/${Date.now()}_${safeName}`;

  const response = await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, {
    method: 'POST',
    headers: {
      ...authHeaders(key),
      'Content-Type': mimeType,
      'x-upsert': 'false',
    },
    body: new Uint8Array(bytes),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `Storage upload failed (HTTP ${response.status}): ${errText}. ` +
      `Ensure the "${bucket}" bucket exists in Supabase (Dashboard → Storage → New Bucket → Private).`
    );
  }

  return storagePath;
}

/** Short-lived signed URL. Do not cache or persist the result. */
export async function signedUrl(bucket: string, storagePath: string, expiresInSeconds = 300): Promise<string> {
  const { url, key } = credentials();

  const response = await fetch(`${url}/storage/v1/object/sign/${bucket}/${storagePath}`, {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: expiresInSeconds }),
  });

  if (!response.ok) {
    throw new Error(`Failed to generate a signed URL for ${storagePath} (HTTP ${response.status}).`);
  }

  const data: any = await response.json();
  return `${url}/storage/v1${data.signedURL}`;
}

/** Deletes an object. A 404 is treated as success — the goal state is "gone". */
export async function deleteObject(bucket: string, storagePath: string): Promise<void> {
  const { url, key } = credentials();

  const response = await fetch(`${url}/storage/v1/object/${bucket}/${storagePath}`, {
    method: 'DELETE',
    headers: authHeaders(key),
  });

  if (!response.ok && response.status !== 404) {
    const errText = await response.text();
    log.warn('storage_delete_failed', { bucket, storagePath, status: response.status, error: errText });
  }
}
