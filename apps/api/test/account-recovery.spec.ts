/**
 * Every route back into an account goes through EMAIL, and email is optional.
 *
 * `RESEND_API_KEY` is declared optional in `env.validation.ts` — correctly,
 * because this platform serves citizens on WhatsApp and by phone and needs no
 * email provider to do it. But four staff-facing paths depend on it entirely:
 * the staff invitation, email verification, resend-verification, and the
 * password reset. Each one answered 200 with nothing delivered.
 *
 * The invitation is the worst of them. An invited officer is created with a
 * bcrypt hash of random bytes, so no password reaches the account; the invite
 * token is stored only as a SHA-256 hash, so once the function returns the raw
 * link exists nowhere. With delivery silently failing, an administrator was
 * told the officer had been invited, the officer got nothing, and the link
 * needed to repair it was already gone.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { OrganizationsService } from '../src/organizations/organizations.service';

describe('account recovery when email cannot be delivered', () => {
  let app: INestApplication;
  let organizations: OrganizationsService;
  let orgId: string;

  jest.setTimeout(60000);

  const realResendKey = process.env.RESEND_API_KEY;

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    // The condition under test: no provider configured.
    delete process.env.RESEND_API_KEY;

    app = await createTestApp();
    organizations = app.get(OrganizationsService);

    const org = await prisma.organization.create({
      data: { name: 'Recovery Agency', slug: `recovery-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    if (realResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = realResendKey;
    await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  it('tells the administrator the invitation was not delivered, and hands them the link', async () => {
    const email = `invitee.${randomBytes(4).toString('hex')}@recovery.test`;
    const result: any = await organizations.addTeamMember(
      orgId,
      { email, fullName: 'Stranded Officer', role: 'AGENT' },
      { userId: 'test-actor', ipAddress: null }
    );

    // Not a bare success. The administrator is told what happened and why.
    expect(result.emailDelivered).toBe(false);
    expect(String(result.deliveryProblem)).toMatch(/RESEND_API_KEY is unset/);

    // And given the one credential that can still activate the account. It is
    // stored only as a hash, so this response is the last copy in existence —
    // withholding it strands an officer who can never sign in.
    expect(result.inviteUrl).toContain('/setup-account?token=');

    const token = new URL(result.inviteUrl).searchParams.get('token')!;
    const setup = await request(app.getHttpServer())
      .post('/api/auth/setup-account')
      .send({ token, password: 'RecoveredPassw0rd!' });
    expect(setup.status).toBe(201);
    expect(setup.body.accessToken).toBeTruthy();

    // Proof the link was real: the officer can now sign in unaided.
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: 'RecoveredPassw0rd!' });
    expect(login.status).toBe(201);
  });

  it('does not put a working credential in the response when delivery succeeded', async () => {
    process.env.RESEND_API_KEY = 'test_key_that_will_make_resend_fail_fast';
    try {
      const email = `invitee2.${randomBytes(4).toString('hex')}@recovery.test`;
      const result: any = await organizations.addTeamMember(
        orgId,
        { email, fullName: 'Second Officer', role: 'VIEWER' },
        { userId: 'test-actor', ipAddress: null }
      );
      // Resend RESOLVES with `{ data, error }` rather than throwing, so a
      // bogus key came back as a delivered invitation until the `error` field
      // was read. The flag must reflect what HAPPENED, not whether a key
      // happens to be present — and the first version of this fix got that
      // wrong in exactly the same way the original code did.
      expect(result.emailDelivered).toBe(false);
      expect(String(result.deliveryProblem)).toMatch(/refused/i);
      // The link is still handed over, because the officer still cannot sign
      // in without it.
      expect(result.inviteUrl).toContain('/setup-account?token=');
    } finally {
      delete process.env.RESEND_API_KEY;
    }
  });

  it('does not claim a password reset was sent when none was', async () => {
    const email = `reset.${randomBytes(4).toString('hex')}@recovery.test`;
    await prisma.user.create({
      data: {
        organizationId: orgId, email, fullName: 'Reset Officer', role: 'AGENT',
        passwordHash: await bcrypt.hash('OriginalPassw0rd!', 10), emailVerifiedAt: new Date(),
      },
    });

    const errors: string[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation(((m: unknown) => {
      errors.push(String(m));
    }) as any);

    let res: any;
    try {
      res = await request(app.getHttpServer()).post('/api/auth/forgot-password').send({ email });
    } finally {
      spy.mockRestore();
    }

    expect(res.status).toBe(201);
    // It must NOT assert a delivery. "have been sent" was a statement about
    // mail that was never handed to anything.
    expect(String(res.body.message)).not.toMatch(/have been sent/i);
    // It must still say nothing about whether the account exists.
    expect(String(res.body.message)).toMatch(/if an account exists/i);
    // And it must say what to do when nothing arrives, which is the difference
    // between a recoverable account and a permanent lockout.
    expect(String(res.body.message)).toMatch(/email delivery may not be configured/i);

    // The operator who can fix it reads the server log, so the failure is at
    // ERROR level in every environment — not a DEV-only console.warn.
    const logged = errors.join('\n');
    expect(logged).toMatch(/PASSWORD RESET EMAIL WAS NOT SENT/);
    expect(logged).toMatch(/npm run user:password/);
  });

  it('says the same thing for an address it does not know', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/forgot-password')
      .send({ email: `nobody.${randomBytes(4).toString('hex')}@recovery.test` });
    expect(res.status).toBe(201);
    // Byte for byte the same as the known-address response: that identical
    // wording is the whole anti-enumeration property.
    expect(String(res.body.message)).toMatch(/if an account exists/i);
    expect(String(res.body.message)).toMatch(/email delivery may not be configured/i);
  });

  it('writes the reset token even though nothing was sent, so the link stays usable', async () => {
    const email = `reset2.${randomBytes(4).toString('hex')}@recovery.test`;
    const user = await prisma.user.create({
      data: {
        organizationId: orgId, email, fullName: 'Second Reset', role: 'AGENT',
        passwordHash: await bcrypt.hash('OriginalPassw0rd!', 10), emailVerifiedAt: new Date(),
      },
    });

    await request(app.getHttpServer()).post('/api/auth/forgot-password').send({ email });

    // The token exists and is in date. An operator reading the DEV log — or
    // using npm run user:password — has something to work with; a route that
    // skipped the write on a failed send would leave nothing at all.
    const row = await prisma.user.findUnique({ where: { id: user.id } });
    expect(row!.passwordResetToken).toHaveLength(64);
    expect(row!.passwordResetExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('declares in env validation what an unset key costs', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ENV_SPECS } = require('../src/config/env.validation');
    const resend = ENV_SPECS.find((v: any) => v.key === 'RESEND_API_KEY');
    expect(resend).toBeTruthy();
    // Optional is right — citizens are served on WhatsApp and by phone — but
    // "optional" must not read as "costs nothing".
    expect(resend.required).toBe(false);
    expect(resend.description).toMatch(/invitation/i);
    expect(resend.description).toMatch(/silent/i);
    expect(resend.description).toMatch(/user:password/);
  });
});
