/**
 * The selfie upload token, and the column that gave it away.
 *
 * `SelfieRequest.tokenHash` holds a SHA-256 and the schema says the raw token
 * "is intentionally never stored". That was not true: the `uploadUrl` beside it
 * held the full link, and the link ENDS IN THE RAW TOKEN. Hashing the token out
 * of the stored URL reproduced the stored hash exactly, so the hashing was
 * decorative — anyone able to read this table held a working one-time upload
 * link for every pending request, and those links belong to enrollees about to
 * photograph themselves.
 *
 * Found by the HTTP validation harness (SEL-002), which had been reporting it
 * for as long as it has existed and had never been run in this environment.
 */
import { randomBytes, createHash } from 'crypto';
import {
  prisma,
  createSelfieRequest,
  selfieUploadUrl,
  sealUploadUrl,
  openUploadUrl,
  hashSelfieToken,
} from '@ace/database';

describe('the selfie upload token at rest', () => {
  let orgId: string;
  let contactId: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'Selfie At Rest', slug: `sar-${randomBytes(4).toString('hex')}`, industry: 'CLINIC' },
    });
    orgId = org.id;
    const contact = await prisma.contact.create({
      data: { organizationId: orgId, phoneNumber: `+2348${Date.now().toString().slice(-9)}`, fullName: 'Selfie Subject' },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  });

  it('does not leave a working link in the database', async () => {
    const request = await createSelfieRequest({
      organizationId: orgId,
      contactId,
      channel: 'WHATSAPP',
      uploadUrl: selfieUploadUrl('placeholder-not-the-real-token'),
    });

    const row = await prisma.selfieRequest.findUnique({
      where: { id: request.id },
      select: { uploadUrl: true, tokenHash: true },
    });

    // The regression, stated as the harness states it: whatever is stored must
    // not contain a token that hashes to the stored hash.
    expect(row!.uploadUrl).not.toContain(request.token);
    const storedTail = (row!.uploadUrl ?? '').split('/').pop() ?? '';
    expect(hashSelfieToken(storedTail)).not.toBe(row!.tokenHash);

    // And it is ciphertext, not merely a different string.
    expect(row!.uploadUrl).toMatch(/^v1\./);
  });

  it('round-trips: what is sealed comes back as the link that was sent', () => {
    const url = selfieUploadUrl(randomBytes(32).toString('base64url'));
    const sealed = sealUploadUrl(url)!;

    expect(sealed).not.toBe(url);
    expect(sealed).toMatch(/^v1\./);
    expect(openUploadUrl(sealed)).toBe(url);
  });

  it('a fresh IV per write, so two identical links do not look identical', () => {
    const url = selfieUploadUrl('same-token-twice');
    expect(sealUploadUrl(url)).not.toBe(sealUploadUrl(url));
  });

  it('still reads a row written before this existed', () => {
    // Turning encryption on must not strand the pending requests already in the
    // table — though those are exactly the links that should be re-issued
    // rather than trusted, because they were stored in the clear.
    const legacy = 'http://localhost:4000/selfie/legacy-plaintext-token';
    expect(openUploadUrl(legacy)).toBe(legacy);
  });

  it('null and empty stay as they are', () => {
    expect(sealUploadUrl(null)).toBeNull();
    expect(sealUploadUrl(undefined)).toBeNull();
    expect(sealUploadUrl('')).toBeNull();
    expect(openUploadUrl(null)).toBeNull();
    expect(openUploadUrl('')).toBeNull();
  });

  it('the hash still resolves the token the customer was actually given', async () => {
    // The point of the whole exercise: the link works for its holder, and only
    // its holder. Sealing the stored copy must not break the lookup.
    const request = await createSelfieRequest({
      organizationId: orgId,
      contactId,
      channel: 'WHATSAPP',
      uploadUrl: selfieUploadUrl('x'),
    });

    const found = await prisma.selfieRequest.findUnique({
      where: { tokenHash: hashSelfieToken(request.token) },
      select: { id: true },
    });
    expect(found?.id).toBe(request.id);

    // A near-miss token resolves to nothing.
    const wrong = createHash('sha256').update(request.token + 'x').digest('hex');
    expect(await prisma.selfieRequest.findUnique({ where: { tokenHash: wrong } })).toBeNull();
  });
});
