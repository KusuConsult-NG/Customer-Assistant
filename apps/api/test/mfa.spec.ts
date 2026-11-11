/**
 * Two-step sign-in for privileged users (PRD §17).
 *
 * Pinned: a correct password with MFA on yields NO session, only a step token
 * that cannot be used as one; a code works once (no replay); a wrong code
 * counts toward lockout; recovery codes are single-use; and an agency that
 * requires MFA gets its administrators enrolled before they get in.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { prisma } from '@ace/database';
import { createTestApp } from './support/create-test-app';
import { createTenant, dropTenant, TestTenant } from './support/tenant';
import { currentStep, totpAt } from '../src/auth/totp';

describe('Two-step sign-in', () => {
  let app: INestApplication;
  let t: TestTenant;
  const PASSWORD = 'Correct-Horse-Battery-9';
  let email: string;
  jest.setTimeout(60000);

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');
    app = await createTestApp();
    t = await createTenant(app, 'mfa', { role: 'OWNER' });
    email = t.email;
    await prisma.user.update({ where: { id: t.userId }, data: { passwordHash: await bcrypt.hash(PASSWORD, 10), emailVerifiedAt: new Date() } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { organizationId: t.orgId } });
    await dropTenant(t?.orgId);
    await app?.close();
  });

  let secret: string;
  let recovery: string[];

  it('enrols with a code from the app, and keeps the secret encrypted', async () => {
    const setup = await http().post('/api/auth/mfa/setup').set('Authorization', `Bearer ${t.token}`).expect(201);
    secret = setup.body.secret;
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    await http().post('/api/auth/mfa/enable').set('Authorization', `Bearer ${t.token}`).send({ code: '000000' }).expect(400);
    const on = await http()
      .post('/api/auth/mfa/enable')
      .set('Authorization', `Bearer ${t.token}`)
      .send({ code: totpAt(secret, currentStep()) })
      .expect(201);
    recovery = on.body.recoveryCodes;
    expect(recovery).toHaveLength(8);
    const row = await prisma.user.findUnique({ where: { id: t.userId } });
    expect(row!.mfaSecret).toMatch(/^v1\./);
    expect(row!.mfaSecret).not.toContain(secret);
    expect(row!.mfaRecoveryHashes).not.toContain(recovery[0]);
  });

  it('gives no session for the password alone, and the step token is not a session', async () => {
    const res = await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(201);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    await http().get('/api/auth/mfa/status').set('Authorization', `Bearer ${res.body.mfaToken}`).expect(401);
    await http().get('/api/organizations/me').set('Authorization', `Bearer ${res.body.mfaToken}`).expect(401);

    const before = (await prisma.user.findUnique({ where: { id: t.userId } }))!.failedLoginAttempts;
    await http().post('/api/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: '111111' }).expect(401);
    const after = (await prisma.user.findUnique({ where: { id: t.userId } }))!.failedLoginAttempts;
    expect(after).toBe(before + 1);

    // The enrolment code's step is spent; the next step is a fresh code.
    const next = totpAt(secret, currentStep() + 1);
    const ok = await http().post('/api/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: next }).expect(201);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.body.user.id).toBe(t.userId);

    // Replay: the same code, a second time, is refused.
    await http().post('/api/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: next }).expect(401);
  });

  it('accepts a recovery code once', async () => {
    const res = await http().post('/api/auth/login').send({ email, password: PASSWORD }).expect(201);
    await http().post('/api/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: recovery[0] }).expect(201);
    await http().post('/api/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: recovery[0] }).expect(401);
    const row = await prisma.user.findUnique({ where: { id: t.userId } });
    expect(row!.mfaRecoveryHashes).toHaveLength(7);
  });

  it('makes an administrator enrol before they get in when the agency requires it', async () => {
    await http().patch('/api/organizations/settings').set('Authorization', `Bearer ${t.token}`).send({ requireAdminMfa: true }).expect(200);
    const adminEmail = `mfa-admin-${randomBytes(3).toString('hex')}@tenant.test`;
    await prisma.user.create({
      data: { organizationId: t.orgId, email: adminEmail, passwordHash: await bcrypt.hash(PASSWORD, 10), fullName: 'Admin', role: 'ADMIN', emailVerifiedAt: new Date() },
    });
    const res = await http().post('/api/auth/login').send({ email: adminEmail, password: PASSWORD }).expect(201);
    expect(res.body.mfaSetupRequired).toBe(true);
    expect(res.body.accessToken).toBeUndefined();
    // A setup token cannot complete a LOGIN step, and vice versa.
    await http().post('/api/auth/mfa/verify').send({ mfaToken: res.body.mfaToken, code: '123456' }).expect(401);

    const setup = await http().post('/api/auth/mfa/enrol/setup').send({ mfaToken: res.body.mfaToken }).expect(201);
    const done = await http()
      .post('/api/auth/mfa/enrol/enable')
      .send({ mfaToken: res.body.mfaToken, code: totpAt(setup.body.secret, currentStep()) })
      .expect(201);
    expect(done.body.accessToken).toBeTruthy();
    expect(done.body.recoveryCodes).toHaveLength(8);

    // And it cannot be switched off while the agency requires it.
    const status = await http().get('/api/auth/mfa/status').set('Authorization', `Bearer ${done.body.accessToken}`).expect(200);
    expect(status.body).toMatchObject({ enabled: true, requiredByAgency: true });
    await http()
      .post('/api/auth/mfa/disable')
      .set('Authorization', `Bearer ${done.body.accessToken}`)
      .send({ code: done.body.recoveryCodes[0] })
      .expect(403);
  });
});
