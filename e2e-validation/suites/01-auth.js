/**
 * Suite 01 — Authentication & session lifecycle.
 * Registration, login, verification, reset, revocation, expiry, concurrency.
 */
const H = require('../harness');
const { api, prisma, check, suite, state, uniq, registerOrg, createUser, seedUser, seedSession, loginAs, sleep } = H;

module.exports = async function () {
  suite('01 · Authentication & Sessions');

  // ── Registration happy path ───────────────────────────────────────────────
  const email = `${uniq('auth')}@e2e.test`;
  const password = 'E2eValidPassw0rd!';
  let regBody;

  await check('AUTH-001', 'Register creates organization + OWNER user in DB', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { organizationName: `AuthOrg ${H.RUN_ID}`, industry: 'SME', fullName: 'Ada Owner', email, password, country: 'Nigeria' },
    });
    regBody = res.body;
    if (res.status !== 201 && res.status !== 200) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 200)}` };

    const user = await prisma.user.findUnique({ where: { email }, include: { organization: true } });
    if (!user) return { expected: 'user row', actual: 'no user in DB' };
    if (user.role !== 'OWNER') return { expected: 'role OWNER', actual: user.role };
    if (user.organization.country !== 'Nigeria') return { expected: 'country persisted', actual: user.organization.country };
    if (user.passwordHash === password) return { expected: 'hashed password', actual: 'PLAINTEXT PASSWORD STORED' };
    if (!user.passwordHash.startsWith('$2')) return { expected: 'bcrypt hash', actual: user.passwordHash.slice(0, 10) };
    return { ok: true, evidence: `user=${user.id} org=${user.organizationId} hash=${user.passwordHash.slice(0, 7)}…` };
  }, 'CRITICAL');

  await check('AUTH-002', 'Register issues an email verification token (hashed, with expiry)', async () => {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user.emailVerifyToken) return { expected: 'token stored', actual: 'null' };
    if (user.emailVerifyToken.length !== 64) return { expected: 'sha256 hex (64)', actual: `len=${user.emailVerifyToken.length}` };
    if (!user.emailVerifyExpiresAt) return { expected: 'expiry set', actual: 'null' };
    return { ok: true, evidence: `expires=${user.emailVerifyExpiresAt.toISOString()}` };
  });

  await check('AUTH-003', 'Duplicate email registration is rejected with 409', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { organizationName: 'Dupe', industry: 'SME', fullName: 'Dupe', email, password },
    });
    return res.status === 409 ? { ok: true, evidence: `409 ${res.body?.message}` } : { expected: '409', actual: String(res.status) };
  });

  await check('AUTH-004', 'Email is normalised — Mixed-Case duplicate also rejected', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { organizationName: 'Dupe2', industry: 'SME', fullName: 'Dupe', email: email.toUpperCase(), password },
    });
    return res.status === 409
      ? { ok: true, evidence: '409 on uppercase variant' }
      : { expected: '409 (case-insensitive uniqueness)', actual: `${res.status} — duplicate account created under different casing`, evidence: email.toUpperCase() };
  });

  // ── Registration validation ───────────────────────────────────────────────
  const badRegs = [
    ['AUTH-010', 'legacy adminEmail/adminPassword field names', { organizationName: 'X', industry: 'SME', adminFullName: 'A', adminEmail: 'a@b.co', adminPassword: 'Passw0rd!' }],
    ['AUTH-011', 'industry outside enum', { organizationName: 'X', industry: 'HOSPITALITY', fullName: 'A', email: `${uniq('bad')}@e2e.test`, password: 'Passw0rd!' }],
    ['AUTH-012', 'password under 8 chars', { organizationName: 'X', industry: 'SME', fullName: 'A', email: `${uniq('bad')}@e2e.test`, password: 'short' }],
    ['AUTH-013', 'malformed email', { organizationName: 'X', industry: 'SME', fullName: 'A', email: 'not-an-email', password: 'Passw0rd!' }],
    ['AUTH-014', 'empty body', {}],
    ['AUTH-015', 'null organizationName', { organizationName: null, industry: 'SME', fullName: 'A', email: `${uniq('bad')}@e2e.test`, password: 'Passw0rd!' }],
  ];
  for (const [id, label, body] of badRegs) {
    await check(id, `Register rejects ${label} with 400`, async () => {
      const res = await api('POST', '/api/auth/register', { body });
      return res.status === 400 ? { ok: true, evidence: `400` } : { expected: '400', actual: `${res.status} ${res.text.slice(0, 120)}` };
    });
  }

  await check('AUTH-016', 'Register rejects 10k-char organization name (boundary)', async () => {
    const res = await api('POST', '/api/auth/register', {
      body: { organizationName: 'A'.repeat(10000), industry: 'SME', fullName: 'A', email: `${uniq('big')}@e2e.test`, password: 'Passw0rd!' },
    });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  }, 'MEDIUM');

  await check('AUTH-017', 'Unicode + emoji in names are accepted and stored intact', async () => {
    const e = `${uniq('uni')}@e2e.test`;
    const name = 'Ọlámidé 北京 🚀 Ltd';
    const res = await api('POST', '/api/auth/register', {
      body: { organizationName: name, industry: 'SME', fullName: 'Chán Ọ̀kẹ́ 😀', email: e, password: 'Passw0rd!' },
    });
    if (res.status !== 201 && res.status !== 200) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const u = await prisma.user.findUnique({ where: { email: e }, include: { organization: true } });
    if (u.organization.name !== name) return { expected: name, actual: u.organization.name };
    return { ok: true, evidence: `stored "${u.organization.name}" / "${u.fullName}"` };
  }, 'MEDIUM');

  // ── Login ─────────────────────────────────────────────────────────────────
  let session;
  await check('AUTH-020', 'Login returns access + refresh token and user payload', async () => {
    const res = await api('POST', '/api/auth/login', { body: { email, password } });
    session = res.body;
    if (res.status !== 200 && res.status !== 201) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };
    if (!res.body.accessToken) return { expected: 'accessToken', actual: 'missing' };
    if (!res.body.refreshToken) return { expected: 'refreshToken', actual: 'missing' };
    if (res.body.user?.passwordHash) return { expected: 'no password hash in response', actual: 'passwordHash LEAKED to client' };
    return { ok: true, evidence: `user=${res.body.user.id} role=${res.body.user.role}` };
  }, 'CRITICAL');

  await check('AUTH-021', 'Login with wrong password is rejected 401', async () => {
    const res = await api('POST', '/api/auth/login', { body: { email, password: 'WrongPassw0rd!' } });
    return res.status === 401 ? { ok: true } : { expected: '401', actual: String(res.status) };
  }, 'CRITICAL');

  await check('AUTH-022', 'Login for unknown user is rejected 401 (no enumeration)', async () => {
    const res = await api('POST', '/api/auth/login', { body: { email: 'nobody@e2e.test', password: 'Passw0rd!' } });
    if (res.status !== 401) return { expected: '401', actual: String(res.status) };
    const wrongPw = await api('POST', '/api/auth/login', { body: { email, password: 'WrongPassw0rd!' } });
    if (JSON.stringify(res.body?.message) !== JSON.stringify(wrongPw.body?.message)) {
      return { warn: true, expected: 'identical message for unknown user and wrong password', actual: `unknown="${res.body?.message}" wrongpw="${wrongPw.body?.message}"` };
    }
    return { ok: true, evidence: `both return "${res.body?.message}"` };
  });

  await check('AUTH-023', 'Login is case-insensitive on email', async () => {
    const res = await api('POST', '/api/auth/login', { body: { email: email.toUpperCase(), password } });
    return (res.status === 200 || res.status === 201) ? { ok: true } : { expected: '200', actual: String(res.status) };
  }, 'MEDIUM');

  // ── Token behaviour ───────────────────────────────────────────────────────
  await check('AUTH-030', 'Access token authenticates a protected route', async () => {
    const res = await api('GET', '/api/organizations/me', { token: session.accessToken });
    return res.status === 200 ? { ok: true, evidence: `org=${res.body.id}` } : { expected: '200', actual: `${res.status} ${res.text.slice(0, 120)}` };
  }, 'CRITICAL');

  await check('AUTH-031', 'alg=none forged token is rejected', async () => {
    const hdr = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const pl = Buffer.from(JSON.stringify({ userId: session.user.id, organizationId: session.user.organizationId, role: 'OWNER' })).toString('base64url');
    const res = await api('GET', '/api/organizations/me', { token: `${hdr}.${pl}.` });
    return res.status === 401 ? { ok: true } : { expected: '401', actual: `${res.status} — FORGED TOKEN ACCEPTED` };
  }, 'CRITICAL');

  await check('AUTH-032', 'Tampered payload (role escalation) is rejected', async () => {
    const [h, p, s] = session.accessToken.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.role = 'OWNER'; payload.organizationId = '00000000-0000-0000-0000-000000000000';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    const res = await api('GET', '/api/organizations/me', { token: forged });
    return res.status === 401 ? { ok: true } : { expected: '401', actual: `${res.status} — TAMPERED TOKEN ACCEPTED` };
  }, 'CRITICAL');

  await check('AUTH-033', 'Refresh token exchanges for a new access token', async () => {
    const res = await api('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken } });
    if (res.status !== 200 && res.status !== 201) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };
    if (!res.body.accessToken) return { expected: 'new accessToken', actual: 'missing' };
    const ok = await api('GET', '/api/organizations/me', { token: res.body.accessToken });
    return ok.status === 200 ? { ok: true, evidence: 'refreshed token authenticates' } : { expected: 'refreshed token works', actual: String(ok.status) };
  }, 'CRITICAL');

  await check('AUTH-034', 'Access token cannot be used as a refresh token', async () => {
    const res = await api('POST', '/api/auth/refresh', { body: { refreshToken: session.accessToken } });
    return res.status === 401 ? { ok: true } : { expected: '401 (different signing key)', actual: String(res.status) };
  }, 'CRITICAL');

  // ── Logout / revocation ───────────────────────────────────────────────────
  await check('AUTH-040', 'Logout revokes the access token immediately', async () => {
    const fresh = await api('POST', '/api/auth/login', { body: { email, password } });
    const tok = fresh.body.accessToken;
    const before = await api('GET', '/api/organizations/me', { token: tok });
    if (before.status !== 200) return { expected: 'token valid before logout', actual: String(before.status) };
    const out = await api('POST', '/api/auth/logout', { token: tok });
    if (out.status !== 200 && out.status !== 201) return { expected: '200 from logout', actual: String(out.status) };
    const after = await api('GET', '/api/organizations/me', { token: tok });
    return after.status === 401
      ? { ok: true, evidence: 'token rejected after logout' }
      : { expected: '401 after logout', actual: `${after.status} — TOKEN STILL VALID AFTER LOGOUT` };
  }, 'CRITICAL');

  await check('AUTH-041', 'Logout also revokes the refresh token', async () => {
    const fresh = await api('POST', '/api/auth/login', { body: { email, password } });
    await api('POST', '/api/auth/logout', { token: fresh.body.accessToken });
    const res = await api('POST', '/api/auth/refresh', { body: { refreshToken: fresh.body.refreshToken } });
    return res.status === 401 ? { ok: true } : { expected: '401', actual: `${res.status} — REFRESH TOKEN SURVIVED LOGOUT` };
  }, 'CRITICAL');

  await check('AUTH-042', 'Password change revokes other sessions but returns fresh tokens', async () => {
    const s1 = await api('POST', '/api/auth/login', { body: { email, password } });
    const s2 = await api('POST', '/api/auth/login', { body: { email, password } });
    const newPw = 'E2eRotatedPassw0rd!';
    const chg = await api('POST', '/api/auth/change-password', {
      token: s2.body.accessToken, body: { currentPassword: password, newPassword: newPw },
    });
    if (chg.status !== 200 && chg.status !== 201) return { expected: '200', actual: `${chg.status} ${chg.text.slice(0, 150)}` };
    const oldSession = await api('GET', '/api/organizations/me', { token: s1.body.accessToken });
    if (oldSession.status !== 401) return { expected: '401 for the other session', actual: `${oldSession.status} — OTHER SESSION SURVIVED PASSWORD CHANGE` };
    if (!chg.body.accessToken) return { expected: 'fresh tokens returned', actual: 'none' };
    const caller = await api('GET', '/api/organizations/me', { token: chg.body.accessToken });
    if (caller.status !== 200) return { expected: 'caller keeps working', actual: String(caller.status) };
    // restore
    await api('POST', '/api/auth/change-password', { token: chg.body.accessToken, body: { currentPassword: newPw, newPassword: password } });
    return { ok: true, evidence: 'other session 401, caller 200' };
  }, 'CRITICAL');

  await check('AUTH-043', 'Deactivating a user takes effect on the next request', async () => {
    const s = await api('POST', '/api/auth/login', { body: { email, password } });
    const u = await prisma.user.findUnique({ where: { email } });
    await prisma.user.update({ where: { id: u.id }, data: { isActive: false } });
    const res = await api('GET', '/api/organizations/me', { token: s.body.accessToken });
    await prisma.user.update({ where: { id: u.id }, data: { isActive: true } });
    return res.status === 401
      ? { ok: true, evidence: 'immediate 401' }
      : { expected: '401', actual: `${res.status} — DEACTIVATED USER STILL AUTHENTICATED` };
  }, 'CRITICAL');

  await check('AUTH-044', 'Concurrent sessions both work until revoked', async () => {
    const a = await api('POST', '/api/auth/login', { body: { email, password } });
    const b = await api('POST', '/api/auth/login', { body: { email, password } });
    const ra = await api('GET', '/api/organizations/me', { token: a.body.accessToken });
    const rb = await api('GET', '/api/organizations/me', { token: b.body.accessToken });
    return (ra.status === 200 && rb.status === 200)
      ? { ok: true, evidence: 'two simultaneous sessions valid' }
      : { expected: 'both 200', actual: `a=${ra.status} b=${rb.status}` };
  }, 'MEDIUM');

  // ── Email verification ────────────────────────────────────────────────────
  await check('AUTH-050', 'Verify-email rejects an invalid token', async () => {
    const res = await api('POST', '/api/auth/verify-email', { body: { token: 'not-a-real-token' } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  });

  await check('AUTH-051', 'Verify-email accepts the real token and marks the user verified', async () => {
    const { email: e } = await seedUser('verify');
    // Reproduce the emailed token by writing a known one (the raw token is only in the email).
    const raw = require('crypto').randomBytes(32).toString('hex');
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({ where: { email: e }, data: { emailVerifyToken: hash, emailVerifyExpiresAt: new Date(Date.now() + 3600e3) } });
    const res = await api('POST', '/api/auth/verify-email', { body: { token: raw } });
    if (res.status !== 200 && res.status !== 201) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };
    const u = await prisma.user.findUnique({ where: { email: e } });
    if (!u.emailVerifiedAt) return { expected: 'emailVerifiedAt set', actual: 'null' };
    if (u.emailVerifyToken !== null) return { expected: 'token cleared (single use)', actual: 'token still present' };
    return { ok: true, evidence: `verifiedAt=${u.emailVerifiedAt.toISOString()}` };
  }, 'CRITICAL');

  await check('AUTH-052', 'Expired verification token is rejected', async () => {
    const { email: e } = await seedUser('expired');
    const raw = require('crypto').randomBytes(32).toString('hex');
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({ where: { email: e }, data: { emailVerifyToken: hash, emailVerifyExpiresAt: new Date(Date.now() - 1000) } });
    const res = await api('POST', '/api/auth/verify-email', { body: { token: raw } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: `${res.status} — EXPIRED TOKEN ACCEPTED` };
  }, 'HIGH');

  await check('AUTH-053', 'GET /verify-email link form also works (email clients)', async () => {
    const { email: e } = await seedUser('getverify');
    const raw = require('crypto').randomBytes(32).toString('hex');
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({ where: { email: e }, data: { emailVerifyToken: hash, emailVerifyExpiresAt: new Date(Date.now() + 3600e3) } });
    const res = await api('GET', `/api/auth/verify-email?token=${raw}`);
    return (res.status === 200) ? { ok: true } : { expected: '200', actual: `${res.status} ${res.text.slice(0, 120)}` };
  }, 'MEDIUM');

  // ── Password reset ────────────────────────────────────────────────────────
  await check('AUTH-060', 'Forgot-password returns the same response for known and unknown emails', async () => {
    const known = await api('POST', '/api/auth/forgot-password', { body: { email } });
    const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'ghost@e2e.test' } });
    if (known.status !== unknown.status) return { expected: 'identical status', actual: `${known.status} vs ${unknown.status}` };
    if (JSON.stringify(known.body) !== JSON.stringify(unknown.body)) return { expected: 'identical body', actual: `${JSON.stringify(known.body)} vs ${JSON.stringify(unknown.body)}` };
    return { ok: true, evidence: `both ${known.status} "${known.body?.message}"` };
  }, 'HIGH');

  await check('AUTH-061', 'Forgot-password stores only a hash of the reset token', async () => {
    await api('POST', '/api/auth/forgot-password', { body: { email } });
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u.passwordResetToken) return { expected: 'token stored', actual: 'null' };
    if (u.passwordResetToken.length !== 64) return { expected: 'sha256 hex', actual: `len=${u.passwordResetToken.length}` };
    if (!u.passwordResetExpiresAt || u.passwordResetExpiresAt < new Date()) return { expected: 'future expiry', actual: String(u.passwordResetExpiresAt) };
    return { ok: true, evidence: `expires ${u.passwordResetExpiresAt.toISOString()}` };
  }, 'HIGH');

  await check('AUTH-062', 'Reset-password consumes the token, rotates the password and revokes sessions', async () => {
    const oldSession = await api('POST', '/api/auth/login', { body: { email, password } });
    const raw = require('crypto').randomBytes(32).toString('hex');
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({ where: { email }, data: { passwordResetToken: hash, passwordResetExpiresAt: new Date(Date.now() + 600e3) } });

    const newPw = 'E2eResetPassw0rd!';
    const res = await api('POST', '/api/auth/reset-password', { body: { token: raw, newPassword: newPw } });
    if (res.status !== 200 && res.status !== 201) return { expected: '200', actual: `${res.status} ${res.text.slice(0, 150)}` };

    const oldStillWorks = await api('GET', '/api/organizations/me', { token: oldSession.body.accessToken });
    if (oldStillWorks.status !== 401) return { expected: '401 for pre-reset session', actual: `${oldStillWorks.status} — SESSION SURVIVED PASSWORD RESET` };

    const loginNew = await api('POST', '/api/auth/login', { body: { email, password: newPw } });
    if (loginNew.status !== 200 && loginNew.status !== 201) return { expected: 'login with new password', actual: String(loginNew.status) };

    const reuse = await api('POST', '/api/auth/reset-password', { body: { token: raw, newPassword: 'AnotherPassw0rd!' } });
    if (reuse.status !== 400) return { expected: '400 on token reuse', actual: `${reuse.status} — RESET TOKEN IS REUSABLE` };

    // restore original password for later suites
    await api('POST', '/api/auth/change-password', { token: loginNew.body.accessToken, body: { currentPassword: newPw, newPassword: password } });
    return { ok: true, evidence: 'session revoked, new password works, token single-use' };
  }, 'CRITICAL');

  await check('AUTH-063', 'Expired reset token is rejected', async () => {
    const raw = require('crypto').randomBytes(32).toString('hex');
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({ where: { email }, data: { passwordResetToken: hash, passwordResetExpiresAt: new Date(Date.now() - 1000) } });
    const res = await api('POST', '/api/auth/reset-password', { body: { token: raw, newPassword: 'Passw0rdNew!' } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: `${res.status} — EXPIRED RESET TOKEN ACCEPTED` };
  }, 'CRITICAL');

  // ── Invite / setup-account ────────────────────────────────────────────────
  await check('AUTH-070', 'Invited member can activate via setup-account and receives a session', async () => {
    const owner = await api('POST', '/api/auth/login', { body: { email, password } });
    const inviteEmail = `${uniq('invite')}@e2e.test`;
    const add = await api('POST', '/api/organizations/members', {
      token: owner.body.accessToken, body: { email: inviteEmail, fullName: 'Invited Agent', role: 'AGENT' },
    });
    if (add.status !== 201 && add.status !== 200) return { expected: '201', actual: `${add.status} ${add.text.slice(0, 150)}` };

    // Raw invite token is only in the email; reproduce a known one.
    const raw = require('crypto').randomBytes(32).toString('hex');
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({ where: { email: inviteEmail }, data: { passwordResetToken: hash, passwordResetExpiresAt: new Date(Date.now() + 7 * 24 * 3600e3) } });

    const setup = await api('POST', '/api/auth/setup-account', { body: { token: raw, password: 'InvitedPassw0rd!' } });
    if (setup.status !== 200 && setup.status !== 201) return { expected: '200', actual: `${setup.status} ${setup.text.slice(0, 150)}` };
    if (!setup.body.accessToken) return { expected: 'session returned', actual: 'no accessToken' };

    const me = await api('GET', '/api/organizations/me', { token: setup.body.accessToken });
    if (me.status !== 200) return { expected: 'invited member can call API', actual: String(me.status) };

    const u = await prisma.user.findUnique({ where: { email: inviteEmail } });
    if (!u.emailVerifiedAt) return { expected: 'marked verified', actual: 'null' };
    if (u.passwordResetToken !== null) return { expected: 'invite token consumed', actual: 'still set' };
    state.invitedAgent = { email: inviteEmail, password: 'InvitedPassw0rd!', token: setup.body.accessToken, userId: u.id, orgId: u.organizationId };
    return { ok: true, evidence: `agent ${u.id} activated, role=${u.role}` };
  }, 'CRITICAL');

  await check('AUTH-071', 'setup-account rejects a bogus token', async () => {
    const res = await api('POST', '/api/auth/setup-account', { body: { token: 'nope', password: 'Passw0rd123!' } });
    return res.status === 400 ? { ok: true } : { expected: '400', actual: String(res.status) };
  });

  // ── Brute force / rate limiting ───────────────────────────────────────────
  await check('AUTH-080', 'Repeated wrong passwords lock the account (per-account, not per-IP)', async () => {
    const { email: victimEmail } = await seedUser('lockout');

    // noRetry: the lock is short-lived, and the harness's 429 backoff can outlast it,
    // which would mask a working lockout as "never locked". A 429 here means the
    // per-IP ceiling fired first — also a valid brake, so record and move on.
    // Count ACTUAL failed logins, not loop iterations: a 429 does not reach the
    // credential check, so consuming an iteration on it would under-count attempts
    // and make a working lockout look absent.
    let lockedAt = null;
    let delivered = 0;
    for (let guard = 0; guard < 30 && delivered < 7 && !lockedAt; guard++) {
      const res = await api('POST', '/api/auth/login', { noRetry: true, body: { email: victimEmail, password: `Wrong${delivered}Passw0rd!` } });
      if (res.status === 429) { await sleep(3500); continue; }
      if (res.status !== 401) return { expected: '401 on wrong password', actual: `attempt ${delivered + 1} => ${res.status}` };
      delivered++;
      if (/too many failed/i.test(res.body?.message || '')) lockedAt = delivered;
    }

    // Authoritative check: the lock is recorded in the database.
    const u = await prisma.user.findUnique({ where: { email: victimEmail } });
    if (!u.lockedUntil || u.lockedUntil <= new Date()) {
      return { expected: 'lockedUntil set in DB', actual: `attempts=${u.failedLoginAttempts} lockedUntil=${u.lockedUntil} — brute force unbounded` };
    }

    // The CORRECT password must also be refused while locked, or the lock is
    // bypassable by the very guess it exists to stop.
    const correct = await api('POST', '/api/auth/login', { noRetry: true, body: { email: victimEmail, password } });
    if (!/too many failed/i.test(correct.body?.message || '')) {
      return { expected: 'correct password refused during lockout', actual: `${correct.status} "${correct.body?.message}" — LOCKOUT BYPASSABLE` };
    }

    state.lockedUser = victimEmail;
    return { ok: true, evidence: `locked at attempt ${lockedAt ?? u.failedLoginAttempts}, attempts=${u.failedLoginAttempts}, until=${u.lockedUntil.toISOString()}, correct password also refused` };
  }, 'CRITICAL');

  await check('AUTH-081', 'Password reset clears the lockout', async () => {
    if (!state.lockedUser) return { blocked: true, reason: 'AUTH-080 did not produce a locked account' };
    const raw = require('crypto').randomBytes(32).toString('hex');
    const hash = require('crypto').createHash('sha256').update(raw).digest('hex');
    await prisma.user.update({ where: { email: state.lockedUser }, data: { passwordResetToken: hash, passwordResetExpiresAt: new Date(Date.now() + 600e3) } });
    const newPw = 'UnlockedPassw0rd!';
    const reset = await api('POST', '/api/auth/reset-password', { body: { token: raw, newPassword: newPw } });
    if (reset.status !== 200 && reset.status !== 201) return { expected: '200', actual: String(reset.status) };
    const login = await api('POST', '/api/auth/login', { body: { email: state.lockedUser, password: newPw } });
    return (login.status === 200 || login.status === 201)
      ? { ok: true, evidence: 'login succeeds immediately after reset' }
      : { expected: 'login works after reset', actual: `${login.status} ${login.body?.message}` };
  }, 'HIGH');

  await check('AUTH-082', 'Successful login clears the failed-attempt counter', async () => {
    const { email: e } = await seedUser('counter');
    await api('POST', '/api/auth/login', { body: { email: e, password: 'Nope1Passw0rd!' } });
    await api('POST', '/api/auth/login', { body: { email: e, password: 'Nope2Passw0rd!' } });
    const mid = await prisma.user.findUnique({ where: { email: e } });
    if (mid.failedLoginAttempts !== 2) return { expected: 'counter=2', actual: `counter=${mid.failedLoginAttempts}` };
    const ok = await api('POST', '/api/auth/login', { body: { email: e, password } });
    if (ok.status !== 200 && ok.status !== 201) return { expected: 'login succeeds', actual: String(ok.status) };
    const after = await prisma.user.findUnique({ where: { email: e } });
    return after.failedLoginAttempts === 0
      ? { ok: true, evidence: 'counter reset to 0' }
      : { expected: 'counter=0', actual: `counter=${after.failedLoginAttempts}` };
  }, 'MEDIUM');

  await check('AUTH-083', 'Register endpoint is rate limited (429 under burst)', async () => {
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      api('POST', '/api/auth/register', {
        noRetry: true,
        body: { organizationName: `Burst${i}`, industry: 'SME', fullName: 'B', email: `${uniq('burst')}@e2e.test`, password },
      })));
    const limited = burst.filter(r => r.status === 429).length;
    return limited > 0
      ? { ok: true, evidence: `${limited}/12 rejected with 429` }
      : { expected: 'some 429s', actual: 'registration burst entirely unthrottled' };
  }, 'HIGH');

  await check('AUTH-084', 'Refresh is NOT starved by the strict login budget', async () => {
    const s = await api('POST', '/api/auth/login', { body: { email, password } });
    let rt = s.body.refreshToken;
    for (let i = 0; i < 12; i++) {
      const r = await api('POST', '/api/auth/refresh', { body: { refreshToken: rt }, noRetry: true });
      if (r.status === 429) return { expected: 'refresh not throttled at 12 calls', actual: `429 at call ${i + 1} — a user with several tabs open would be locked out of their own session` };
      if (r.status !== 200 && r.status !== 201) return { expected: '200', actual: `${r.status} at call ${i + 1}` };
      if (r.body.refreshToken) rt = r.body.refreshToken;
    }
    return { ok: true, evidence: '12 consecutive refreshes all 200' };
  }, 'HIGH');

  // Persist a working session for later suites
  const finalLogin = await api('POST', '/api/auth/login', { body: { email, password } });
  state.primary = {
    email, password,
    token: finalLogin.body.accessToken,
    refreshToken: finalLogin.body.refreshToken,
    userId: finalLogin.body.user.id,
    orgId: finalLogin.body.user.organizationId,
  };

  // Second tenant for isolation tests
  state.orgB = await registerOrg('tenantB');
};
