/**
 * The selfie routes nothing was driving over HTTP — including the two that are
 * UNAUTHENTICATED and citizen-facing.
 *
 * `GET /api/public/selfie/:token` and `POST /api/public/selfie/:token` are
 * reachable by anyone holding the link, and a link travels by WhatsApp: it
 * survives in forwarded chats, on a shared handset and in a screenshot long
 * after the upload is done. The token is the entire credential. So the
 * properties that matter are not "does it return 200" but: what a stolen link
 * discloses, how many times it can be used, what it refuses to store, and
 * whether a second upload can strand the first photograph in a bucket with
 * nothing pointing at it.
 *
 * Object storage is the one thing stubbed. It is Supabase over HTTP and not
 * present in CI, and every behaviour under test here is on this side of that
 * call — the stub records what it was ASKED to store, which is what the
 * assertions are about.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';

const uploaded: Array<{ bucket: string; prefix: string; name: string; bytes: Buffer; mime: string; path: string }> = [];
const deleted: Array<{ bucket: string; path: string }> = [];

// Supabase over HTTP, not present in CI. The stub RECORDS what it was asked
// to store, because that is what the assertions are about — which bucket, under
// which agency, with which mime type decided from the bytes.
//
// `...jest.requireActual` matters: a factory that returns only the functions
// drops `SELFIE_BUCKET`, the service then passes `undefined` as the bucket, and
// the test asserts against a value the real code would never produce. The
// signing export is `signedUrl`; naming it anything else leaves the REAL one in
// place, which answers 500 and reads as a broken endpoint.
jest.mock('../src/common/object-storage', () => ({
  ...jest.requireActual('../src/common/object-storage'),
  uploadObject: jest.fn(async (bucket: string, prefix: string, name: string, bytes: Buffer, mime: string) => {
    // Unique per call, as the real one is (it prefixes a timestamp), so the
    // concurrent case can tell the winner's object from the losers'.
    const path = `${prefix}/${uploaded.length}_${name}`;
    uploaded.push({ bucket, prefix, name, bytes, mime, path });
    return path;
  }),
  deleteObject: jest.fn(async (bucket: string, path: string) => {
    deleted.push({ bucket, path });
  }),
  signedUrl: jest.fn(async () => 'https://storage.test/signed'),
}));

import { ThrottlerStorage } from '@nestjs/throttler';
import { prisma, hashSelfieToken } from '@ace/database';
import { createTestApp } from './support/create-test-app';

/**
 * A PNG by its magic bytes, padded past `MIN_IMAGE_BYTES`.
 *
 * The validator requires at least 1024 bytes, deliberately — "below this it is
 * not a photograph, it is a tracking pixel or a truncated upload" — so a bare
 * 1×1 PNG is REFUSED, correctly. The first version of this fixture was that
 * 70-byte pixel, and the resulting 400 looked like a broken upload path.
 */
const PNG = Buffer.concat([
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64'
  ),
  Buffer.alloc(2048, 0x20),
]);

