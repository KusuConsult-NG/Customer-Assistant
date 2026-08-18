#!/usr/bin/env node
/**
 * MVP certification — one command, one status per checklist area.
 *
 *   npm run certify            (API must be running on :4000)
 *
 * Reports PASS / FAIL / BLOCKED against the ACTUALLY RUNNING system, never
 * against source code. A screen existing is not a feature; an endpoint existing
 * is not a feature. Each check drives a real request and reads the real
 * database afterwards.
 *
 * ── Why BLOCKED is its own status, and not a kind of failure ─────────────────
 *
 * Three outcomes, and conflating any two of them is how a system gets declared
 * ready when it is not:
 *
 *   PASS    — exercised end to end, and the result was correct.
 *   FAIL    — exercised, and it was wrong. A defect.
 *   BLOCKED — could NOT be exercised: a credential, a provider, or network
 *             access is missing. NOT a defect, and NOT a pass. Nothing is
 *             known about it either way.
 *
 * The failure this design exists to prevent is a BLOCKED item being read later
 * as "fine" because it was not red. So the summary refuses to print a
 * completion percentage while anything is blocked, and every blocked line
 * carries the reason it could not run.
 */
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'apps/api/dist/config/load-env.js'));
const { assertLocalDatabase } = require('./guard-production-db');

assertLocalDatabase('MVP certification');

const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
const prisma = new PrismaClient({ log: [] });

const API = process.env.E2E_API_URL || 'http://localhost:4000';
const RUN = crypto.randomBytes(4).toString('hex');

const C = {
  b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m',
};

const results = [];
let area = '';

function section(name) {
  area = name;
  console.log(`\n${C.b}▌ ${name}${C.x}`);
}

function log(status, name, detail) {
  const tag = { PASS: `${C.g}  PASS   ${C.x}`, FAIL: `${C.r}  FAIL   ${C.x}`, BLOCKED: `${C.y}  BLOCKED${C.x}` }[status];
  console.log(`${tag} ${name}`);
  if (detail) console.log(`          ${C.dim}${detail}${C.x}`);
  results.push({ area, name, status, detail });
}

/** Run a check. Returning a string marks it BLOCKED with that reason. */
async function check(name, fn) {
  try {
    const blocked = await fn();
    if (typeof blocked === 'string') log('BLOCKED', name, blocked);
    else log('PASS', name);
  } catch (err) {
    log('FAIL', name, err.message?.slice(0, 220));
  }
}

