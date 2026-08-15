/**
 * ACE Platform — Enterprise E2E Validation Harness
 *
 * Drives the RUNNING system over HTTP exactly as a client would, then verifies the
 * observable consequences in PostgreSQL. No source imports, no mocks: every
 * assertion is against runtime behaviour.
 *
 * Usage: node e2e-validation/harness.js [suiteFilter]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── env ─────────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}

const API = process.env.E2E_API_URL || 'http://localhost:4000';
const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));

/**
 * The harness holds its OWN pool, separate from the API's, and both draw on the same
 * Supabase pooler budget. A full run with the harness at the app's default of 15
 * exhausted the pooler and produced `Can't reach database server` mid-suite — the
 * same total-connections-across-processes constraint documented in
 * packages/database/src/index.ts. The verification rig gets a small share.
 */
const harnessDbUrl = (() => {
  try {
    const u = new URL(process.env.DATABASE_URL);
    u.searchParams.set('connection_limit', '4');
    u.searchParams.set('pool_timeout', '30');
    return u.toString();
  } catch { return process.env.DATABASE_URL; }
})();

const prisma = new PrismaClient({ log: [], datasources: { db: { url: harnessDbUrl } } });

// ─── result recording ────────────────────────────────────────────────────────
const results = [];
let currentSuite = '';
const RUN_ID = crypto.randomBytes(4).toString('hex');

function record(id, name, status, expected, actual, evidence, severity) {
  results.push({ id, suite: currentSuite, name, status, expected, actual, evidence, severity });
  const mark = { PASS: '\x1b[32mPASS\x1b[0m', FAIL: '\x1b[31mFAIL\x1b[0m', BLOCKED: '\x1b[33mBLOCK\x1b[0m', WARN: '\x1b[33mWARN\x1b[0m' }[status];
  console.log(`  ${mark} ${id.padEnd(10)} ${name}`);
  if (status === 'FAIL') console.log(`        expected: ${expected}\n        actual:   ${actual}`);
}

async function check(id, name, fn, severity = 'HIGH') {
  try {
    const r = await fn();
    if (r === true || r === undefined) return record(id, name, 'PASS', '—', '—', '', severity);
    if (r && r.blocked) return record(id, name, 'BLOCKED', r.expected || '—', r.reason, r.evidence || '', severity);
    if (r && r.warn) return record(id, name, 'WARN', r.expected || '—', r.actual || r.warn, r.evidence || '', severity);
    if (r && r.ok === true) return record(id, name, 'PASS', r.expected || '—', r.actual || '—', r.evidence || '', severity);
    return record(id, name, 'FAIL', (r && r.expected) || 'assertion true', (r && r.actual) || String(r), (r && r.evidence) || '', severity);
  } catch (e) {
    record(id, name, 'FAIL', 'no exception', `${e.name}: ${e.message}`.slice(0, 300), (e.stack || '').split('\n').slice(0, 3).join(' | '), severity);
  }
}

function suite(name) { currentSuite = name; console.log(`\n\x1b[1m▌ ${name}\x1b[0m`); }

// ─── http helper ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param noRetry set true when the test is *about* rate limiting and a 429 is the
 *                expected observation rather than an obstacle.
 */
async function api(method, urlPath, { token, body, headers = {}, raw = false, noRetry = false } = {}) {
  const started = Date.now();

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}

    // The suite drives auth endpoints far harder than any real client, so it trips
    // the (correct) rate limiter. Back off and retry rather than reporting the
    // limiter as a functional failure. RATE-* tests opt out via noRetry.
    if (res.status === 429 && !noRetry && attempt < 4) {
      await sleep(6000 * (attempt + 1));
      continue;
    }

    return { status: res.status, body: json, text, headers: res.headers, ms: Date.now() - started, retries: attempt };
  }
}

const uniq = (p) => `${p}.${RUN_ID}.${crypto.randomBytes(3).toString('hex')}`.toLowerCase();

/**
 * Creates a user and DOES NOT RETURN until it exists in the database.
 *
 * Registration is deliberately throttled to 5/min per IP, and this suite creates far
 * more accounts than any real client would. Without waiting on the limiter, setup
 * calls silently 429 and downstream assertions then operate on a user that was never
 * created — which surfaces as a misleading "feature broken" instead of "fixture not
 * ready". Throws after the budget is genuinely exhausted so a real registration
 * outage is still reported loudly.
 */
async function createUser(label, { password = 'E2eValidPassw0rd!', industry = 'SME' } = {}) {
  const email = `${uniq(label)}@e2e.test`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await api('POST', '/api/auth/register', {
      noRetry: true,
      body: { organizationName: `E2E ${label}`, industry, fullName: `${label} User`, email, password, country: 'Nigeria' },
    });
    if (res.status === 200 || res.status === 201) {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw new Error(`register returned ${res.status} but no user row for ${email}`);
      return { email, password, userId: user.id, orgId: user.organizationId };
    }
    if (res.status === 429) { await sleep(8000); continue; }
    throw new Error(`register(${label}) failed: ${res.status} ${res.text.slice(0, 200)}`);
  }
  throw new Error(`register(${label}) still rate limited after 8 attempts`);
}