describe('selfie capture', () => {
  let app: INestApplication;
  let orgId: string;
  let otherOrgId: string;
  let contactId: string;
  let ownerToken: string;
  let agentToken: string;
  let otherOrgToken: string;

  jest.setTimeout(90000);

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    process.env.WEB_BASE_URL ??= 'https://care.example';

    app = await createTestApp();

    const mkOrg = async (label: string) =>
      (await prisma.organization.create({
        data: { name: label, slug: `${label.toLowerCase().replace(/\W+/g, '-')}-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
      })).id;
    orgId = await mkOrg('Selfie Agency');
    otherOrgId = await mkOrg('Other Selfie Agency');

    const mkToken = async (organizationId: string, role: 'OWNER' | 'AGENT') => {
      const email = `selfie.${role.toLowerCase()}.${randomBytes(4).toString('hex')}@selfie.test`;
      const password = 'SelfiePassw0rd!';
      await prisma.user.create({
        data: {
          organizationId, email, fullName: `${role} tester`, role,
          passwordHash: await bcrypt.hash(password, 10), emailVerifiedAt: new Date(),
        },
      });
      const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email, password });
      expect(res.body.accessToken).toBeTruthy();
      return res.body.accessToken as string;
    };
    ownerToken = await mkToken(orgId, 'OWNER');
    agentToken = await mkToken(orgId, 'AGENT');
    otherOrgToken = await mkToken(otherOrgId, 'OWNER');

    const contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        phoneNumber: '+2348030008888',
        fullName: 'Amina Bello Yusuf',
        metadata: { planType: 'Family Informal Sector' },
      },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await prisma.selfieRequest.deleteMany({ where: { organizationId: id } });
      await prisma.note.deleteMany({ where: { contact: { organizationId: id } } });
      await prisma.contact.deleteMany({ where: { organizationId: id } });
      await prisma.user.deleteMany({ where: { organizationId: id } });
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  /**
   * The public upload route is throttled to 15/min PER IP, and the whole suite
   * shares one IP. The attempt-cap test deliberately burns a dozen requests,
   * so without this the tests after it were refused with 429 — which has
   * nothing to do with what they assert and reads like a broken endpoint.
   * Clearing the limiter is not weakening the control: `redis-throttler-storage.spec`
   * covers the limiter itself.
   */
  const clearThrottle = async () => {
    const storage: any = app.get(ThrottlerStorage, { strict: false });
    const bucket = storage?.storage;
    if (bucket && typeof bucket === 'object') {
      for (const key of Object.keys(bucket)) delete bucket[key];
    }
    const url = process.env.REDIS_URL;
    if (!url) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { createClient } = require('redis');
      const client = createClient({ url });
      await client.connect();
      const keys = await client.keys('throttle:*');
      if (keys.length) await client.del(keys);
      await client.quit();
    } catch {
      /* in-memory storage was already cleared above */
    }
  };

  beforeEach(async () => {
    uploaded.length = 0;
    deleted.length = 0;
    await clearThrottle();
    await prisma.selfieRequest.deleteMany({ where: { organizationId: orgId } });
  });

  /** Creates a request through the real staff endpoint and returns its raw token. */
  const requestSelfie = async (token = agentToken, body: Record<string, unknown> = {}) => {
    const res = await request(app.getHttpServer())
      .post('/api/onboarding/selfie-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ contactId, purpose: 'Enrolment photograph', ...body });
    return res;
  };

  /**
   * The raw token is never returned to staff twice, so to drive the public
   * routes the test writes a known one — hashed exactly as the service hashes
   * it, so the lookup under test is the real lookup.
   */
  const withKnownToken = async (requestId: string, expiresAt = new Date(Date.now() + 3600_000)) => {
    const raw = randomBytes(24).toString('hex');
    await prisma.selfieRequest.update({
      where: { id: requestId },
      data: { tokenHash: hashSelfieToken(raw), expiresAt, status: 'PENDING', attempts: 0 },
    });
    return raw;
  };

  const seedPending = async () => {
    const created = await requestSelfie();
    expect(created.status).toBe(201);
    const row = await prisma.selfieRequest.findFirst({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    return { id: row!.id, token: await withKnownToken(row!.id) };
  };

  describe('POST /api/onboarding/selfie-requests', () => {
    it('creates a request and hands back a link, never a bare token', async () => {
      const res = await requestSelfie();
      expect(res.status).toBe(201);

      const row = await prisma.selfieRequest.findFirst({ where: { organizationId: orgId } });
      expect(row).not.toBeNull();
      // Stored as a hash only. A raw token in the row makes the hash beside it
      // decorative.
      expect(row!.tokenHash).toHaveLength(64);
      expect(JSON.stringify(res.body)).not.toContain(row!.tokenHash);
    });

    it('refuses a contact belonging to another agency', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/onboarding/selfie-requests')
        .set('Authorization', `Bearer ${otherOrgToken}`)
        .send({ contactId, purpose: 'Enrolment photograph' });
      // Not 500, not a request created against someone else's citizen.
      expect(res.status).toBe(404);
      expect(await prisma.selfieRequest.count({ where: { organizationId: otherOrgId } })).toBe(0);
    });

    it('is not reachable without a token', async () => {
      expect((await request(app.getHttpServer()).post('/api/onboarding/selfie-requests').send({ contactId })).status).toBe(401);
    });
  });

  describe('GET /api/public/selfie/:token — what a stolen link discloses', () => {
    it('gives a first name and the agency, and nothing that identifies the citizen', async () => {
      const { token } = await seedPending();
      const res = await request(app.getHttpServer()).get(`/api/public/selfie/${token}`);
      expect(res.status).toBe(200);

      expect(res.body.firstName).toBe('Amina');
      expect(res.body.organizationName).toBe('Selfie Agency');

      // THE assertion. The link survives in forwarded chats and screenshots,
      // so the budget is a first name: no surname, no phone number, no contact
      // or tenant id, and not the plan the citizen is on.
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('Bello');
      expect(raw).not.toContain('Yusuf');
      expect(raw).not.toContain('2348030008888');
      expect(raw).not.toContain(contactId);
      expect(raw).not.toContain(orgId);
      expect(raw).not.toMatch(/Informal Sector/i);
      // Derived instead: whether to show the dependants form.
      expect(res.body.isFamilyPlan).toBe(true);
    });

    it('refuses a token that is not a token at all, without saying why', async () => {
      const res = await request(app.getHttpServer()).get('/api/public/selfie/short');
      expect(res.status).toBe(404);
      expect(String(res.body.message)).toMatch(/not valid/i);
    });

    it('refuses an expired link, and records the expiry', async () => {
      const { id } = await seedPending();
      const token = await withKnownToken(id, new Date(Date.now() - 1000));

      const res = await request(app.getHttpServer()).get(`/api/public/selfie/${token}`);
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/expired/i);
      // The row is moved to EXPIRED rather than left looking pending to staff.
      expect((await prisma.selfieRequest.findUnique({ where: { id } }))!.status).toBe('EXPIRED');
    });

    it('refuses a cancelled link', async () => {
      const { id, token } = await seedPending();
      await prisma.selfieRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
      const res = await request(app.getHttpServer()).get(`/api/public/selfie/${token}`);
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/cancelled/i);
    });
  });

  describe('POST /api/public/selfie/:token — the upload', () => {
    it('accepts a real image and closes the request', async () => {
      const { id, token } = await seedPending();
      const res = await request(app.getHttpServer())
        .post(`/api/public/selfie/${token}`)
        .send({ imageBase64: PNG.toString('base64') });
      expect(res.status).toBe(201);
      expect(res.body.accepted).toBe(true);

      expect(uploaded).toHaveLength(1);
      // The PRIVATE bucket, scoped under the agency, with the real mime type.
      expect(uploaded[0].bucket).toBe('onboarding-selfies');
      expect(uploaded[0].prefix).toBe(orgId);
      expect(uploaded[0].mime).toBe('image/png');

      const row = await prisma.selfieRequest.findUnique({ where: { id } });
      expect(row!.status).toBe('RECEIVED');
      expect(row!.storagePath).toBeTruthy();
      expect(row!.sizeBytes).toBe(PNG.length);
      // Capture, NOT verification. Nothing here may claim the face was checked
      // against anything, because no biometric provider is wired up.
      expect(row!.verifiedAt).toBeNull();
    });

    it('refuses an SVG that claims to be an image', async () => {
      const { id, token } = await seedPending();
      const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
      const res = await request(app.getHttpServer())
        .post(`/api/public/selfie/${token}`)
        .send({ imageBase64: svg.toString('base64') });

      // An SVG is a document that executes script, served back to staff from
      // our own origin. Validation is by magic bytes, so a renamed file does
      // not get through either.
      expect(res.status).toBe(400);
      expect(uploaded).toHaveLength(0);
      expect((await prisma.selfieRequest.findUnique({ where: { id } }))!.status).toBe('PENDING');
    });

    it('refuses bytes that are not an image, and still spends an attempt', async () => {
      const { id, token } = await seedPending();
      const res = await request(app.getHttpServer())
        .post(`/api/public/selfie/${token}`)
        .send({ imageBase64: Buffer.from('this is not a picture').toString('base64') });
      expect(res.status).toBe(400);
      expect(uploaded).toHaveLength(0);

      // Counted BEFORE validation, so a loop of malformed uploads exhausts the
      // cap rather than being free to an attacker holding the link.
      expect((await prisma.selfieRequest.findUnique({ where: { id } }))!.attempts).toBe(1);
    });

    it('stops accepting after the attempt cap', async () => {
      const { id, token } = await seedPending();
      const junk = Buffer.from('nope').toString('base64');

      let lastStatus = 0;
      for (let i = 0; i < 12; i++) {
        lastStatus = (await request(app.getHttpServer()).post(`/api/public/selfie/${token}`).send({ imageBase64: junk })).status;
      }
      expect(lastStatus).toBe(400);

      // Even a VALID image is refused once the cap is reached — the cap is on
      // the link, not on the file.
      const after = await request(app.getHttpServer())
        .post(`/api/public/selfie/${token}`)
        .send({ imageBase64: PNG.toString('base64') });
      expect(after.status).toBe(400);
      expect(String(after.body.message)).toMatch(/too many attempts/i);
      expect(uploaded).toHaveLength(0);
      expect((await prisma.selfieRequest.findUnique({ where: { id } }))!.status).toBe('PENDING');
    });

    it('is single-use: a forwarded link cannot replace the photo', async () => {
      const { token } = await seedPending();
      expect((await request(app.getHttpServer()).post(`/api/public/selfie/${token}`).send({ imageBase64: PNG.toString('base64') })).status).toBe(201);

      const second = await request(app.getHttpServer())
        .post(`/api/public/selfie/${token}`)
        .send({ imageBase64: PNG.toString('base64') });
      expect(second.status).toBe(400);
      expect(String(second.body.message)).toMatch(/already been used/i);
      // And nothing was written a second time.
      expect(uploaded).toHaveLength(1);
    });

    it('two uploads at once leave one stored photo, not an orphan', async () => {
      const { id, token } = await seedPending();
      const body = { imageBase64: PNG.toString('base64') };

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(app.getHttpServer()).post(`/api/public/selfie/${token}`).send(body).then((r) => r.status)
        )
      );

      // Exactly one may close the request. The row is claimed with a
      // conditional update on status PENDING, so a loser cannot overwrite
      // `storagePath` and strand the winner's object in the bucket — an
      // orphaned photograph of someone's face that nothing points at and no
      // deletion will ever reach.
      expect(results.filter((s) => s === 201)).toHaveLength(1);
      const row = await prisma.selfieRequest.findUnique({ where: { id } });
      expect(row!.status).toBe('RECEIVED');
      expect(uploaded.some((u) => u.path === row!.storagePath)).toBe(true);

      // Every loser uploaded a photograph too — they all passed the token
      // check before any of them claimed the row — so each of those objects
      // must be deleted again. Left behind they are photographs of someone's
      // face sitting in a bucket with no row pointing at them, which no
      // erasure request could ever reach.
      const orphans = uploaded.filter((u) => u.path !== row!.storagePath);
      for (const orphan of orphans) {
        expect(deleted.some((d) => d.path === orphan.path)).toBe(true);
      }
    });

    it('records dependants against the citizen when the family form is filled', async () => {
      const { token } = await seedPending();
      const res = await request(app.getHttpServer())
        .post(`/api/public/selfie/${token}`)
        .send({
          imageBase64: PNG.toString('base64'),
          dependents: [
            { fullName: 'Hauwa Bello', relationship: 'Daughter' },
            { fullName: 'Musa Bello', relationship: 'Son' },
          ],
        });
      expect(res.status).toBe(201);

      const contact = await prisma.contact.findUnique({ where: { id: contactId } });
      const meta = contact!.metadata as Record<string, any>;
      expect(meta.dependents).toHaveLength(2);
      // Flagged for a human, never auto-approved.
      expect(meta.enrollmentStatus).toBe('PENDING_REVIEW');

      // And left on the record where an officer will see it.
      const notes = await prisma.note.findMany({ where: { contactId } });
      expect(notes.some((n) => /Hauwa Bello \(Daughter\)/.test(n.content))).toBe(true);
    });

    it('says what is wrong when no image is sent at all', async () => {
      const { token } = await seedPending();
      const res = await request(app.getHttpServer()).post(`/api/public/selfie/${token}`).send({});
      expect(res.status).toBe(400);
      expect(String(res.body.message)).toMatch(/take the photo again/i);
    });
  });

  describe('the staff side', () => {
    it('lists this agency’s requests and nobody else’s', async () => {
      await seedPending();
      const mine = await request(app.getHttpServer())
        .get('/api/onboarding/selfie-requests')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(mine.status).toBe(200);
      const rows = Array.isArray(mine.body) ? mine.body : mine.body.requests ?? [];
      expect(rows.length).toBeGreaterThan(0);

      const theirs = await request(app.getHttpServer())
        .get('/api/onboarding/selfie-requests')
        .set('Authorization', `Bearer ${otherOrgToken}`);
      expect(theirs.status).toBe(200);
      const theirRows = Array.isArray(theirs.body) ? theirs.body : theirs.body.requests ?? [];
      expect(theirRows).toHaveLength(0);
    });

    it('never returns a raw token in the list', async () => {
      const { token } = await seedPending();
      const res = await request(app.getHttpServer())
        .get('/api/onboarding/selfie-requests')
        .set('Authorization', `Bearer ${agentToken}`);
      // The upload URL is stored encrypted because it ENDS IN the token; a
      // list that hands it back in the clear undoes that.
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it('signs a URL for a stored photo, and refuses another agency’s', async () => {
      const { id, token } = await seedPending();
      await request(app.getHttpServer()).post(`/api/public/selfie/${token}`).send({ imageBase64: PNG.toString('base64') });

      const ours = await request(app.getHttpServer())
        .get(`/api/onboarding/selfie-requests/${id}/image`)
        .set('Authorization', `Bearer ${agentToken}`);
      expect(ours.status).toBe(200);
      expect(String(ours.body.url ?? ours.body.signedUrl)).toMatch(/^https:\/\//);

      const theirs = await request(app.getHttpServer())
        .get(`/api/onboarding/selfie-requests/${id}/image`)
        .set('Authorization', `Bearer ${otherOrgToken}`);
      expect(theirs.status).toBe(404);
    });

    it('cancels a request, which closes the link', async () => {
      const { id, token } = await seedPending();
      const res = await request(app.getHttpServer())
        .post(`/api/onboarding/selfie-requests/${id}/cancel`)
        .set('Authorization', `Bearer ${agentToken}`);
      // 200, not 201: cancelling creates nothing.
      expect(res.status).toBe(200);
      expect((await prisma.selfieRequest.findUnique({ where: { id } }))!.status).toBe('CANCELLED');

      // The citizen's link stops working immediately, which is the point.
      expect((await request(app.getHttpServer()).get(`/api/public/selfie/${token}`)).status).toBe(400);
    });

    it('will not let one agency cancel another’s request', async () => {
      const { id } = await seedPending();
      const res = await request(app.getHttpServer())
        .post(`/api/onboarding/selfie-requests/${id}/cancel`)
        .set('Authorization', `Bearer ${otherOrgToken}`);
      expect(res.status).toBe(404);
      expect((await prisma.selfieRequest.findUnique({ where: { id } }))!.status).toBe('PENDING');
    });

    it('restricts erasing a photo to OWNER/ADMIN, and erases the object too', async () => {
      const { id, token } = await seedPending();
      await request(app.getHttpServer()).post(`/api/public/selfie/${token}`).send({ imageBase64: PNG.toString('base64') });

      // An AGENT may request and cancel, but destroying personal data is not
      // front-desk work.
      const refused = await request(app.getHttpServer())
        .delete(`/api/onboarding/selfie-requests/${id}`)
        .set('Authorization', `Bearer ${agentToken}`);
      expect(refused.status).toBe(403);
      expect(await prisma.selfieRequest.findUnique({ where: { id } })).not.toBeNull();

      const done = await request(app.getHttpServer())
        .delete(`/api/onboarding/selfie-requests/${id}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(done.status).toBe(200);
      expect(await prisma.selfieRequest.findUnique({ where: { id } })).toBeNull();
      // The row AND the image. A delete that leaves the object behind keeps
      // the photograph while telling the agency it is gone.
      expect(deleted).toHaveLength(1);
      expect(deleted[0].bucket).toBe('onboarding-selfies');
    });
  });
});
