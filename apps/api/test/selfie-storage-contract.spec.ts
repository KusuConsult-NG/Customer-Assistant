/**
 * The selfie upload path, proved without a Supabase project.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * Six HTTP-harness checks covering this path have never run in any
 * environment I have access to — SEL-020, 021, 022, 032, 038 and 043, four of
 * them CRITICAL. They all begin `if (!storageUp) return { blocked: … }`, and
 * storage is up only when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY point at
 * a real hosted project. So the guarantees they describe were asserted
 * nowhere: that the link is single-use, that two simultaneous uploads leave
 * exactly one photograph, that deleting a request erases the citizen's face
 * from the bucket.
 *
 * Those are properties of THIS application's logic, not of Supabase. They are
 * decided by a conditional `updateMany` claim, by what happens to the loser's
 * object, and by whether the delete path reaches storage at all — and every
 * one of those can be settled against a bucket that lives in this process.
 *
 * ── What this does and does not establish ──────────────────────────────────
 *
 * The object store is replaced by an in-memory one with the same interface,
 * so "retrievable" here means the application recorded a path that resolves
 * to the bytes it uploaded. What remains unproven is Supabase itself: that it
 * accepts the request, durably keeps the bytes, and honours the delete. That
 * is one external dependency rather than six unexercised guarantees, and it
 * is the part a staging bucket has to confirm.
 *
 * The harness checks stay as they are. They exercise the real provider and
 * should keep refusing to certify it when it is absent.
 */

jest.mock('../src/common/object-storage', () => {
  // Declared inside the factory: jest hoists this call above the imports, so
  // anything referenced from an outer scope is still in its temporal dead
  // zone when the module under test first requires it.
  const contents = new Map<string, { bytes: Buffer; mimeType: string }>();
  let counter = 0;

  return {
    KNOWLEDGE_BUCKET: 'knowledge-documents',
    SELFIE_BUCKET: 'onboarding-selfies',
    __contents: contents,
    __reset: () => {
      contents.clear();
      counter = 0;
    },
    uploadObject: jest.fn(
      async (
        _bucket: string,
        organizationId: string,
        fileName: string,
        bytes: Buffer,
        mimeType: string
      ) => {
        // Mirrors the real path shape, including the per-write uniqueness that
        // is what lets two racing uploads produce two distinct objects.
        const storagePath = `${organizationId}/${Date.now()}_${++counter}_${fileName}`;
        contents.set(storagePath, { bytes, mimeType });
        return storagePath;
      }
    ),
    signedUrl: jest.fn(async (_bucket: string, storagePath: string) => {
      if (!contents.has(storagePath)) throw new Error(`no object at ${storagePath}`);
      return `https://in-memory.test/${storagePath}?token=stub`;
    }),
    deleteObject: jest.fn(async (_bucket: string, storagePath: string) => {
      contents.delete(storagePath);
    }),
  };
});

import { randomBytes } from 'crypto';
import { prisma, createSelfieRequest } from '@ace/database';
import { OnboardingService } from '../src/onboarding/onboarding.service';
import { MIN_IMAGE_BYTES } from '../src/common/image-validation';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const storage = require('../src/common/object-storage');

/** A real PNG signature with enough body to clear the minimum-size floor. */
function pngBytes(marker = 'A'): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const body = Buffer.alloc(MIN_IMAGE_BYTES, marker);
  return Buffer.concat([signature, body]);
}

