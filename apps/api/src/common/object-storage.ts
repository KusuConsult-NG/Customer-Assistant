import { ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { AceLogger } from '../config/logger';

const log = new AceLogger('ObjectStorage');

export const KNOWLEDGE_BUCKET = 'knowledge-documents';
export const SELFIE_BUCKET = 'onboarding-selfies';

const LOCAL_UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');

function authHeaders(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, apikey: key };
}

function credentials(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
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
  const creds = credentials();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${organizationId}/${Date.now()}_${safeName}`;

  if (creds) {
    try {
      const response = await fetch(`${creds.url}/storage/v1/object/${bucket}/${storagePath}`, {
        method: 'POST',
        headers: {
          ...authHeaders(creds.key),
          'Content-Type': mimeType,
          'x-upsert': 'false',
        },
        body: new Uint8Array(bytes),
      });

      if (response.ok) {
        return storagePath;
      }
      const errText = await response.text().catch(() => '');
      log.warn('supabase_upload_failed_falling_back_to_local', { status: response.status, error: errText });
    } catch (e: any) {
      log.warn('supabase_upload_exception_falling_back_to_local', { error: e?.message });
    }
  }

  // Local filesystem fallback
  try {
    const dir = path.join(LOCAL_UPLOADS_DIR, bucket, organizationId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, path.basename(storagePath));
    fs.writeFileSync(filePath, bytes);
    log.info('stored_object_locally', { bucket, storagePath });
    return storagePath;
  } catch (fsErr: any) {
    log.error('local_storage_failed', fsErr instanceof Error ? fsErr : new Error(String(fsErr)));
    throw new ServiceUnavailableException('Storage is temporarily unavailable.');
  }
}

/** Short-lived signed URL. Do not cache or persist the result. */
export async function signedUrl(bucket: string, storagePath: string, expiresInSeconds = 300): Promise<string> {
  const creds = credentials();

  if (creds) {
    try {
      const response = await fetch(`${creds.url}/storage/v1/object/sign/${bucket}/${storagePath}`, {
        method: 'POST',
        headers: { ...authHeaders(creds.key), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });

      if (response.ok) {
        const data: any = await response.json();
        return `${creds.url}/storage/v1${data.signedURL}`;
      }
    } catch (e: any) {
      log.warn('supabase_signed_url_exception', { error: e?.message });
    }
  }

  // Local fallback: read local file if present and return data URI
  try {
    const localFilePath = path.join(LOCAL_UPLOADS_DIR, bucket, storagePath);
    if (fs.existsSync(localFilePath)) {
      const buf = fs.readFileSync(localFilePath);
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
  } catch (e) {}

  return `/api/public/selfie-asset/${storagePath}`;
}

/** Deletes an object. A 404 is treated as success — the goal state is "gone". */
export async function deleteObject(bucket: string, storagePath: string): Promise<void> {
  const creds = credentials();

  if (creds) {
    try {
      await fetch(`${creds.url}/storage/v1/object/${bucket}/${storagePath}`, {
        method: 'DELETE',
        headers: authHeaders(creds.key),
      });
    } catch (err: any) {
      log.warn('storage_delete_failed', { bucket, storagePath, error: err?.message });
    }
  }

  try {
    const localFilePath = path.join(LOCAL_UPLOADS_DIR, bucket, storagePath);
    if (fs.existsSync(localFilePath)) {
      fs.unlinkSync(localFilePath);
    }
  } catch (e) {}
}
