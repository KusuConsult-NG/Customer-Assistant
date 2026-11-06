/**
 * The eight authentication routes nothing was driving over HTTP.
 *
 * `/api/auth/login` and `/api/auth/register` were covered. Everything an
 * account does AFTER that first sign-in was not: verify-email (both the POST
 * and the GET a mail client follows), refresh, logout, change-password,
 * forgot-password, reset-password and setup-account. Those are the routes a
 * locked-out officer depends on, they are mostly UNAUTHENTICATED, and they are
 * the ones a staff member meets on their worst day.
 *
 * Each test here issues a real request and asserts the EFFECT — a token that
 * actually stops working, a password that actually changes — rather than that
 * a 200 came back. A reset endpoint that returns its cheerful "if an account
 * exists" message while writing nothing passes a status-code test perfectly.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomBytes, createHash } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { prisma } from '@ace/database';
import { OrganizationsService } from '../src/organizations/organizations.service';
import { AuthService } from '../src/auth/auth.service';
import { createTestApp } from './support/create-test-app';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('the authentication lifecycle', () => {
  let app: INestApplication;
  let orgId: string;

  jest.setTimeout(90000);

  const PASSWORD = 'LifecyclePassw0rd!';

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'test_jwt_secret_that_is_at_least_32_chars_long';
    process.env.JWT_REFRESH_SECRET ??= 'test_jwt_refresh_secret_at_least_32_chars';
    process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('base64');

    // Configured as bootstrap() configures production — including the global
    // ValidationPipe, without which a route's @MinLength(8) is not enforced in
    // the test app at all and an invalid-password test reads as a finding.
    app = await createTestApp();

    const org = await prisma.organization.create({
      data: { name: 'Lifecycle Agency', slug: `lifecycle-${randomBytes(4).toString('hex')}`, industry: 'GOVERNMENT' },
    });
    orgId = org.id;
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await app.close();
  });

  /** A verified, signed-in user. Created directly: register is throttled 5/min per IP. */
  const makeUser = async (overrides: Record<string, unknown> = {}) => {
    const email = `life.${randomBytes(5).toString('hex')}@lifecycle.test`;
    const user = await prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        fullName: 'Lifecycle Officer',
        role: 'AGENT',
        passwordHash: await bcrypt.hash(PASSWORD, 10),
        emailVerifiedAt: new Date(),
        ...overrides,
      },
    });
    return user;
  };

  const login = (email: string, password = PASSWORD) =>
    request(app.getHttpServer()).post('/api/auth/login').send({ email, password });

  const signIn = async (email: string, password = PASSWORD) => {
    const res = await login(email, password);
    expect(res.status).toBe(201);
    return res.body as { accessToken: string; refreshToken: string };
  };

  /** Any authenticated route will do; this one needs no fixtures. */
  const whoAmI = (token: string) =>
    request(app.getHttpServer()).get('/api/organizations/me').set('Authorization', `Bearer ${token}`);

  describe('POST /api/auth/refresh', () => {
    it('exchanges a refresh token for a working pair', async () => {
      const user = await makeUser();
      const first = await signIn(user.email);

      const res = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: first.refreshToken });
      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTruthy();
      // Asserted by USE, not by shape: a token that parses but is rejected on
      // every request is the failure this is meant to catch.
      expect((await whoAmI(res.body.accessToken)).status).toBe(200);
    });

    it('refuses the same refresh token a second time', async () => {
      const user = await makeUser();
      const first = await signIn(user.email);

      const once = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: first.refreshToken });
      expect(once.status).toBe(201);

      // Rotation bumps tokenVersion, so replaying a stolen refresh token
      // fails rather than minting a second live session beside the real one.
      const twice = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: first.refreshToken });
      expect(twice.status).toBe(401);
    });

    it('refuses a refresh token for a deactivated account', async () => {
      const user = await makeUser();
      const { refreshToken } = await signIn(user.email);
      await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

      const res = await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken });
      expect(res.status).toBe(401);
      expect(String(res.body.message)).toMatch(/deactivated/i);
    });

    it('refuses a forged token', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: 'not.a.token' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('invalidates every token already issued, not just the one presented', async () => {
      const user = await makeUser();
      const sessionA = await signIn(user.email);
      const sessionB = await signIn(user.email);

      expect((await whoAmI(sessionA.accessToken)).status).toBe(200);
      expect((await whoAmI(sessionB.accessToken)).status).toBe(200);

      const res = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${sessionA.accessToken}`);
      expect(res.status).toBe(201);

      // THE assertion. tokenVersion is bumped, so signing out on one device
      // signs out the laptop left on a shared desk too. An implementation that
      // only forgot the presented token would pass a 200-only test.
      expect((await whoAmI(sessionA.accessToken)).status).toBe(401);
      expect((await whoAmI(sessionB.accessToken)).status).toBe(401);
      // And the refresh token cannot resurrect the session either.
      const refreshed = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .send({ refreshToken: sessionB.refreshToken });
      expect(refreshed.status).toBe(401);
    });

    it('is not reachable without a token', async () => {
      expect((await request(app.getHttpServer()).post('/api/auth/logout')).status).toBe(401);
    });
  });

  describe('POST /api/auth/change-password', () => {
    it('changes the password and signs every session out', async () => {
      const user = await makeUser();
      const session = await signIn(user.email);
      const next = 'ChangedPassw0rd!';

      const res = await request(app.getHttpServer())
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: next });
      expect(res.status).toBe(201);

      // The old password must stop working and the new one must start.
      expect((await login(user.email, PASSWORD)).status).toBe(401);
      expect((await login(user.email, next)).status).toBe(201);
      // And the session that changed it is signed out, like every other.
      expect((await whoAmI(session.accessToken)).status).toBe(401);
    });

    it('refuses a wrong current password, and changes nothing', async () => {
      const user = await makeUser();
      const session = await signIn(user.email);

      const res = await request(app.getHttpServer())
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ currentPassword: 'NotTheirPassw0rd!', newPassword: 'Whatever123!' });
      expect(res.status).toBeGreaterThanOrEqual(400);

      // Still the original password — a refusal that had already written the
      // new hash would lock the officer out while reporting an error.
      expect((await login(user.email, PASSWORD)).status).toBe(201);
    });

    it('refuses a new password under eight characters', async () => {
      const user = await makeUser();
      const session = await signIn(user.email);
      const res = await request(app.getHttpServer())
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ currentPassword: PASSWORD, newPassword: 'short' });
      expect(res.status).toBe(400);
      expect((await login(user.email, PASSWORD)).status).toBe(201);
    });
  });

  describe('forgot-password → reset-password', () => {
    it('issues a token and sets the new password with it', async () => {
      const user = await makeUser();
      const session = await signIn(user.email);

      const forgot = await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: user.email });
      expect(forgot.status).toBe(201);
      // Deliberately vague: the response must not say whether the address is
      // known, or it becomes an account-enumeration oracle.
      expect(String(forgot.body.message)).toMatch(/if an account exists/i);

      // The raw token is only ever emailed, so the test reads the row to prove
      // one was actually WRITTEN. A route that returns the safe message and
      // stores nothing passes a status-code test and helps nobody.
      const row = await prisma.user.findUnique({ where: { id: user.id } });
      expect(row!.passwordResetToken).toBeTruthy();
      expect(row!.passwordResetExpiresAt!.getTime()).toBeGreaterThan(Date.now());

      // Mint our own token the same way the service does, since the emailed
      // one is not observable here.
      const raw = randomBytes(32).toString('hex');
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: sha256(raw), passwordResetExpiresAt: new Date(Date.now() + 600_000) },
      });

      const next = 'ResetPassw0rd!';
      const reset = await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token: raw, newPassword: next });
      expect(reset.status).toBe(201);

      expect((await login(user.email, next)).status).toBe(201);
      expect((await login(user.email, PASSWORD)).status).toBe(401);
      // A reset is what you do when you think the password was stolen, so it
      // must end every session that password opened.
      expect((await whoAmI(session.accessToken)).status).toBe(401);
    });

    it('consumes the token, so a reset link cannot be replayed', async () => {
      const user = await makeUser();
      const raw = randomBytes(32).toString('hex');
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: sha256(raw), passwordResetExpiresAt: new Date(Date.now() + 600_000) },
      });

      expect(
        (await request(app.getHttpServer()).post('/api/auth/reset-password').send({ token: raw, newPassword: 'FirstReset1!' })).status
      ).toBe(201);
      // A link in a mailbox is readable by anyone who later reaches that
      // mailbox; one use is all it gets.
      expect(
        (await request(app.getHttpServer()).post('/api/auth/reset-password').send({ token: raw, newPassword: 'SecondReset1!' })).status
      ).toBe(400);
      expect((await login(user.email, 'FirstReset1!')).status).toBe(201);
    });

    it('refuses an expired token', async () => {
      const user = await makeUser();
      const raw = randomBytes(32).toString('hex');
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: sha256(raw), passwordResetExpiresAt: new Date(Date.now() - 1000) },
      });

      const res = await request(app.getHttpServer())
        .post('/api/auth/reset-password')
        .send({ token: raw, newPassword: 'ExpiredReset1!' });
      expect(res.status).toBe(400);
      expect((await login(user.email, PASSWORD)).status).toBe(201);
    });

    it('clears a lockout, because resetting is the documented way out of one', async () => {
      const user = await makeUser({
        failedLoginAttempts: 9,
        lockedUntil: new Date(Date.now() + 3600_000),
      });
      const raw = randomBytes(32).toString('hex');
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: sha256(raw), passwordResetExpiresAt: new Date(Date.now() + 600_000) },
      });

      const next = 'UnlockedPassw0rd!';
      expect(
        (await request(app.getHttpServer()).post('/api/auth/reset-password').send({ token: raw, newPassword: next })).status
      ).toBe(201);

      // The lockout message tells the officer to reset their password. If the
      // reset left the lock in place, that advice was a dead end.
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.lockedUntil).toBeNull();
      expect(after!.failedLoginAttempts).toBe(0);
      expect((await login(user.email, next)).status).toBe(201);
    });

    it('says nothing different for an address it does not know', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: `nobody.${randomBytes(4).toString('hex')}@lifecycle.test` });
      expect(res.status).toBe(201);
      expect(String(res.body.message)).toMatch(/if an account exists/i);
    });
  });

  describe('email verification', () => {
    it('verifies by POST and consumes the token', async () => {
      const raw = randomBytes(32).toString('hex');
      const user = await makeUser({
        emailVerifiedAt: null,
        emailVerifyToken: sha256(raw),
        emailVerifyExpiresAt: new Date(Date.now() + 600_000),
      });

      const res = await request(app.getHttpServer()).post('/api/auth/verify-email').send({ token: raw });
      expect(res.status).toBe(201);

      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after!.emailVerifiedAt).toBeTruthy();
      expect(after!.emailVerifyToken).toBeNull();

      // Replay is refused rather than silently re-verifying.
      expect((await request(app.getHttpServer()).post('/api/auth/verify-email').send({ token: raw })).status).toBe(400);
    });

    it('verifies by GET, which is what a mail client actually follows', async () => {
      const raw = randomBytes(32).toString('hex');
      const user = await makeUser({
        emailVerifiedAt: null,
        emailVerifyToken: sha256(raw),
        emailVerifyExpiresAt: new Date(Date.now() + 600_000),
      });

      // The emailed link is a GET. A POST-only implementation means every
      // officer who clicks the link gets a 404 from their browser.
      const res = await request(app.getHttpServer()).get(`/api/auth/verify-email?token=${raw}`);
      expect(res.status).toBe(200);
      expect((await prisma.user.findUnique({ where: { id: user.id } }))!.emailVerifiedAt).toBeTruthy();
    });

    it('refuses an expired verification token', async () => {
      const raw = randomBytes(32).toString('hex');
      const user = await makeUser({
        emailVerifiedAt: null,
        emailVerifyToken: sha256(raw),
        emailVerifyExpiresAt: new Date(Date.now() - 1000),
      });
      expect((await request(app.getHttpServer()).post('/api/auth/verify-email').send({ token: raw })).status).toBe(400);
      expect((await prisma.user.findUnique({ where: { id: user.id } }))!.emailVerifiedAt).toBeNull();
    });
  });

  describe('POST /api/auth/setup-account — the invited officer', () => {
    it('activates the account and signs them in', async () => {
      const organizations = app.get(OrganizationsService);
      const email = `invited.${randomBytes(4).toString('hex')}@lifecycle.test`;

      // Through the real invite path, so the token this consumes is the token
      // that path actually writes.
      await organizations.addTeamMember(
        orgId,
        { email, fullName: 'Invited Officer', role: 'AGENT' },
        { userId: 'test-actor', ipAddress: null }
      );
      const invited = await prisma.user.findUnique({ where: { email } });
      expect(invited!.passwordResetToken).toBeTruthy();

      const raw = randomBytes(32).toString('hex');
      await prisma.user.update({
        where: { id: invited!.id },
        data: { passwordResetToken: sha256(raw), passwordResetExpiresAt: new Date(Date.now() + 600_000) },
      });

      const password = 'InvitedPassw0rd!';
      const res = await request(app.getHttpServer())
        .post('/api/auth/setup-account')
        .send({ token: raw, password });
      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeTruthy();
      expect((await whoAmI(res.body.accessToken)).status).toBe(200);

      const after = await prisma.user.findUnique({ where: { id: invited!.id } });
      // Clicking a link delivered only to that mailbox proves control of it.
      expect(after!.emailVerifiedAt).toBeTruthy();
      expect(after!.passwordResetToken).toBeNull();
      expect((await login(email, password)).status).toBe(201);
    });

    it('refuses an invitation token that has already been used', async () => {
      const organizations = app.get(OrganizationsService);
      const email = `invited2.${randomBytes(4).toString('hex')}@lifecycle.test`;
      await organizations.addTeamMember(
        orgId,
        { email, fullName: 'Second Invited', role: 'VIEWER' },
        { userId: 'test-actor', ipAddress: null }
      );
      const invited = await prisma.user.findUnique({ where: { email } });

      const raw = randomBytes(32).toString('hex');
      await prisma.user.update({
        where: { id: invited!.id },
        data: { passwordResetToken: sha256(raw), passwordResetExpiresAt: new Date(Date.now() + 600_000) },
      });

      expect((await request(app.getHttpServer()).post('/api/auth/setup-account').send({ token: raw, password: 'FirstSetup1!' })).status).toBe(201);
      expect((await request(app.getHttpServer()).post('/api/auth/setup-account').send({ token: raw, password: 'SecondSetup1!' })).status).toBe(400);
    });

    it('invites an officer at an address they can actually sign in with', async () => {
      const organizations = app.get(OrganizationsService);
      // THE regression. Every reader lowercases — login, forgot-password,
      // resend-verification all look up `email.trim().toLowerCase()` — and
      // this path wrote the address exactly as the administrator typed it.
      //
      // So an invite to a mixed-case address stored a row no lookup could
      // find. The invite link still worked, because setup-account matches on
      // the TOKEN, so the officer set a password and was signed straight in.
      // The next time she signed in she was told "Invalid email or password
      // credentials", and forgot-password returned "if an account exists"
      // while sending nothing. She was locked out permanently with nothing in
      // any log to say why.
      const typed = `Jane.Doe.${randomBytes(4).toString('hex')}@Lifecycle.TEST`;
      await organizations.addTeamMember(
        orgId,
        { email: typed, fullName: 'Jane Doe', role: 'AGENT' },
        { userId: 'test-actor', ipAddress: null }
      );

      const stored = await prisma.user.findUnique({ where: { email: typed.toLowerCase() } });
      expect(stored).not.toBeNull();
      expect(stored!.email).toBe(typed.toLowerCase());

      const raw = randomBytes(32).toString('hex');
      await prisma.user.update({
        where: { id: stored!.id },
        data: { passwordResetToken: sha256(raw), passwordResetExpiresAt: new Date(Date.now() + 600_000) },
      });
      const password = 'MixedCasePassw0rd!';
      expect((await request(app.getHttpServer()).post('/api/auth/setup-account').send({ token: raw, password })).status).toBe(201);

      // Signing in as typed, and as lowercased: both must reach the one row.
      expect((await login(typed, password)).status).toBe(201);
      expect((await login(typed.toLowerCase(), password)).status).toBe(201);

      // And recovery works, which is what made the original bug permanent.
      const forgot = await request(app.getHttpServer())
        .post('/api/auth/forgot-password')
        .send({ email: typed });
      expect(forgot.status).toBe(201);
      expect((await prisma.user.findUnique({ where: { id: stored!.id } }))!.passwordResetToken).toBeTruthy();
    });

    it('refuses a second invite to the same address, whatever its casing', async () => {
      const organizations = app.get(OrganizationsService);
      const email = `dupe.${randomBytes(4).toString('hex')}@lifecycle.test`;
      await organizations.addTeamMember(
        orgId,
        { email, fullName: 'First', role: 'AGENT' },
        { userId: 'test-actor', ipAddress: null }
      );

      // `User.email` is @unique, so without normalisation this created a
      // SECOND officer whose address differs only in case.
      await expect(
        organizations.addTeamMember(
          orgId,
          { email: email.toUpperCase(), fullName: 'Impostor', role: 'OWNER' },
          { userId: 'test-actor', ipAddress: null }
        )
      ).rejects.toThrow(/already/i);

      expect(await prisma.user.count({ where: { organizationId: orgId, email: email.toLowerCase() } })).toBe(1);
    });
  });

  describe('the persona a new agency starts with', () => {
    /**
     * This is the string the orchestrator hands the model as `basePrompt`
     * (packages/orchestrator/src/index.ts), so it frames every answer a
     * citizen reads before any tenant touches Settings.
     *
     * It used to read "You are the lead AI customer service representative
     * for <name>, operating in Nigeria." On a platform whose tenants are
     * ministries and whose users are citizens asking which office to walk
     * into, that framing is how a question about an MDA gets answered like a
     * support ticket. Nothing pinned it, so nothing would have objected.
     *
     * Registered through the service rather than the route because
     * /api/auth/register is throttled 5/min per IP.
     */
    let createdOrgId: string | undefined;
    let createdUserId: string | undefined;

    afterAll(async () => {
      if (createdUserId) await prisma.user.deleteMany({ where: { id: createdUserId } });
      if (createdOrgId) {
        await prisma.auditLog.deleteMany({ where: { organizationId: createdOrgId } });
        await prisma.user.deleteMany({ where: { organizationId: createdOrgId } });
        await prisma.organization.delete({ where: { id: createdOrgId } }).catch(() => undefined);
      }
    });

    it('frames the assistant as a public information officer, and forbids inventing', async () => {
      const auth = app.get(AuthService);
      const suffix = randomBytes(5).toString('hex');

      await auth.registerOrganization({
        organizationName: `Persona Test Agency ${suffix}`,
        email: `persona.${suffix}@lifecycle.test`,
        password: PASSWORD,
        fullName: 'Persona Officer',
        industry: 'GOVERNMENT',
        phone: '+2348000000000',
      } as any);

      const org = await prisma.organization.findFirst({
        where: { name: `Persona Test Agency ${suffix}` },
        select: { id: true, aiPersonaPrompt: true, welcomeMessage: true, users: { select: { id: true } } },
      });
      expect(org).toBeTruthy();
      createdOrgId = org!.id;
      createdUserId = org!.users[0]?.id;

      const persona = org!.aiPersonaPrompt ?? '';

      // The regression itself: commercial framing is gone.
      expect(persona).not.toMatch(/customer service representative/i);
      expect(persona).not.toMatch(/\bcustomers?\b/i);

      // Citizen-service framing is present, and names the agency.
      expect(persona).toMatch(/information officer/i);
      expect(persona).toMatch(/members of the public/i);
      expect(persona).toContain(`Persona Test Agency ${suffix}`);

      // The honesty rule is in the DEFAULT, not only in code the tenant
      // cannot see — a persona is the one string a tenant can overwrite.
      expect(persona).toMatch(/never invent/i);
      expect(persona).toMatch(/ask one\s+question|ask one question/i);

      // And the greeting invites a question rather than offering a menu.
      expect(org!.welcomeMessage ?? '').toMatch(/in your own words/i);
    });
  });
});
