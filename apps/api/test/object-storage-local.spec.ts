/**
 * The single-server storage driver, exercised for real against a temp
 * directory and the real serving route. Supabase is left unset on purpose.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import {
  KNOWLEDGE_BUCKET,
  SELFIE_BUCKET,
  deleteObject,
  downloadObject,
  safeObjectPath,
  signedUrl,
  storageDriver,
  uploadObject,
  verifyObjectLink,
} from '../src/common/object-storage';
import { StorageModule } from '../src/storage/storage.controller';

const saved = { ...process.env };
let dir: string;
let app: INestApplication;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-storage-'));
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.env.STORAGE_DIR = dir;
  process.env.API_BASE_URL = 'https://contact.example.gov.ng';
  process.env.STORAGE_SIGNING_KEY = 'test-signing-key-0123456789abcdef';
  const mod = await Test.createTestingModule({ imports: [StorageModule] }).compile();
  app = mod.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
  process.env = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('local storage driver', () => {
  it('is chosen by STORAGE_DIR, and production with nothing set refuses', async () => {
    expect(storageDriver()).toBe('local');
    const keep = process.env.STORAGE_DIR;
    const env = process.env.NODE_ENV;
    delete process.env.STORAGE_DIR;
    process.env.NODE_ENV = 'production';
    try {
      expect(storageDriver()).toBe('none');
      await expect(uploadObject(KNOWLEDGE_BUCKET, 'org1', 'a.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow(
        /not set up/
      );
      await expect(signedUrl(KNOWLEDGE_BUCKET, 'org1/1_a.pdf')).rejects.toThrow(/not set up/);
    } finally {
      process.env.STORAGE_DIR = keep;
      process.env.NODE_ENV = env;
    }
  });

  it('stores, reads back, serves through a signed link, and deletes', async () => {
    const bytes = Buffer.from('%PDF-1.4 minutes of the meeting');
    const stored = await uploadObject(KNOWLEDGE_BUCKET, 'org-abc', 'Minutes (final).pdf', bytes, 'application/pdf');
    expect(stored).toMatch(/^org-abc\/\d+_Minutes__final_\.pdf$/);
    expect(fs.existsSync(path.join(dir, KNOWLEDGE_BUCKET, stored))).toBe(true);
    expect((await downloadObject(KNOWLEDGE_BUCKET, stored)).equals(bytes)).toBe(true);

    const url = await signedUrl(KNOWLEDGE_BUCKET, stored, 60);
    expect(url.startsWith(`https://contact.example.gov.ng/api/storage/${KNOWLEDGE_BUCKET}/${stored}?expires=`)).toBe(true);
    const local = url.replace('https://contact.example.gov.ng', '');
    const res = await request(app.getHttpServer()).get(local).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.from(res.body).equals(bytes)).toBe(true);

    await deleteObject(KNOWLEDGE_BUCKET, stored);
    expect(fs.existsSync(path.join(dir, KNOWLEDGE_BUCKET, stored))).toBe(false);
    expect((await request(app.getHttpServer()).get(local)).status).toBe(404);
  });

  it('refuses a tampered, expired or cross-bucket link', async () => {
    const stored = await uploadObject(SELFIE_BUCKET, 'org-abc', 'face.jpg', Buffer.from([0xff, 0xd8, 0xff, 1, 2]), 'image/jpeg');
    const url = new URL(await signedUrl(SELFIE_BUCKET, stored, 60));
    const sig = url.searchParams.get('sig')!;
    const expires = Number(url.searchParams.get('expires'));

    const tampered = `${url.pathname}?expires=${expires}&sig=${sig.slice(0, -2)}AA`;
    expect((await request(app.getHttpServer()).get(tampered)).status).toBe(403);

    const later = `${url.pathname}?expires=${expires + 3600}&sig=${sig}`;
    expect((await request(app.getHttpServer()).get(later)).status).toBe(403);

    // The same signature does not open the same path in the other bucket.
    expect(verifyObjectLink(KNOWLEDGE_BUCKET, stored, expires, sig)).toBe(false);
    // Nor once it has expired.
    expect(verifyObjectLink(SELFIE_BUCKET, stored, expires, sig, (expires + 1) * 1000)).toBe(false);
    expect(verifyObjectLink(SELFIE_BUCKET, stored, expires, sig)).toBe(true);
  });

  it('cannot be walked out of the storage directory', async () => {
    for (const p of ['../etc/passwd', 'org/../../x', 'org/..', '/etc/passwd', 'org', 'org//x', 'org/x y']) {
      expect(safeObjectPath(KNOWLEDGE_BUCKET, p)).toBeNull();
    }
    expect(safeObjectPath('another-bucket', 'org/x.pdf')).toBeNull();
    const res = await request(app.getHttpServer()).get(`/api/storage/${KNOWLEDGE_BUCKET}/..%2F..%2Fetc/passwd?expires=9999999999&sig=x`);
    expect([403, 404]).toContain(res.status);
    await expect(downloadObject(KNOWLEDGE_BUCKET, '../../etc/passwd')).rejects.toThrow(/not found/);
  });
});
