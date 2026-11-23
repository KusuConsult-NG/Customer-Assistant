/**
 * Files kept on the server's own disk, read back through signed links.
 *
 * A failed Supabase upload used to fall back, quietly, to a folder inside the
 * container — wiped at every redeploy — and read back as a `data:image/jpeg`
 * link whatever the file was, or a link to a route that did not exist. On the
 * single server files live on a persistent volume (STORAGE_DIR) and are read
 * through `GET /api/files/…` with an expiring, signed link.
 *
 * These drive the real module and the real routes; nothing is mocked except
 * Supabase, which is made to refuse.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, type TestTenant } from './support/tenant';
import {
  CALL_RECORDING_BUCKET,
  KNOWLEDGE_BUCKET,
  SELFIE_BUCKET,
  downloadObject,
  signedUrl,
  storageDriver,
  uploadObject,
} from '../src/common/object-storage';
import { ProviderHealthService } from '../src/diagnostics/provider-health.service';

const saved: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined) {
  if (!(key in saved)) saved[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Every file under a directory, recursively. */
function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [path.join(dir, e.name)]
  );
}

/** The path-and-query part of a signed link, for supertest. */
const pathOf = (url: string) => {
  const u = new URL(url, 'http://localhost');
  return `${u.pathname}${u.search}`;
};

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