describe('the selfie upload path, against an in-memory bucket', () => {
  const onboarding = new OnboardingService();

  let orgId: string;
  let contactId: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: {
        name: 'Selfie Storage Contract',
        slug: `ssc-${randomBytes(4).toString('hex')}`,
        industry: 'GOVERNMENT',
      },
    });
    orgId = org.id;

    const contact = await prisma.contact.create({
      data: {
        organizationId: orgId,
        phoneNumber: `+2348${Date.now().toString().slice(-9)}`,
        fullName: 'Selfie Subject',
      },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  });

  beforeEach(() => {
    storage.__reset();
    jest.clearAllMocks();
  });

  const newRequest = async () => {
    const { token, id } = await createSelfieRequest({
      organizationId: orgId,
      contactId,
      channel: 'WHATSAPP',
      purpose: 'enrollment photo',
      uploadUrl: 'https://example.test/selfie/placeholder',
    });
    return { token, id };
  };

  // ── SEL-020 ───────────────────────────────────────────────────────────────

  it('closes the request and records where the photo went', async () => {
    const { token, id } = await newRequest();

    const result = await onboarding.submitViaLink(token, pngBytes().toString('base64'));
    expect(result).toMatchObject({ accepted: true });

    const row = await prisma.selfieRequest.findUnique({ where: { id } });
    expect(row?.status).toBe('RECEIVED');
    expect(row?.storagePath).toBeTruthy();
    expect(row?.mimeType).toBe('image/png');
    expect(row?.receivedAt).toBeTruthy();
  });

  // ── SEL-021 ───────────────────────────────────────────────────────────────

  it('stores bytes that are retrievable by the path it recorded', async () => {
    const { token, id } = await newRequest();
    const sent = pngBytes('Z');

    await onboarding.submitViaLink(token, sent.toString('base64'));

    const row = await prisma.selfieRequest.findUnique({ where: { id } });
    const stored = storage.__contents.get(row!.storagePath!);

    // The recorded path has to resolve to the bytes that were uploaded. A
    // request marked RECEIVED whose path points at nothing is the state this
    // asserts against.
    expect(stored).toBeDefined();
    expect(stored.bytes.equals(sent)).toBe(true);
    // A short-lived signed URL over that same path, with the type and the
    // time it arrived — what the dashboard needs to show an operator the
    // photo without the bucket being public.
    const view: any = await onboarding.getImageUrl(orgId, id);
    expect(view.url).toContain(row!.storagePath!);
    expect(view.mimeType).toBe('image/png');
    expect(view.expiresInSeconds).toBeLessThanOrEqual(300);
  });

  // ── SEL-032 ───────────────────────────────────────────────────────────────

  it('strips a data: URL prefix instead of storing it as image data', async () => {
    const { token, id } = await newRequest();
    const sent = pngBytes('D');

    // What a browser canvas produces. Decoded with the prefix still attached,
    // the first bytes are "data:image/png;base64" and the file is corrupt —
    // and would also fail the magic-byte check, so acceptance is the proof.
    await onboarding.submitViaLink(
      token,
      `data:image/png;base64,${sent.toString('base64')}`
    );

    const row = await prisma.selfieRequest.findUnique({ where: { id } });
    const stored = storage.__contents.get(row!.storagePath!);
    expect(stored.bytes.equals(sent)).toBe(true);
    expect(stored.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  // ── SEL-022 ───────────────────────────────────────────────────────────────

  it('refuses a second upload on the same link', async () => {
    const { token } = await newRequest();

    await onboarding.submitViaLink(token, pngBytes('1').toString('base64'));

    // The link travels by WhatsApp and survives in forwarded chats. A second
    // use must not overwrite the first photograph.
    await expect(
      onboarding.submitViaLink(token, pngBytes('2').toString('base64'))
    ).rejects.toThrow(/already been used/i);

    expect(storage.__contents.size).toBe(1);
  });

  // ── SEL-038 ───────────────────────────────────────────────────────────────

  it('leaves exactly one photograph when two uploads race', async () => {
    const { token, id } = await newRequest();

    // Both resolve the token before either claims the request, which is the
    // window a sequential test cannot reach.
    const results = await Promise.allSettled([
      onboarding.submitViaLink(token, pngBytes('L').toString('base64')),
      onboarding.submitViaLink(token, pngBytes('R').toString('base64')),
    ]);

    const accepted = results.filter((r) => r.status === 'fulfilled');
    expect(accepted).toHaveLength(1);

    // And the loser's object is removed rather than stranded. An orphaned
    // photograph of somebody's face that nothing points at is one no deletion
    // will ever reach.
    expect(storage.__contents.size).toBe(1);

    const row = await prisma.selfieRequest.findUnique({ where: { id } });
    expect(storage.__contents.has(row!.storagePath!)).toBe(true);
    expect(row?.status).toBe('RECEIVED');
  });

  // ── SEL-043 ───────────────────────────────────────────────────────────────

  it('erases the stored photograph when the request is deleted', async () => {
    const { token, id } = await newRequest();
    await onboarding.submitViaLink(token, pngBytes('X').toString('base64'));

    const row = await prisma.selfieRequest.findUnique({ where: { id } });
    const storedPath = row!.storagePath!;
    expect(storage.__contents.has(storedPath)).toBe(true);

    const outcome = await onboarding.deleteRequest(orgId, id);

    // Deleting the row without the object leaves a citizen's face in a bucket
    // that nothing in the system now references.
    expect(outcome).toMatchObject({ deleted: true, imageRemoved: true });
    expect(storage.deleteObject).toHaveBeenCalledWith('onboarding-selfies', storedPath);
    expect(storage.__contents.has(storedPath)).toBe(false);
    expect(await prisma.selfieRequest.findUnique({ where: { id } })).toBeNull();
  });

  it('reports honestly when there was no photograph to erase', async () => {
    const { id } = await newRequest();

    const outcome = await onboarding.deleteRequest(orgId, id);
    expect(outcome).toMatchObject({ deleted: true, imageRemoved: false });
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });
});
