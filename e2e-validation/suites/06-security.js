/**
 * Suite 06 — Security: injection, SSRF, webhook forgery, replay, headers, DoS.
 */
const H = require('../harness');
const { api, prisma, check, suite, uniq, seedSession } = H;
const crypto = require('crypto');

module.exports = async function () {
  suite('06 · Security');

  const T = await seedSession('sec');
  const token = T.token;
  const orgId = T.orgId;

  // ── Injection ─────────────────────────────────────────────────────────────
  await check('SEC-001', 'SQL injection across every string-accepting endpoint is inert', async () => {
    const payloads = [
      `' OR '1'='1`,
      `'; DROP TABLE users CASCADE; --`,
      `1'; UPDATE organizations SET "subscriptionPlan"='ENTERPRISE'; --`,
      `\\'; SELECT pg_sleep(5); --`,
      `' UNION SELECT "passwordHash" FROM users --`,
    ];
    const usersBefore = await prisma.user.count();
    for (const p of payloads) {
      await api('GET', `/api/crm/contacts/search?q=${encodeURIComponent(p)}`, { token });
      await api('POST', '/api/crm/contacts', { token, body: { fullName: p, phoneNumber: `+234${Date.now().toString().slice(-10)}` } });
      await api('GET', `/api/knowledge/search?q=${encodeURIComponent(p)}`, { token });
    }
    const usersAfter = await prisma.user.count();
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (usersAfter < usersBefore) return { expected: 'users table intact', actual: `users dropped from ${usersBefore} to ${usersAfter}` };
    if (org.subscriptionPlan === 'ENTERPRISE') return { expected: 'plan unchanged', actual: 'INJECTION UPGRADED THE SUBSCRIPTION' };
    return { ok: true, evidence: `${usersAfter} users intact, plan=${org.subscriptionPlan ?? 'null'}` };
  }, 'CRITICAL');

  await check('SEC-002', 'Prisma parameterises: a quote in data does not corrupt the row', async () => {
    const name = `O'Brien "The Boss" \\ %_ ${'`'}`;
    const res = await api('POST', '/api/crm/contacts', { token, body: { fullName: name, phoneNumber: `+234${Date.now().toString().slice(-10)}` } });
    if (res.status >= 400) return { expected: '201', actual: `${res.status} ${res.text.slice(0, 120)}` };
    const row = await prisma.contact.findUnique({ where: { id: res.body.id } });
    return row.fullName === name ? { ok: true, evidence: `stored: ${row.fullName}` } : { expected: name, actual: row.fullName };
  }, 'HIGH');

  await check('SEC-003', 'NoSQL/object-injection in a JSON body is rejected by validation', async () => {
    const res = await api('POST', '/api/auth/login', { body: { email: { $ne: null }, password: { $ne: null } } });
    return res.status === 400 || res.status === 401
      ? { ok: true, evidence: String(res.status) }
      : { expected: '400/401', actual: `${res.status} — operator object accepted as a credential` };
  }, 'CRITICAL');

  await check('SEC-004', 'Prototype pollution via __proto__ in a body does not poison Object', async () => {
    await api('POST', '/api/crm/contacts', {
      token,
      body: JSON.parse('{"fullName":"proto","phoneNumber":"+2348000000001","__proto__":{"polluted":"yes"}}'),
    });
    return ({}).polluted === undefined
      ? { ok: true, evidence: 'Object.prototype clean' }
      : { expected: 'no pollution', actual: 'Object.prototype.polluted was set' };
  }, 'CRITICAL');

  // ── SSRF ──────────────────────────────────────────────────────────────────
  const ssrfTargets = [
    ['SEC-010', 'AWS/GCP metadata endpoint', 'http://169.254.169.254/latest/meta-data/'],
    ['SEC-011', 'loopback', 'http://127.0.0.1:4000/api/health'],
    ['SEC-012', 'loopback by name', 'http://localhost:4000/api/health'],
    ['SEC-013', 'RFC1918 private range', 'http://10.0.0.1/'],
    ['SEC-014', 'IPv6 loopback', 'http://[::1]/'],
    ['SEC-015', 'IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]/'],
    ['SEC-016', 'file scheme', 'file:///etc/passwd'],
    ['SEC-017', 'gopher scheme', 'gopher://127.0.0.1:6379/_INFO'],
    ['SEC-018', 'link-local by decimal IP', 'http://2852039166/'],
    ['SEC-019', 'internal TLD', 'http://redis.internal:6379/'],
  ];
  for (const [id, label, url] of ssrfTargets) {
    await check(id, `SSRF — crawler refuses ${label}`, async () => {
      const res = await api('POST', '/api/knowledge/crawl-website', { token, body: { url } });
      if (res.status === 400) return { ok: true, evidence: `400 ${String(res.body?.message).slice(0, 70)}` };
      if (res.status === 201 || res.status === 200) {
        return { expected: '400', actual: `FETCHED INTERNAL RESOURCE: ${JSON.stringify(res.body).slice(0, 140)}` };
      }
      return { expected: '400', actual: String(res.status) };
    }, 'CRITICAL');
  }

  await check('SEC-020', 'SSRF — outbound webhook URL is validated too', async () => {
    const res = await api('PATCH', '/api/organizations/settings', {
      token, body: { webhookUrl: 'http://169.254.169.254/latest/meta-data/', enabledWebhookEvents: ['*'] },
    });
    // Setting it may be allowed; what matters is that the dispatcher refuses to call it.
    await api('POST', '/api/crm/contacts', { token, body: { fullName: 'Webhook trigger', phoneNumber: `+234${Date.now().toString().slice(-10)}` } });
    await new Promise(r => setTimeout(r, 1500));
    const delivered = await prisma.webhookLog.count({ where: { organizationId: orgId, targetUrl: { contains: '169.254.169.254' }, success: true } });
    if (delivered > 0) return { expected: 'never delivered', actual: 'SSRF VIA WEBHOOK: request was made to the metadata endpoint' };
    return { ok: true, evidence: `settings http=${res.status}, 0 successful deliveries to link-local` };
  }, 'CRITICAL');

  // ── Webhook authenticity ──────────────────────────────────────────────────
  await check('SEC-030', 'Paystack webhook rejects an unsigned payload', async () => {
    const before = await prisma.organization.findUnique({ where: { id: orgId } });
    const res = await api('POST', '/api/billing/paystack-webhook', {
      body: { event: 'charge.success', data: { reference: 'forged', amount: 100000000, metadata: { organizationId: orgId, plan: 'ENTERPRISE' } } },
    });
    const after = await prisma.organization.findUnique({ where: { id: orgId } });
    if (after.subscriptionPlan === 'ENTERPRISE' && before.subscriptionPlan !== 'ENTERPRISE') {
      return { expected: 'rejected', actual: 'FORGED WEBHOOK GRANTED AN ENTERPRISE SUBSCRIPTION' };
    }
    if (res.body?.status === 'success') return { expected: 'not success', actual: `reported "${res.body.status}" for an unsigned payload` };
    return { ok: true, evidence: `status="${res.body?.status}" plan unchanged (${after.subscriptionPlan ?? 'null'})` };
  }, 'CRITICAL');

  await check('SEC-031', 'Paystack webhook rejects a wrongly-signed payload', async () => {
    const payload = JSON.stringify({ event: 'charge.success', data: { reference: 'x', amount: 5000000, metadata: { organizationId: orgId, plan: 'BUSINESS' } } });
    const badSig = crypto.createHmac('sha512', 'not-the-real-secret').update(payload).digest('hex');
    const res = await api('POST', '/api/billing/paystack-webhook', { body: payload, raw: true, headers: { 'x-paystack-signature': badSig, 'Content-Type': 'application/json' } });
    const org = await prisma.organization.findUnique({ where: { id: orgId } });
    if (org.subscriptionPlan === 'BUSINESS') return { expected: 'rejected', actual: 'BAD SIGNATURE ACCEPTED' };
    return res.body?.status !== 'success' ? { ok: true, evidence: `status="${res.body?.status}"` } : { expected: 'rejected', actual: 'reported success' };
  }, 'CRITICAL');

  await check('SEC-032', 'WhatsApp webhook rejects a payload with no X-Hub-Signature-256', async () => {
    const before = await prisma.message.count();
    const res = await api('POST', '/api/whatsapp/webhook', {
      body: { entry: [{ changes: [{ value: { metadata: { phone_number_id: 'forged' }, messages: [{ from: '2348000000000', id: 'wamid.forged', type: 'text', text: { body: 'injected' } }] } }] }] },
    });
    await new Promise(r => setTimeout(r, 1200));
    const after = await prisma.message.count();
    if (after > before) return { expected: 'no message stored', actual: `UNSIGNED WEBHOOK INJECTED ${after - before} MESSAGE(S)` };
    return { ok: true, evidence: `http=${res.status}, message count unchanged (${after})` };
  }, 'CRITICAL');

  await check('SEC-033', 'WhatsApp webhook verification rejects a wrong verify token', async () => {
    const res = await api('GET', '/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ECHO_ME');
    if (res.status === 200 && res.text.includes('ECHO_ME')) return { expected: '403', actual: 'ECHOED THE CHALLENGE FOR A WRONG TOKEN' };
    return res.status === 403 ? { ok: true } : { expected: '403', actual: String(res.status) };
  }, 'CRITICAL');

  await check('SEC-034', 'Twilio status callback cannot be used to forge call records', async () => {
    const fakeSid = `CA_FORGED_${Date.now()}`;
    const res = await api('POST', '/api/telephony/status/twilio', { body: { CallSid: fakeSid, CallStatus: 'completed', CallDuration: '99999' } });
    const row = await prisma.callLog.findFirst({ where: { callSid: fakeSid } });
    if (row) return { expected: 'no row created', actual: 'FORGED STATUS CALLBACK CREATED A CALL LOG' };
    return { ok: true, evidence: `http=${res.status}, unknown callSid ignored` };
  }, 'HIGH');

  // ── Auth bypass attempts ──────────────────────────────────────────────────
  const bypass = [
    ['SEC-040', 'no Authorization header', undefined],
    ['SEC-041', 'empty bearer', ''],
    ['SEC-042', 'garbage token', 'garbage.token.value'],
    ['SEC-043', 'expired-looking token', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ4IiwiZXhwIjoxfQ.aaa'],
  ];
  for (const [id, label, tok] of bypass) {
    await check(id, `Protected route refuses ${label}`, async () => {
      const res = await api('GET', '/api/crm/contacts', tok === undefined ? {} : { token: tok });
      return res.status === 401 ? { ok: true } : { expected: '401', actual: String(res.status) };
    }, 'CRITICAL');
  }

  await check('SEC-044', 'A token signed with the wrong key is rejected', async () => {
    const jwt = require('../../node_modules/jsonwebtoken');
    let forged;
    try {
      forged = jwt.sign({ userId: T.userId, organizationId: orgId, role: 'OWNER', tokenVersion: 0 }, 'attacker-chosen-secret');
    } catch {
      return { blocked: true, reason: 'jsonwebtoken not resolvable from the harness' };
    }
    const res = await api('GET', '/api/organizations/me', { token: forged });
    return res.status === 401 ? { ok: true } : { expected: '401', actual: `${res.status} — SIGNATURE NOT VERIFIED` };
  }, 'CRITICAL');

  // ── Headers & transport ───────────────────────────────────────────────────
  await check('SEC-050', 'Security headers are present on API responses', async () => {
    const res = await api('GET', '/api/health');
    const want = ['x-content-type-options', 'x-frame-options', 'x-dns-prefetch-control'];
    const missing = want.filter(h => !res.headers.get(h));
    return missing.length === 0
      ? { ok: true, evidence: want.map(h => `${h}=${res.headers.get(h)}`).join(', ') }
      : { warn: true, expected: want.join(', '), actual: `missing ${missing.join(', ')}` };
  }, 'MEDIUM');

  await check('SEC-051', 'Errors do not leak stack traces or SQL to the client', async () => {
    const probes = [
      await api('GET', '/api/crm/contacts/%00', { token }),
      await api('POST', '/api/crm/deals', { token, body: { contactId: 'nope', title: 'x', amount: 1 } }),
      await api('GET', '/api/crm/contacts/../../etc/passwd', { token }),
    ];
    for (const r of probes) {
      const body = r.text || '';
      if (/at [A-Za-z]+\.[A-Za-z]+ \(/.test(body) || /node_modules/.test(body)) {
        return { expected: 'no stack trace', actual: `STACK TRACE LEAKED: ${body.slice(0, 160)}` };
      }
      if (/SELECT .* FROM|prisma\.\w+\.\w+\(\)/i.test(body)) {
        return { expected: 'no SQL/ORM internals', actual: `QUERY LEAKED: ${body.slice(0, 160)}` };
      }
    }
    return { ok: true, evidence: 'three error probes returned clean messages' };
  }, 'HIGH');

  await check('SEC-052', 'Oversized request body is rejected, not absorbed', async () => {
    const huge = 'x'.repeat(80 * 1024 * 1024); // 80MB, above the 70MB cap
    const res = await api('POST', '/api/crm/contacts', { token, body: { fullName: huge, phoneNumber: '+2348000000002' } }).catch(e => ({ status: 0, text: e.message }));
    return (res.status === 413 || res.status === 400 || res.status === 0)
      ? { ok: true, evidence: `status=${res.status}` }
      : { expected: '413', actual: `${res.status} — 80MB body accepted` };
  }, 'HIGH');

  await check('SEC-053', 'Path traversal in a route parameter does not read the filesystem', async () => {
    const res = await api('GET', '/api/crm/contacts/..%2F..%2F..%2Fetc%2Fpasswd', { token });
    if (/root:.*:0:0:/.test(res.text)) return { expected: 'no file contents', actual: 'READ /etc/passwd' };
    return res.status < 500 ? { ok: true, evidence: String(res.status) } : { expected: '4xx', actual: String(res.status) };
  }, 'CRITICAL');

  // ── Rate limiting / abuse ─────────────────────────────────────────────────
  await check('SEC-060', 'Authenticated API is rate limited', async () => {
    const burst = await Promise.all(Array.from({ length: 150 }, () => api('GET', '/api/crm/contacts', { token, noRetry: true })));
    const limited = burst.filter(r => r.status === 429).length;
    return limited > 0
      ? { ok: true, evidence: `${limited}/150 throttled` }
      : { warn: true, expected: 'some 429s', actual: '150 concurrent authenticated requests all served — no ceiling on API abuse' };
  }, 'MEDIUM');

  await check('SEC-061', 'Rate limit responses carry retry metadata', async () => {
    const burst = await Promise.all(Array.from({ length: 150 }, () => api('GET', '/api/crm/contacts', { token, noRetry: true })));
    const limited = burst.find(r => r.status === 429);
    if (!limited) return { blocked: true, reason: 'no 429 observed in this window' };
    const hasHeaders = limited.headers.get('x-ratelimit-limit') || limited.headers.get('retry-after');
    return hasHeaders
      ? { ok: true, evidence: `limit=${limited.headers.get('x-ratelimit-limit')} remaining=${limited.headers.get('x-ratelimit-remaining')}` }
      : { warn: true, expected: 'X-RateLimit-* / Retry-After', actual: 'none — clients cannot back off intelligently' };
  }, 'LOW');

  // ── Secrets hygiene ───────────────────────────────────────────────────────
  await check('SEC-070', 'Organization endpoint does not leak integration secrets', async () => {
    await prisma.whatsAppConfig.create({
      data: { organizationId: orgId, phoneNumberId: `pn_${uniq('s')}`, whatsappBusinessId: 'wa_secret', accessToken: 'SUPER_SECRET_META_TOKEN', displayPhoneNumber: '+234', webhookVerifyToken: 'VERIFY_SECRET' },
    });
    await prisma.telephonyConfig.create({
      data: { organizationId: orgId, phoneNumber: `+234${Date.now().toString().slice(-9)}`, accountSid: 'AC_SECRET', authToken: 'TWILIO_AUTH_SECRET' },
    });
    const res = await api('GET', '/api/organizations/me', { token });
    const body = JSON.stringify(res.body);
    const leaked = ['SUPER_SECRET_META_TOKEN', 'TWILIO_AUTH_SECRET', 'VERIFY_SECRET'].filter(s => body.includes(s));
    return leaked.length === 0
      ? { ok: true, evidence: 'no integration secrets in the response' }
      : { warn: true, expected: 'secrets withheld or masked', actual: `returns ${leaked.join(', ')} in plaintext to any org member` };
  }, 'HIGH');

  await check('SEC-071', 'Password hashes never appear in any API response', async () => {
    // Walk the PARSED response looking for a `passwordHash` KEY or a value in bcrypt
    // format. Substring-matching the raw text gives false positives, because stored
    // customer data legitimately contains the word (SEC-001 saves an injection
    // payload reading `' UNION SELECT "passwordHash" FROM users --` as a contact
    // name). The question is whether a hash is DISCLOSED, not whether the word occurs.
    const findings = [];
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (/^password(Hash)?$/i.test(k)) findings.push(`${path}.${k}`);
          walk(v, `${path}.${k}`);
        }
        return;
      }
      if (typeof node === 'string' && /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(node)) {
        findings.push(`${path} (bcrypt value)`);
      }
    };

    const endpoints = ['/api/organizations/me', '/api/organizations/members', '/api/crm/contacts', '/api/crm/tickets', '/api/conversations'];
    for (const e of endpoints) {
      const res = await api('GET', e, { token });
      if (res.status !== 200) continue;
      walk(res.body, e);
    }
    return findings.length === 0
      ? { ok: true, evidence: `${endpoints.length} endpoints walked, no password field or bcrypt value` }
      : { expected: 'no password fields', actual: `DISCLOSED AT ${findings.slice(0, 5).join(', ')}` };
  }, 'CRITICAL');

  await check('SEC-072', 'API key is returned once on creation and never re-readable', async () => {
    const gen = await api('POST', '/api/organizations/api-keys/regenerate', { token });
    if (gen.status >= 300) return { expected: '201', actual: String(gen.status) };
    const raw = gen.body.apiKey;
    if (!raw) return { expected: 'apiKey returned', actual: 'none' };
    const stored = await prisma.apiKey.findFirst({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' } });
    if (stored.keyHash === raw) return { expected: 'hash stored', actual: 'PLAINTEXT KEY STORED IN THE DATABASE' };
    const me = await api('GET', '/api/organizations/me', { token });
    if ((me.text || '').includes(raw)) return { expected: 'not re-readable', actual: 'plaintext key returned again by /organizations/me' };
    return { ok: true, evidence: `stored as sha256, prefix=${stored.keyPrefix}` };
  }, 'HIGH');
};