describe('Files kept on this server', () => {
  let app: INestApplication;
  let owner: TestTenant;
  let dir: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-storage-'));
    setEnv('SUPABASE_URL', undefined);
    setEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    setEnv('STORAGE_DIR', dir);
    setEnv('API_BASE_URL', 'https://care.example.gov.ng');
    app = await createTestApp();
    owner = await createTenant(app, 'files', { role: 'OWNER' });
  }, 60_000);

  afterAll(async () => {
    await prisma.knowledgeDocument.deleteMany({ where: { organizationId: owner?.orgId } }).catch(() => {});
    await dropTenant(owner?.orgId);
    await app?.close();
    restoreEnv();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  afterEach(() => {
    // Each test leaves the storage env as beforeAll set it.
    setEnv('SUPABASE_URL', undefined);
    setEnv('SUPABASE_SERVICE_ROLE_KEY', undefined);
    setEnv('STORAGE_DIR', dir);
    setEnv('NODE_ENV', saved.NODE_ENV);
    jest.restoreAllMocks();
  });

  it('an uploaded document is written to STORAGE_DIR and downloads through its signed link', async () => {
    const text = `Ward offices open at 8am. ${Date.now()}`;
    const up = await request(app.getHttpServer())
      .post('/api/knowledge/documents')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        title: 'Ward office hours',
        fileName: 'ward hours.txt',
        fileSize: text.length,
        mimeType: 'text/plain',
        fileBufferBase64: Buffer.from(text).toString('base64'),
      });
    // Indexing may or may not succeed here (it needs an embedding provider);
    // what this is about is where the FILE went.
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { organizationId: owner.orgId, title: 'Ward office hours' },
    });
    expect(doc).toBeTruthy();
    expect([201, 503]).toContain(up.status);

    const onDisk = path.join(dir, KNOWLEDGE_BUCKET, doc!.storageUrl);
    expect(fs.readFileSync(onDisk, 'utf8')).toBe(text);

    const link = await request(app.getHttpServer())
      .get(`/api/knowledge/documents/${doc!.id}/download`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);
    // An address the officer's browser can open, on the API's public host.
    expect(link.body.url).toMatch(/^https:\/\/care\.example\.gov\.ng\/api\/files\/knowledge-documents\//);
    expect(link.body.url).not.toMatch(/^data:|selfie-asset/);

    const file = await request(app.getHttpServer()).get(pathOf(link.body.url)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect((file.body as Buffer).toString('utf8')).toBe(text);
    // Not rendered from the API's origin: a download, and the type is not guessed.
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="ward_hours\.txt"/);
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toMatch(/no-store/);

    // The worker reads it back through the same module.
    expect((await downloadObject(KNOWLEDGE_BUCKET, doc!.storageUrl)).toString('utf8')).toBe(text);

    // Deleting the document removes the file and its sidecar.
    const del = await request(app.getHttpServer())
      .delete(`/api/knowledge/documents/${doc!.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(del.status).toBe(200);
    expect(await prisma.knowledgeDocument.findUnique({ where: { id: doc!.id } })).toBeNull();
    expect(fs.existsSync(onDisk)).toBe(false);
    expect(fs.existsSync(`${onDisk}.meta.json`)).toBe(false);
  });

  it('a selfie is shown inline, and can be embedded by a dashboard on another origin', async () => {
    const storagePath = await uploadObject(SELFIE_BUCKET, owner.orgId, 'selfie_x.png', PNG, 'image/png');
    const url = await signedUrl(SELFIE_BUCKET, storagePath, 300);
    const res = await request(app.getHttpServer()).get(pathOf(url)).expect(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  describe('a link is the only credential, so it is refused once altered', () => {
    let good: string;
    let storagePath: string;
    let otherPath: string;
    beforeAll(async () => {
      storagePath = await uploadObject(KNOWLEDGE_BUCKET, owner.orgId, 'secret.txt', Buffer.from('secret'), 'text/plain');
      otherPath = await uploadObject(KNOWLEDGE_BUCKET, owner.orgId, 'other.txt', Buffer.from('other'), 'text/plain');
      // The same path in the other bucket, so a refusal there can only be the signature.
      fs.mkdirSync(path.dirname(path.join(dir, SELFIE_BUCKET, storagePath)), { recursive: true });
      fs.writeFileSync(path.join(dir, SELFIE_BUCKET, storagePath), 'selfie-bucket copy');
      good = pathOf(await signedUrl(KNOWLEDGE_BUCKET, storagePath, 300));
    });

    it('works as minted', async () => {
      await request(app.getHttpServer()).get(good).expect(200);
    });

    it('a wrong signature', async () => {
      const bad = good.replace(/sig=([^&]+)/, (_m, s: string) => `sig=${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`);
      const res = await request(app.getHttpServer()).get(bad).expect(404);
      expect(res.text).not.toContain('secret');
    });

    it('no signature', async () => {
      await request(app.getHttpServer()).get(good.replace(/&sig=[^&]+/, '')).expect(404);
    });

    it('a later expiry than was signed', async () => {
      const later = good.replace(/expires=(\d+)/, (_m, e: string) => `expires=${Number(e) + 3600}`);
      await request(app.getHttpServer()).get(later).expect(404);
    });

    it('another file under the same signature', async () => {
      // A file that EXISTS, so the refusal can only be the signature.
      const other = good.replace(storagePath, otherPath);
      expect(other).not.toBe(good);
      const res = await request(app.getHttpServer()).get(other).expect(404);
      expect(res.text).not.toContain('other');
      await request(app.getHttpServer()).get(pathOf(await signedUrl(KNOWLEDGE_BUCKET, otherPath, 300))).expect(200);
    });

    it('the same file in the other bucket', async () => {
      const res = await request(app.getHttpServer()).get(good.replace(KNOWLEDGE_BUCKET, SELFIE_BUCKET)).expect(404);
      expect(res.text).not.toContain('selfie-bucket copy');
    });

    it('an expired link', async () => {
      const shortLived = pathOf(await signedUrl(KNOWLEDGE_BUCKET, storagePath, 1));
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000);
      await request(app.getHttpServer()).get(shortLived).expect(404);
    });

    it('a path that climbs out of the bucket, even if signed', async () => {
      // A signature does not make a traversal acceptable: the path is checked
      // independently of who signed it.
      fs.writeFileSync(path.join(dir, 'outside.txt'), 'outside');
      await expect(signedUrl(KNOWLEDGE_BUCKET, '../outside.txt', 300)).rejects.toThrow(/Invalid file path/);
      const res = await request(app.getHttpServer()).get(
        `/api/files/${KNOWLEDGE_BUCKET}/..%2Foutside.txt?expires=${Math.floor(Date.now() / 1000) + 60}&sig=x`
      );
      expect([400, 404]).toContain(res.status);
      expect(res.text).not.toContain('outside');
    });
  });

  // Carried over from the single-VPS branch's own storage test when the two
  // storage drivers became one.
  describe('what the server keeps on its disk', () => {
    it('is readable by the app’s own user and group only, whatever the umask', async () => {
      const prior = process.umask(0);
      try {
        const stored = await uploadObject(KNOWLEDGE_BUCKET, owner.orgId, 'perm.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
        const file = path.join(dir, KNOWLEDGE_BUCKET, stored);
        expect(fs.statSync(file).mode & 0o777).toBe(0o640);
        expect(fs.statSync(`${file}.meta.json`).mode & 0o777).toBe(0o640);
        expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o750);
      } finally {
        process.umask(prior);
      }
    });

    it('names a stored file safely, under its agency', async () => {
      const stored = await uploadObject(KNOWLEDGE_BUCKET, 'org-abc', 'Minutes (final).pdf', Buffer.from('x'), 'application/pdf');
      expect(stored).toMatch(/^org-abc\/\d+_Minutes__final_\.pdf$/);
    });

    it('keeps the voice line’s call recordings in their own bucket', async () => {
      const audio = Buffer.from('RIFF....WAVEfmt ');
      const stored = await uploadObject(CALL_RECORDING_BUCKET, owner.orgId, 'call-uuid.wav', audio, 'audio/wav');
      expect(fs.existsSync(path.join(dir, CALL_RECORDING_BUCKET, stored))).toBe(true);
      expect((await downloadObject(CALL_RECORDING_BUCKET, stored)).equals(audio)).toBe(true);
    });

    it('cannot be walked out of the storage directory, or into an unknown bucket', async () => {
      for (const p of ['../etc/passwd', 'org/../../x', 'org/..', '/etc/passwd', 'org', 'org//x', 'org/x y']) {
        await expect(downloadObject(KNOWLEDGE_BUCKET, p)).rejects.toThrow(/Invalid file path/);
        await expect(signedUrl(KNOWLEDGE_BUCKET, p, 60)).rejects.toThrow(/Invalid file path/);
      }
      await expect(signedUrl('another-bucket', 'org/x.pdf', 60)).rejects.toThrow(/No such file/);
    });
  });

  describe('no silent fallback', () => {
    it('a Supabase refusal is an error, and nothing is written to disk instead', async () => {
      setEnv('SUPABASE_URL', 'https://proj.supabase.co');
      setEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_service_role_000000000');
      const before = filesUnder(dir).length + filesUnder(path.join(process.cwd(), 'uploads')).length;
      jest.spyOn(global, 'fetch').mockResolvedValue(new Response('{"error":"Bucket not found"}', { status: 400 }));

      await expect(uploadObject(KNOWLEDGE_BUCKET, owner.orgId, 'a.txt', Buffer.from('a'), 'text/plain')).rejects.toThrow(
        /could not be stored: file storage refused it \(HTTP 400\)/
      );
      expect(filesUnder(dir).length + filesUnder(path.join(process.cwd(), 'uploads')).length).toBe(before);
    });

    it('an unreachable Supabase is an error too', async () => {
      setEnv('SUPABASE_URL', 'https://proj.supabase.co');
      setEnv('SUPABASE_SERVICE_ROLE_KEY', 'sb_service_role_000000000');
      jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      await expect(uploadObject(KNOWLEDGE_BUCKET, owner.orgId, 'a.txt', Buffer.from('a'), 'text/plain')).rejects.toThrow(
        /could not be reached/
      );
    });

    it('in production with no storage configured, an upload is refused with the reason', async () => {
      setEnv('STORAGE_DIR', undefined);
      setEnv('NODE_ENV', 'production');
      expect(storageDriver()).toBe('none');
      await expect(uploadObject(KNOWLEDGE_BUCKET, owner.orgId, 'a.txt', Buffer.from('a'), 'text/plain')).rejects.toThrow(
        /File storage is not configured on this server/
      );
      await expect(signedUrl(KNOWLEDGE_BUCKET, `${owner.orgId}/1_a.txt`, 60)).rejects.toThrow(/not configured/);
    });

    it('the same refusal reaches the officer through the upload endpoint', async () => {
      setEnv('STORAGE_DIR', undefined);
      setEnv('NODE_ENV', 'production');
      const res = await request(app.getHttpServer())
        .post('/api/knowledge/documents')
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ title: 'Refused', fileName: 'r.txt', fileSize: 1, mimeType: 'text/plain', fileBufferBase64: Buffer.from('r').toString('base64') });
      expect(res.status).toBe(503);
      // No row for a file that was never stored.
      expect(await prisma.knowledgeDocument.count({ where: { organizationId: owner.orgId, title: 'Refused' } })).toBe(0);
    });
  });

  describe('provider health asks the disk, not the variable', () => {
    const check = () => (new ProviderHealthService() as any).localStorageCheck();

    it('is ok when a file can be written and read back, and says where', () => {
      const result = check();
      expect(result).toMatchObject({ id: 'file-storage', state: 'ok' });
      expect(result.detail).toContain(dir);
      // The probe file does not stay behind.
      expect(fs.readdirSync(dir).filter((f) => f.startsWith('.health-'))).toEqual([]);
    });

    it('fails when the directory cannot be written', () => {
      const notADir = path.join(dir, 'a-file');
      fs.writeFileSync(notADir, 'x');
      setEnv('STORAGE_DIR', notADir);
      expect(check()).toMatchObject({ id: 'file-storage', state: 'failed' });
    });

    it('says uploads are refused when nothing is configured in production', () => {
      setEnv('STORAGE_DIR', undefined);
      setEnv('NODE_ENV', 'production');
      const result = check();
      expect(result).toMatchObject({ id: 'file-storage', state: 'not_configured' });
      expect(result.detail).toMatch(/uploads are refused/);
    });
  });
});