/**
 * Seeds a user + organization DIRECTLY in the database, bypassing HTTP.
 *
 * Used for fixtures in tests that are not themselves exercising registration.
 * Registration is capped at 5/min per IP by design; a suite that creates dozens of
 * accounts would either starve on that limit or force us to weaken a real security
 * control for the convenience of the test rig. Seeding sidesteps both. The
 * registration endpoint itself is covered end-to-end by AUTH-001..017.
 *
 * The password is hashed with the same bcrypt cost the service uses, so login
 * behaves identically to a real account.
 */
async function seedUser(label, { password = 'E2eValidPassw0rd!', role = 'OWNER', orgId = null, industry = 'SME' } = {}) {
  const bcrypt = require(path.join(ROOT, 'node_modules/bcryptjs'));
  const email = `${uniq(label)}@e2e.test`;
  const passwordHash = await bcrypt.hash(password, 12);

  let organizationId = orgId;
  if (!organizationId) {
    const org = await prisma.organization.create({
      data: {
        name: `E2E ${label}`,
        slug: `e2e-${label}-${crypto.randomBytes(4).toString('hex')}`.toLowerCase(),
        industry,
        country: 'Nigeria',
        welcomeMessage: `Welcome to E2E ${label}!`,
        aiPersonaPrompt: `You are a helpful assistant for E2E ${label}.`,
      },
    });
    organizationId = org.id;
  }

  const user = await prisma.user.create({
    data: { organizationId, email, passwordHash, fullName: `${label} User`, role, emailVerifiedAt: new Date() },
  });

  return { email, password, userId: user.id, orgId: organizationId };
}

/** Seeds a user and returns a live session for it. */
async function seedSession(label, opts = {}) {
  const u = await seedUser(label, opts);
  const s = await loginAs(u.email, u.password);
  return { ...u, token: s.accessToken, refreshToken: s.refreshToken, user: s.user };
}

/** Logs in, waiting out the rate limiter, and asserts a session came back. */
async function loginAs(email, password) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await api('POST', '/api/auth/login', { noRetry: true, body: { email, password } });
    if (res.status === 200 || res.status === 201) return res.body;
    if (res.status === 429) { await sleep(6000); continue; }
    throw new Error(`login(${email}) failed: ${res.status} ${res.text.slice(0, 200)}`);
  }
  throw new Error(`login(${email}) still rate limited`);
}

// ─── fixtures ────────────────────────────────────────────────────────────────
const state = { orgA: null, orgB: null };

async function registerOrg(label) {
  const u = await seedUser(label);
  const session = await loginAs(u.email, u.password);
  return {
    label, email: u.email, password: u.password,
    token: session.accessToken,
    refreshToken: session.refreshToken,
    userId: session.user.id,
    orgId: session.user.organizationId,
  };
}

module.exports = { api, prisma, check, suite, record, results, state, uniq, registerOrg, createUser, seedUser, seedSession, loginAs, RUN_ID, API, sleep };

// ─── runner ──────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    console.log(`\n\x1b[1mACE Platform E2E Validation\x1b[0m  run=${RUN_ID}  target=${API}\n`);

    // Preflight: is the API actually up?
    try {
      const h = await api('GET', '/api/health');
      if (h.status !== 200) throw new Error(`health returned ${h.status}`);
      console.log(`API healthy: ${JSON.stringify(h.body)}\n`);
    } catch (e) {
      console.error(`\x1b[31mFATAL: API is not reachable at ${API} — ${e.message}\x1b[0m`);
      process.exit(2);
    }

    const suites = fs.readdirSync(path.join(__dirname, 'suites')).filter(f => f.endsWith('.js')).sort();
    const filter = process.argv[2];
    for (const f of suites) {
      if (filter && !f.includes(filter)) continue;
      await require(path.join(__dirname, 'suites', f))();
    }

    // ─── report ───
    const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    console.log('\n' + '═'.repeat(78));
    console.log(`TOTAL ${results.length}   PASS ${counts.PASS || 0}   FAIL ${counts.FAIL || 0}   WARN ${counts.WARN || 0}   BLOCKED ${counts.BLOCKED || 0}`);
    console.log('═'.repeat(78));

    const failures = results.filter(r => r.status === 'FAIL');
    if (failures.length) {
      console.log('\n\x1b[31mFAILURES\x1b[0m');
      for (const f of failures) {
        console.log(`  [${f.severity}] ${f.id} ${f.suite} :: ${f.name}`);
        console.log(`      expected: ${f.expected}`);
        console.log(`      actual:   ${f.actual}`);
        if (f.evidence) console.log(`      evidence: ${f.evidence}`);
      }
    }

    fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ runId: RUN_ID, at: new Date().toISOString(), counts, results }, null, 2));
    console.log(`\nResults written to e2e-validation/results.json`);

    await prisma.$disconnect();
    process.exit(failures.length ? 1 : 0);
  })();
}