function blocked(name, reason) {
  log('BLOCKED', name, reason);
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function api(method, urlPath, { token, body, headers = {} } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is a valid outcome */ }
  return { status: res.status, body: json, text };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Register a fresh organization and return its session.
 *
 * Registration is deliberately rate-limited, so two certification runs close
 * together hit the throttle. That is the API behaving correctly, not a defect —
 * wait it out rather than treating it as a failure, and say so if it persists.
 */
async function newOrg(label) {
  const email = `cert.${label}.${RUN}.${crypto.randomBytes(3).toString('hex')}@certify.test`;
  const password = 'CertifyPassw0rd!';

  let reg;
  for (let attempt = 1; attempt <= 3; attempt++) {
    reg = await api('POST', '/api/auth/register', {
      body: { organizationName: `Cert ${label} ${RUN}`, industry: 'OTHER', email, password, fullName: `Cert ${label}` },
    });
    if (reg.status !== 429) break;
    if (attempt < 3) {
      console.log(`${C.dim}  auth throttle active — waiting 30s (attempt ${attempt}/3)${C.x}`);
      await sleep(30_000);
    }
  }
  assert(
    reg.status !== 429,
    'registration is rate limited. The throttle is doing its job; wait a minute and re-run.'
  );
  assert(reg.status < 400, `register failed: ${reg.status} ${reg.text.slice(0, 120)}`);
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  assert(login.body?.accessToken, `login failed: ${login.status}`);
  return {
    email,
    token: login.body.accessToken,
    orgId: login.body.user?.organizationId,
    userId: login.body.user?.id,
  };
}

async function main() {
  console.log(`\n${C.b}Customer Assistant — MVP certification${C.x}`);
  console.log(`${C.dim}Every check drives the running system at ${API} and reads the database after.${C.x}`);

  const health = await api('GET', '/api/health').catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`\n${C.r}The API is not answering at ${API}. Start it and re-run.${C.x}\n`);
    process.exit(1);
  }

  const a = await newOrg('a');
  const b = await newOrg('b');

  // ── 15. Organization & team ────────────────────────────────────────────────
  section('Organization, authentication and roles');

  await check('An organization can register and sign in', async () => {
    assert(a.token && a.orgId, 'no session issued');
  });

  await check('An unauthenticated request is refused', async () => {
    const res = await api('GET', '/api/crm/contacts');
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check('A tampered token is refused', async () => {
    const res = await api('GET', '/api/crm/contacts', { token: a.token.slice(0, -4) + 'AAAA' });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // ── 16. Multi-tenant security ──────────────────────────────────────────────
  section('Multi-tenant isolation (tested at the API, not the UI)');

  const aContact = await api('POST', '/api/crm/contacts', {
    token: a.token,
    body: { fullName: 'Belongs To A', phoneNumber: `+23480${Date.now().toString().slice(-8)}` },
  });

  await check("Organization B cannot list organization A's contacts", async () => {
    assert(aContact.status < 400, `setup failed: ${aContact.status}`);
    const res = await api('GET', '/api/crm/contacts', { token: b.token });
    const seen = JSON.stringify(res.body ?? {});
    assert(!seen.includes('Belongs To A'), "B's contact list contained A's customer");
  });

  await check("Organization B cannot fetch organization A's contact by id", async () => {
    const id = aContact.body?.id;
    assert(id, 'no contact id to probe with');
    const res = await api('GET', `/api/crm/contacts/${id}`, { token: b.token });
    assert(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
  });

  await check("Organization B cannot delete organization A's contact", async () => {
    const id = aContact.body?.id;
    const res = await api('DELETE', `/api/crm/contacts/${id}`, { token: b.token });
    assert(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
    const still = await prisma.contact.findUnique({ where: { id } });
    assert(still, "A's contact was deleted by another organization");
  });

  await check("Organization B's dashboard does not count organization A's data", async () => {
    const res = await api('GET', '/api/analytics/dashboard', { token: b.token });
    assert(res.status < 400, `analytics failed: ${res.status}`);
    const shown = res.body?.metrics?.totalContacts;
    assert(shown !== undefined, 'dashboard has no totalContacts to compare');
    const dbCount = await prisma.contact.count({ where: { organizationId: b.orgId } });
    assert(shown === dbCount, `dashboard says ${shown}, database says ${dbCount} for this org`);
  });

  // ── 14. Dashboard ──────────────────────────────────────────────────────────
  section('Dashboard — every number traceable to real records');

  await check('Each headline metric equals its own database count', async () => {
    // Create one of each so the tiles are proving a number, not agreeing on zero.
    const contact = await api('POST', '/api/crm/contacts', {
      token: a.token,
      body: { fullName: 'Dashboard Traceability', phoneNumber: `+23490${Date.now().toString().slice(-8)}` },
    });
    assert(contact.status < 400, `contact setup failed: ${contact.status}`);
    await api('POST', '/api/crm/leads', { token: a.token, body: { contactId: contact.body.id, notes: 'dash' } });

    const res = await api('GET', '/api/analytics/dashboard', { token: a.token });
    assert(res.status < 400, `analytics failed: ${res.status}`);
    const m = res.body?.metrics ?? {};

    const expected = {
      totalContacts: await prisma.contact.count({ where: { organizationId: a.orgId } }),
      totalLeads: await prisma.lead.count({ where: { organizationId: a.orgId } }),
      totalBookings: await prisma.booking.count({ where: { organizationId: a.orgId } }),
      totalCalls: await prisma.callLog.count({ where: { organizationId: a.orgId } }),
    };

    const wrong = Object.entries(expected)
      .filter(([k, v]) => m[k] !== v)
      .map(([k, v]) => `${k}: dashboard ${m[k]}, database ${v}`);
    assert(wrong.length === 0, wrong.join('; '));
    // A tile agreeing on zero proves nothing, so require at least one non-zero.
    assert(expected.totalContacts > 0, 'no contacts existed — the comparison was vacuous');
  });

  // ── 8/11. CRM ──────────────────────────────────────────────────────────────
  section('CRM');

  await check('A contact can be created and read back', async () => {
    assert(aContact.status < 400, `create failed: ${aContact.status}`);
    const row = await prisma.contact.findUnique({ where: { id: aContact.body.id } });
    assert(row && row.organizationId === a.orgId, 'contact not stored against the creating org');
  });

  await check('A support ticket can be created against a contact', async () => {
    const res = await api('POST', '/api/crm/tickets', {
      token: a.token,
      body: { contactId: aContact.body.id, subject: 'Certification ticket', description: 'Raised by certify-mvp' },
    });
    assert(res.status < 400, `ticket create failed: ${res.status} ${res.text.slice(0, 120)}`);
    const row = await prisma.ticket.findFirst({ where: { organizationId: a.orgId } });
    assert(row, 'ticket not visible in the database');
  });

  await check('A lead and a deal can be created', async () => {
    const lead = await api('POST', '/api/crm/leads', {
      token: a.token,
      body: { contactId: aContact.body.id, notes: 'certification' },
    });
    assert(lead.status < 400, `lead create failed: ${lead.status}`);
    const deal = await api('POST', '/api/crm/deals', {
      token: a.token,
      body: { contactId: aContact.body.id, title: 'Certification deal', amount: 1000 },
    });
    assert(deal.status < 400, `deal create failed: ${deal.status}`);
  });

  // ── 9. Appointments ────────────────────────────────────────────────────────
  section('Appointments');

  const start = new Date(Date.now() + 5 * 24 * 3600_000);
  start.setMinutes(0, 0, 0);
  let bookingId = null;

  await check('An appointment can be booked and is stored', async () => {
    const res = await api('POST', '/api/scheduling/bookings', {
      token: a.token,
      body: {
        contactId: aContact.body.id,
        serviceName: 'Certification service',
        startTime: start.toISOString(),
        durationMinutes: 30,
        staffName: `staff-${RUN}`,
      },
    });
    assert(res.status < 400, `booking failed: ${res.status} ${res.text.slice(0, 160)}`);
    bookingId = res.body?.id;
    const row = await prisma.booking.findUnique({ where: { id: bookingId } });
    assert(row, 'booking not in the database');
  });

  await check('The same staff cannot be double-booked for the same slot', async () => {
    const res = await api('POST', '/api/scheduling/bookings', {
      token: a.token,
      body: {
        contactId: aContact.body.id,
        serviceName: 'Certification clash',
        startTime: start.toISOString(),
        durationMinutes: 30,
        staffName: `staff-${RUN}`,
      },
    });
    assert(res.status >= 400, `a clashing booking was accepted (${res.status})`);
  });

  await check('An appointment can be cancelled', async () => {
    assert(bookingId, 'nothing booked to cancel');
    const res = await api('PATCH', `/api/scheduling/bookings/${bookingId}/cancel`, {
      token: a.token,
      body: { reason: 'certification' },
    });
    assert(res.status < 400, `cancel failed: ${res.status}`);
  });

  // ── 7. Knowledge ───────────────────────────────────────────────────────────
  section('Business knowledge');

  await check('An FAQ can be added and is retrievable', async () => {
    const res = await api('POST', '/api/knowledge/faqs', {
      token: a.token,
      body: { question: `What is the certification widget ${RUN}?`, answer: 'It is a certification answer.' },
    });
    assert(res.status < 400, `faq create failed: ${res.status}`);
    const row = await prisma.faqEntry.findFirst({ where: { organizationId: a.orgId } });
    assert(row, 'faq not stored');
  });

  // ── 8. AI business actions (the agent tool surface) ────────────────────────
  section('AI business actions — agent tools');

  const agentKey = `ace_agent_sk_${crypto.randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: {
      organizationId: a.orgId,
      keyName: 'certification agent key',
      keyHash: crypto.createHash('sha256').update(agentKey).digest('hex'),
      keyPrefix: agentKey.slice(0, 20),
    },
  });
  const tool = (name, body = {}) =>
    api('POST', `/api/agent-tools/${name}`, { headers: { Authorization: `Bearer ${agentKey}` }, body });

  await check('An unauthenticated tool call is refused', async () => {
    const res = await api('POST', '/api/agent-tools/payment-details', { body: {} });
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("A tenant's agent key cannot reach another tenant's customer", async () => {
    const bPhone = `+23470${Date.now().toString().slice(-8)}`;
    await prisma.contact.create({
      data: { organizationId: b.orgId, phoneNumber: bPhone, fullName: 'Belongs To B' },
    });
    const res = await tool('lookup-customer', { phoneNumber: bPhone, organizationId: b.orgId });
    assert(res.body?.data?.known === false, "A's agent key found B's customer");
  });

  await check('The agent refuses to give payment details that are not configured', async () => {
    const res = await tool('payment-details');
    assert(res.body?.ok === false, 'payment details returned ok with nothing configured');
    assert(!/\d{6,}/.test(res.body?.speak ?? ''), 'an account-number-like string was produced');
  });

  await check('The agent does not promise a transfer it cannot perform', async () => {
    // A caller number, so the tool can file the callback it offers. The claim
    // being tested is that it announces only what it actually did — the tool
    // now ATTEMPTS the transfer rather than reporting whether one is possible.
    const res = await tool('handoff', { phoneNumber: `+23480${Date.now().toString().slice(-8)}` });
    assert(res.body?.data?.transferred === false, 'claimed a transfer with no call to move');
    assert(!/connecting you|putting you through/i.test(res.body?.speak ?? ''), 'announced a connection that cannot happen');
    // The sentence offers a callback; the ticket is what makes it true.
    assert(res.body?.data?.ticketId, 'promised a callback without filing one');
  });

  await check('The agent says it does not know rather than inventing an answer', async () => {
    const res = await tool('search-knowledge', { query: 'what is the mass of the moon in kilograms' });
    assert(res.body?.data?.source === 'none', `answered from ${res.body?.data?.source}`);
  });

  await check('The agent can book an appointment through its tools', async () => {
    const phone = `+23481${Date.now().toString().slice(-8)}`;
    const when = new Date(Date.now() + 9 * 24 * 3600_000).toISOString();
    const res = await tool('book-appointment', {
      phoneNumber: phone,
      fullName: 'Tool Booked',
      serviceName: 'Agent booking',
      startTime: when,
    });
    assert(res.body?.ok === true, `tool booking failed: ${res.body?.speak}`);
    const row = await prisma.booking.findUnique({ where: { id: res.body.data.bookingId } });
    assert(row && row.organizationId === a.orgId, 'booking not stored against the right org');
  });

  // ── 5. WhatsApp ────────────────────────────────────────────────────────────
  section('WhatsApp');

  await check('The webhook rejects an unsigned payload', async () => {
    const res = await api('POST', '/api/whatsapp/webhook', { body: { object: 'whatsapp_business_account', entry: [] } });
    assert(res.status === 403 || res.status === 500, `expected rejection, got ${res.status}`);
  });

  await check('Webhook verification echoes the challenge for the right token', async () => {
    const verify = process.env.WHATSAPP_VERIFY_TOKEN;
    if (!verify) return 'WHATSAPP_VERIFY_TOKEN is not set';
    const res = await api('GET', `/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verify}&hub.challenge=42`);
    assert(res.text.trim() === '42', `expected the challenge back, got ${res.text.slice(0, 60)}`);
  });

  console.log(`\n${C.dim}  The full inbound flow (contact creation, dedup, tenant routing, media,${C.x}`);
  console.log(`${C.dim}  AI reply) is covered by e2e-validation/whatsapp-inbound-probe.js.${C.x}`);

  // ── 6. Web chat, retired ───────────────────────────────────────────────────
  //
  // Not dropped from the checklist. A retired channel still has to behave, and
  // the way it fails is the whole point: tenants' sites keep the script tag for
  // as long as nobody edits them, so what those pages get back is a live
  // property of this system, not a historical footnote.
  section('Web chat widget (retired)');

  await check('The API says the widget is gone, rather than 404ing', async () => {
    const res = await api('GET', '/api/widget/config?apiKey=ace_live_pk_anything');
    // 410, specifically. A 404 also describes an outage, a bad URL or a broken
    // proxy, and someone would go looking for a fault that is not there.
    assert(res.status === 410, `expected 410 Gone, got ${res.status}`);
    assert(res.body?.retired === true, 'the response does not identify itself as retired');
  });

  await check('The embed script is inert rather than missing', async () => {
    const web = process.env.PLAYWRIGHT_TEST_BASE_URL || 'http://localhost:3000';
    const res = await fetch(`${web}/widget.js`).catch(() => null);
    if (!res) return `no web app at ${web}`;
    // Still served: a 404 here is a network error in a tenant's console that
    // reads like our outage. It must load and do nothing.
    assert(res.ok, `widget.js returned ${res.status}`);
    const body = await res.text();
    assert(/retired/i.test(body), 'widget.js does not say it has been retired');
    assert(
      !/createElement|appendChild/.test(body),
      'widget.js still builds DOM — a retired widget must render nothing'
    );
  });

  // ── 10. Payments ───────────────────────────────────────────────────────────
  section('Payments');

  await check('The Paystack webhook rejects an unsigned payload', async () => {
    if (!process.env.PAYSTACK_SECRET_KEY && !process.env.PAYSTACK_WEBHOOK_SECRET) {
      return 'no Paystack secret configured — signature verification cannot be exercised';
    }
    const res = await api('POST', '/api/billing/paystack-webhook', { body: { event: 'charge.success', data: {} } });
    assert(res.status >= 400, `an unsigned payment webhook was accepted (${res.status})`);
  });

  blocked(
    'Full payment journey (request → link → pay → webhook → verified → recorded)',
    'needs live Paystack credentials and a real payment; never exercised end to end'
  );
  blocked(
    'Duplicate payment webhooks cannot create duplicate records',
    'depends on the journey above; untested'
  );

  // ── 4 / A. Voice and ElevenLabs ────────────────────────────────────────────
  section('Voice and hosted agent (ElevenLabs)');

  const voiceMissing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'DEEPGRAM_API_KEY'].filter((k) => !process.env[k]);
  if (voiceMissing.length) {
    blocked('Inbound call answered end to end', `not configured: ${voiceMissing.join(', ')}`);
    blocked('Outbound call placed end to end', `not configured: ${voiceMissing.join(', ')}`);
    blocked('Call record written with transcript and outcome', 'no call can be placed');
  } else {
    blocked('Inbound call answered end to end', 'credentials present, but no real call has been made');
  }

  await check('ElevenLabs API is reachable', async () => {
    if (!process.env.ELEVENLABS_API_KEY) return 'ELEVENLABS_API_KEY is not set';
    const res = await fetch('https://api.elevenlabs.io/v1/models', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
    }).catch((e) => ({ ok: false, status: 0, _err: e.message }));
    if (!res.ok && res.status === 0) return `cannot reach api.elevenlabs.io (${res._err ?? 'network blocked'})`;
    assert(res.ok, `ElevenLabs returned ${res.status}`);
  });

  /**
   * The posture question, not the reachability one. A deployment with a shared
   * key set, no per-tenant keys and no opt-in looks fully configured and refuses
   * every hosted-agent operation at runtime — which is the shape of gap this
   * script exists to name before a demo does.
   *
   * ── What counts as a DEFECT here, and what does not ─────────────────────────
   *
   * A tenant with no ElevenLabs key of its own cannot use the hosted agent. That
   * is only a defect if it HAS a hosted agent — a provisioned agent with no key
   * to act with answers calls and fails every tool call, which is the exact
   * looks-provisioned-but-isn't state this file exists to catch.
   *
   * A tenant with neither is not broken, it is not set up, and grading it FAIL
   * would put "NOT MVP-COMPLETE — 1 defect" on the summary of a system whose
   * only real problem is that nobody has provisioned anything yet. The line
   * below already reports that, as BLOCKED. Reporting one state twice, once at
   * the wrong severity, is how a harness stops being believed.
   *
   * (This graded everything short of full coverage as FAIL when first written,
   * and said NOT MVP-COMPLETE for a system with no defect. That is the bug.)
   */
  await check('Each tenant has its own ElevenLabs workspace', async () => {
    const shared = (process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE ?? '').trim().toLowerCase();
    const sharing = shared === '1' || shared === 'true' || shared === 'yes';

    let total = 0;
    let withOwnKey = 0;
    let provisioned = 0;
    let provisionedWithoutKey = 0;
    try {
      const { prisma } = require('@ace/database');
      total = await prisma.organization.count();
      withOwnKey = await prisma.hostedAgentConfig.count({ where: { NOT: { apiKey: null } } });
      provisioned = await prisma.hostedAgentConfig.count({ where: { NOT: { agentId: null } } });
      provisionedWithoutKey = await prisma.hostedAgentConfig.count({
        where: { NOT: { agentId: null }, apiKey: null },
      });
    } catch (err) {
      return `cannot read the database to check (${err.message?.slice(0, 80)})`;
    }

    if (sharing) {
      return total > 1
        ? `ELEVENLABS_ALLOW_SHARED_WORKSPACE is set with ${total} organizations — they share one workspace, so one key reads every tenant's numbers, WhatsApp lines and transcripts`
        : 'ELEVENLABS_ALLOW_SHARED_WORKSPACE is set; correct for a single-tenant deployment, and must come off before a second tenant is added';
    }

    // The one genuine defect: an agent exists and has nothing to act with. It
    // will answer a customer and fail every tool call it makes.
    assert(
      provisionedWithoutKey === 0,
      `${provisionedWithoutKey} organization(s) have a provisioned agent but no ElevenLabs key of their own — those agents answer customers and every tool call is refused`
    );

    if (provisioned === 0) {
      return `no organization has a provisioned agent yet; ${total - withOwnKey} of ${total} also have no ElevenLabs key of their own (POST /api/agent-provisioning/credentials, or set ELEVENLABS_ALLOW_SHARED_WORKSPACE=1 for a single-tenant deployment)`;
    }
    if (withOwnKey < total) {
      // A partial rollout, which is what a careful migration looks like. Worth
      // naming; not a defect, because the tenants without a key have no agent
      // either and so are not being failed at.
      return `${provisioned} of ${total} organizations are on the hosted agent; the remaining ${total - withOwnKey} have no ElevenLabs key of their own and cannot be until they do`;
    }
  });

  blocked('An ElevenLabs agent answers and calls back into the tools', 'no agent has been registered against these endpoints');

  // ── Summary ────────────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const block = results.filter((r) => r.status === 'BLOCKED').length;

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${C.b}${pass} passed · ${fail} failed · ${block} blocked${C.x}`);

  if (fail) {
    console.log(`\n${C.r}Failed${C.x}`);
    for (const r of results.filter((r) => r.status === 'FAIL')) {
      console.log(`  · [${r.area}] ${r.name}\n    ${C.dim}${r.detail ?? ''}${C.x}`);
    }
  }

  if (block) {
    console.log(`\n${C.y}Blocked — NOT passed, and nothing is known about these${C.x}`);
    for (const r of results.filter((r) => r.status === 'BLOCKED')) {
      console.log(`  · [${r.area}] ${r.name}\n    ${C.dim}${r.detail ?? ''}${C.x}`);
    }
  }

  console.log(
    `\n${C.b}Certification status: ${
      fail ? `${C.r}NOT MVP-COMPLETE — ${fail} defect(s)` : block ? `${C.y}NOT CERTIFIABLE — ${block} area(s) never exercised` : `${C.g}all exercised checks passed`
    }${C.x}`
  );
  // Deliberately no percentage. A number would average blocked items into
  // something that reads like progress; they are absence of evidence, not
  // partial credit.
  console.log();

  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`\n${C.r}Certification run failed:${C.x} ${err.message}`);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
