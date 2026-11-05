import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma, decryptSecret } from '@ace/database';
import { createTestApp } from './support/create-test-app';

/**
 * Connecting a WhatsApp line must fail by NAMING what is missing.
 *
 * `webhookVerifyToken` was declared required on an inline `@Body()` type,
 * which TypeScript erases — so the ValidationPipe had no metatype, the field
 * reached Prisma as `undefined`, and the endpoint answered:
 *
 *     {"statusCode":500,"error":"Internal Server Error",
 *      "message":"An unexpected error occurred."}
 *
 * on the one request whose entire purpose is to tell an operator whether their
 * line saved. That response is indistinguishable from a database outage or a
 * refused credential, so the next move is to go hunting in Meta for a fault
 * that is not there.
 */
describe('POST /api/organizations/whatsapp-config validation', () => {
  let app: INestApplication;
  let orgId: string;
  let ownerToken: string;

  jest.setTimeout(60000);

  const TOKEN = `EAA${'x'.repeat(198)}`;
  const VERIFY = 'verify_token_000000';

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    // Writing a credential THROWS with no key rather than storing plaintext,
    // so a suite without one would be testing the refusal, not the save.
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

    app = await createTestApp();

    const org = await prisma.organization.create({
      data: { name: 'WA Agency', slug: `wa-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;

    const email = `wa.owner.${randomBytes(4).toString('hex')}@wa.test`;
    const password = 'WhatsAppPassw0rd!';
    await prisma.user.create({
      data: {
        organizationId: orgId, email, fullName: 'Owner', role: 'OWNER',
        passwordHash: await bcrypt.hash(password, 10), emailVerifiedAt: new Date(),
      },
    });
    ownerToken = (
      await request(app.getHttpServer()).post('/api/auth/login').send({ email, password })
    ).body.accessToken;
  });

  afterAll(async () => {
    await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  const post = (body: any) =>
    request(app.getHttpServer())
      .post('/api/organizations/whatsapp-config')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send(body);

  const complete = () => ({
    phoneNumberId: '1319842031202307',
    whatsappBusinessId: '1568175338085648',
    accessToken: TOKEN,
    webhookVerifyToken: VERIFY,
    displayPhoneNumber: '+1 555-671-9884',
  });

  it('rejects a missing webhookVerifyToken by name, not as a 500', async () => {
    const { webhookVerifyToken, ...withoutIt } = complete();
    const res = await post(withoutIt);

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('webhookVerifyToken');
    // The failure this replaces. A generic 500 sends the operator looking for
    // a fault in Meta, or in the database, or in their token.
    expect(res.body.message).not.toBe('An unexpected error occurred.');
  });

  for (const field of ['phoneNumberId', 'accessToken'] as const) {
    it(`rejects a missing ${field} by name`, async () => {
      const body: any = complete();
      delete body[field];
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain(field);
    });
  }

  it('saves a complete body and returns a MASKED view, never the token back', async () => {
    const res = await post(complete());
    expect([200, 201]).toContain(res.status);

    const raw = JSON.stringify(res.body);
    // Echoing the caller's own access token is what this response used to do.
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(VERIFY);
    // Nor the ciphertext, which is just as wrong and less obvious.
    expect(raw).not.toContain('v1.');

    const row = await prisma.whatsAppConfig.findFirst({ where: { organizationId: orgId } });
    expect(row).toBeTruthy();
    expect(row!.phoneNumberId).toBe('1319842031202307');
    // Stored encrypted, not in the clear.
    expect(row!.accessToken).not.toBe(TOKEN);
    expect(row!.accessToken?.startsWith('v1.')).toBe(true);
  });

  it('accepts isActive, which every caller sends', async () => {
    // The ValidationPipe strips unknown properties, and whether it also
    // REJECTS them is a setting — so a field callers genuinely send has to be
    // declared or the save fails on something cosmetic.
    const res = await post({ ...complete(), isActive: true });
    expect([200, 201]).toContain(res.status);
  });
  /**
   * Switching which number a line points at must not require the Meta token
   * again. It is the most likely edit this endpoint will ever see — a test
   * number replaced by the real one — and both credentials were required on
   * every save, so it meant a trip back into Business Manager. The form's own
   * placeholder read "enter new to replace".
   */
  describe('updating a line without re-entering its credentials', () => {
    it('changes the number and leaves the stored credentials readable', async () => {
      const created = await post(complete());
      expect([200, 201]).toContain(created.status);
      const row = await prisma.whatsAppConfig.findFirst({ where: { organizationId: orgId } });

      const res = await post({
        id: row!.id,
        phoneNumberId: '9988776655443322',
        displayPhoneNumber: '+234 803 000 1111',
      });
      expect([200, 201]).toContain(res.status);

      const after = await prisma.whatsAppConfig.findUnique({ where: { id: row!.id } });
      expect(after!.phoneNumberId).toBe('9988776655443322');
      expect(after!.displayPhoneNumber).toBe('+234 803 000 1111');
      // Unchanged, and still ONE layer of encryption. Passing the stored
      // ciphertext back through the seal would encrypt the encryption and
      // lock the credential behind a value nothing can read.
      expect(after!.accessToken).toBe(row!.accessToken);
      expect(decryptSecret(after!.accessToken, 'test')).toBe(TOKEN);
      expect(decryptSecret(after!.webhookVerifyToken, 'test')).toBe(VERIFY);
    });

    it('replaces a credential when one IS supplied', async () => {
      await post(complete());
      const row = await prisma.whatsAppConfig.findFirst({ where: { organizationId: orgId } });
      const rotated = 'rotated_verify_value';

      await post({ id: row!.id, phoneNumberId: row!.phoneNumberId, webhookVerifyToken: rotated });

      const after = await prisma.whatsAppConfig.findUnique({ where: { id: row!.id } });
      expect(decryptSecret(after!.webhookVerifyToken, 'test')).toBe(rotated);
      // And did not disturb the other one.
      expect(decryptSecret(after!.accessToken, 'test')).toBe(TOKEN);
    });

    it('still refuses to CREATE a line with no credentials', async () => {
      await prisma.whatsAppConfig.deleteMany({ where: { organizationId: orgId } });
      const res = await post({ phoneNumberId: '1319842031202307' });
      // Nothing stored to fall back on, and a row without a token is a line
      // that reaches nobody.
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/new whatsapp line needs both/i);
    });
  });
});
