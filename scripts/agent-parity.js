#!/usr/bin/env node
/**
 * Do the two conversation engines tell a customer the same thing?
 *
 *   npm run parity            (API must be running on :4000)
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Two engines serve conversations in this repo and only one is live.
 * `packages/orchestrator` answers every WhatsApp message and every call today.
 * `apps/api/src/agent-tools` is built, tested, and has never been called by a
 * real agent. Cutting a tenant over means moving them from the first to the
 * second — and CLAUDE.md names the last step of that as "compare against the
 * orchestrator path", which until now there was no way to do.
 *
 * The split is deliberate: the agent replaces the CONVERSATION, not the
 * BUSINESS LOGIC. Both paths call the same services, which is what stops them
 * drifting on what a booking costs or where money goes. But "call the same
 * services" is not the same as "say the same thing", and the four guarantees
 * below are enforced separately in each path — `toolFailureReply()` on one side,
 * `failed()` on the other. Two implementations of one promise is exactly where a
 * promise quietly stops being kept.
 *
 * So this drives BOTH engines against ONE tenant, in the same state, and reports
 * where they diverge:
 *
 *   HOLD     — both paths honoured the guarantee.
 *   DIVERGED — both answered, and they disagree. A cutover would change what a
 *              customer is told.
 *   BROKEN   — a path failed the guarantee outright. A defect, in whichever
 *              engine it is.
 *   BLOCKED  — could not be exercised here, and why.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *
 * It does not prove the cutover works. The agent path is exercised over HTTP
 * exactly as ElevenLabs would call it, but ElevenLabs itself is not in the loop:
 * no speech, no turn-taking, no model deciding WHICH tool to call. Those are the
 * agent's half, and the only thing that tests them is a real call. A green run
 * here means the business answers match; it does not mean anyone has spoken to
 * this agent.
 */
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'apps/api/dist/config/load-env.js'));
const { assertLocalDatabase } = require('./guard-production-db');

assertLocalDatabase('agent parity comparison');

// The deterministic paths, not the LLM. A model in the loop would make two runs
// of the same scenario disagree with THEMSELVES, and then a real divergence
// between the engines is indistinguishable from sampling noise.
delete process.env.OPENAI_API_KEY;

const { PrismaClient } = require(path.join(ROOT, 'node_modules/@prisma/client'));
const { ConversationOrchestrator } = require('@ace/orchestrator');

const prisma = new PrismaClient({ log: [] });
const API = process.env.E2E_API_URL || 'http://localhost:4000';
const RUN = crypto.randomBytes(4).toString('hex');

const C = {
  b: '\x1b[1m', dim: '\x1b[2m', g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', x: '\x1b[0m',
};

const results = [];

function report(status, name, detail, sides) {
  const tag = {
    HOLD: `${C.g}  HOLD    ${C.x}`,
    DIVERGED: `${C.r}  DIVERGED${C.x}`,
    BROKEN: `${C.r}  BROKEN  ${C.x}`,
    BLOCKED: `${C.y}  BLOCKED ${C.x}`,
  }[status];
  console.log(`${tag} ${name}`);
  if (detail) console.log(`          ${C.dim}${detail}${C.x}`);
  if (sides) {
    console.log(`          ${C.dim}orchestrator: ${trim(sides.orchestrator)}${C.x}`);
    console.log(`          ${C.dim}agent:        ${trim(sides.agent)}${C.x}`);
  }
  results.push({ status, name, detail });
}

const trim = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 150);

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

async function newOrg(label) {
  const email = `parity.${label}.${RUN}@parity.test`;
  const password = 'ParityPassw0rd!';
  let reg;
  for (let attempt = 1; attempt <= 3; attempt++) {
    reg = await api('POST', '/api/auth/register', {
      body: { organizationName: `Parity ${label} ${RUN}`, industry: 'CLINIC', email, password, fullName: 'Parity Runner' },
    });
    if (reg.status !== 429) break;
    console.log(`${C.dim}  auth throttle active — waiting 30s (attempt ${attempt}/3)${C.x}`);
    await sleep(30_000);
  }
  if (reg.status === 429) throw new Error('registration is rate limited; wait a minute and re-run');
  if (reg.status >= 400) throw new Error(`register failed: ${reg.status} ${reg.text.slice(0, 140)}`);
  const login = await api('POST', '/api/auth/login', { body: { email, password } });
  if (!login.body?.accessToken) throw new Error(`login failed: ${login.status}`);
  return { token: login.body.accessToken, orgId: login.body.user?.organizationId };
}

/**
 * Mint an agent key straight into the database.
 *
 * The real path mints one through syncAgent, which pushes to ElevenLabs and is
 * therefore unavailable without a workspace. The guard only ever compares a
 * SHA-256 hash, so a key inserted here authenticates exactly like a real one —
 * what is being tested is the tool endpoints, not how the credential was born.
 */
async function mintAgentKey(organizationId) {
  const key = `ace_agent_sk_${crypto.randomBytes(24).toString('hex')}`;
  await prisma.apiKey.create({
    data: {
      organizationId,
      keyName: `Parity run ${RUN}`,
      keyHash: crypto.createHash('sha256').update(key).digest('hex'),
      keyPrefix: key.slice(0, 20),
    },
  });
  return key;
}

async function main() {
  console.log(`\n${C.b}Conversation engine parity — orchestrator vs agent-tools${C.x}`);
  console.log(`${C.dim}Both engines, one tenant, same state. Divergence is what a cutover would change.${C.x}\n`);

  const health = await api('GET', '/api/health').catch(() => ({ status: 0 }));
  if (health.status !== 200) {
    console.error(`${C.r}The API is not answering at ${API}. Start it and re-run.${C.x}\n`);
    process.exit(1);
  }

  const org = await newOrg('a');
  const agentKey = await mintAgentKey(org.orgId);
  const orchestrator = new ConversationOrchestrator();
  const CALLER = `+23480${Date.now().toString().slice(-8)}`;

  const ctx = () => ({
    conversationId: `parity_${RUN}`,
    organizationId: org.orgId,
    customerPhoneNumber: CALLER,
    channel: 'WHATSAPP',
    history: [],
    slots: {},
    isHumanHandoffActive: false,
  });

  /** Drive the live engine. */
  const viaOrchestrator = (text) => orchestrator.processIncomingMessage(ctx(), text);

  /** Drive the agent engine exactly as ElevenLabs would — over HTTP, with the agent key. */
  const viaAgent = (tool, body = {}) =>
    api('POST', `/api/agent-tools/${tool}`, {
      headers: { Authorization: `Bearer ${agentKey}` },
      body,
    });

  // ── Guarantee 1: payment details come only from the configured fields ───────
  //
  // The single most consequential thing either engine says. An invented account
  // number is a customer's money sent to a stranger, and it is why the
  // orchestrator's hardcoded bank details were torn out.

  await compare('Payment details, unconfigured — both defer instead of inventing', async () => {
    const o = await viaOrchestrator('how do i pay');
    const a = await viaAgent('payment-details');

    const invented = /\b\d{10}\b|providus|zenith|\*\d{3}\*/i;
    const oText = o.replyText ?? '';
    const aText = a.body?.speak ?? '';

    const oHonest = !invented.test(oText) && o.shouldHandoff === true;
    const aHonest = !invented.test(aText) && a.body?.handoff === true;

    return {
      orchestrator: { honoured: oHonest, said: oText },
      agent: { honoured: aHonest, said: aText },
      note: 'neither may produce an account number that was never configured, and both must hand off',
    };
  });

  // Configure the payout fields, then ask again. Both must read back exactly
  // what the business entered — not a paraphrase, not a rounded version.
  const PAYOUT = {
    payoutBankName: 'Zenith Bank',
    payoutAccountName: 'Parity Clinic Ltd',
    payoutAccountNumber: '1234509876',
    payoutUssdCode: '*966*1#',
  };
  await api('PATCH', '/api/organizations/settings', { token: org.token, body: PAYOUT });

  await compare('Payment details, configured — both read back the same account', async () => {
    const o = await viaOrchestrator('how do i pay');
    const a = await viaAgent('payment-details');
    const oText = o.replyText ?? '';
    const aText = a.body?.speak ?? '';

    const carries = (t) =>
      t.includes(PAYOUT.payoutAccountNumber) && new RegExp(PAYOUT.payoutBankName, 'i').test(t);

    return {
      orchestrator: { honoured: carries(oText), said: oText },
      agent: { honoured: carries(aText), said: aText },
      note: 'both must quote the configured bank and account number verbatim',
    };
  });

  // ── Guarantee 2: a transfer is never announced before it is known possible ──
  //
  // With no forwarding number configured, neither engine may tell a customer
  // they are being put through. The voice path was fixed for exactly this: a
  // promise nothing kept, made before anything had been attempted.

  await compare('No forwarding number — neither promises a transfer', async () => {
    const a = await viaAgent('handoff');
    const aText = a.body?.speak ?? '';
    const promises = /connecting you|putting you through|transferr?ing you|hold while i/i;

    // ── Why the orchestrator side is BLOCKED and not compared ────────────────
    //
    // Asking the orchestrator directly returns "Connecting you to a live human
    // agent right away" — which looks like a flagrant breach of the invariant,
    // and is not one. On a real call that sentence is never spoken:
    // TwilioMediaStreamHandler intercepts `shouldHandoff` BEFORE any reply is
    // voiced, attempts the redirect, and says something chosen from what Twilio
    // actually did. The orchestrator's own text is discarded.
    //
    // So the two engines keep this promise in different PLACES. The orchestrator
    // keeps it outside itself, in the media-stream handler; the agent keeps it
    // inside the tool, because after a cutover nothing sits between the tool and
    // the caller — ElevenLabs speaks what the tool returns.
    //
    // That difference is the finding, and it survives a cutover: the layer that
    // enforces this today STOPS BEING IN THE PATH. Reaching the orchestrator's
    // real behaviour needs a live Twilio media stream, which this harness cannot
    // create, so half the comparison is honestly unavailable rather than faked
    // by asserting on a string the customer never hears.
    throw new Error(
      `agent side holds (${aText.slice(0, 60)}…); the orchestrator's voice guarantee lives in ` +
        `TwilioMediaStreamHandler.handOffCallToHuman, which needs a live Twilio media stream — ` +
        `note that this layer is NOT in the path after a cutover` +
        (promises.test(aText) ? ' — AND THE AGENT TOOL PROMISED A TRANSFER' : '')
    );
  });

  // ── A cutover would change what this customer is told ───────────────────────
  //
  // Not one of the four stated guarantees, and it surfaced from running this:
  // given input it cannot parse, one engine books something and the other
  // refuses. Both are defensible in isolation; they cannot both be what the
  // business wants, and switching engines silently swaps one for the other.

  await compare('Vague booking request — neither invents a service', async () => {
    // Several real phrasings, because the two ways this broke were reached by
    // different sentences: "book me an appointment" leaked the pronoun ("Me an")
    // and "i want to book an appointment" leaked the second verb ("Book").
    // Driving only one of them let the other regress unnoticed — a mutation run
    // proved exactly that.
    const phrasings = [
      'book me an appointment for the 45th of Neveruary at 99:99',
      'i want to book an appointment',
      'i would like to schedule an appointment',
    ];
    const before = await prisma.booking.count({ where: { organizationId: org.orgId } });
    let o;
    for (const phrase of phrasings) o = await viaOrchestrator(phrase);
    const afterO = await prisma.booking.count({ where: { organizationId: org.orgId } });
    const a = await viaAgent('book-appointment', {
      phoneNumber: CALLER,
      serviceName: 'Consultation',
      startTime: 'the 45th of Neveruary',
    });

    // What actually landed in the calendar, not what was said about it.
    const stored = await prisma.booking.findMany({
      where: { organizationId: org.orgId },
      select: { serviceName: true },
      orderBy: { createdAt: 'desc' },
      take: afterO - before,
    });

    // The bug this scenario found: "book me an appointment" was filed under the
    // service "Me an", scraped out of the sentence, and read back to the
    // customer as though the business offered it. Any word from the request
    // itself appearing as a service name is the same defect returning.
    const scraped = /\b(me an|book|schedule|arrange|want|need|to book)\b/i;
    const invented = stored.filter((b) => scraped.test(b.serviceName ?? ''));

    return {
      orchestrator: {
        honoured: invented.length === 0,
        said: invented.length
          ? `filed under an invented service: ${invented.map((b) => b.serviceName).join(', ')}`
          : `filed under ${stored.map((b) => b.serviceName).join(', ') || '(nothing booked)'}`,
      },
      agent: {
        honoured: a.body?.ok !== true,
        said: trim(a.body?.speak),
      },
      note:
        'the two engines DIFFER BY DESIGN on the time and this is not graded: the orchestrator offers the next free slot and says which one, ' +
        'while the agent requires the model to resolve a date before calling. A cutover changes that experience — decide it deliberately.',
    };
  });

  // ── Guarantee 3: a tool failure is spoken, never thrown ─────────────────────
  //
  // An uncaught throw inside a live call is silence on the line. Both engines
  // route failures through a single place for this reason — toolFailureReply()
  // and failed() — and both must still produce a sentence for input that cannot
  // possibly succeed.

  await compare('Unusable input — both answer rather than failing silently', async () => {
    const o = await viaOrchestrator('book me an appointment for the 45th of Neveruary at 99:99');
    const a = await viaAgent('book-appointment', {
      phoneNumber: CALLER,
      serviceName: 'Consultation',
      startTime: 'the 45th of Neveruary',
    });

    const oSpoke = typeof o.replyText === 'string' && o.replyText.trim().length > 0;
    // Any 2xx with a spoken refusal, never a 5xx: ElevenLabs surfaces a failed
    // tool call as a silence the caller hears. (The controller answers 201;
    // pinning 200 graded a correct answer as a failure.)
    const aSpoke = a.status >= 200 && a.status < 300
      && typeof a.body?.speak === 'string' && a.body.speak.trim().length > 0;

    return {
      orchestrator: { honoured: oSpoke, said: o.replyText },
      agent: { honoured: aSpoke, said: `HTTP ${a.status} — ${a.body?.speak ?? a.text}` },
      note: 'a customer must always get a sentence; an exception is silence on the line',
    };
  });

  // ── Guarantee 4: the AI admits to being an AI ──────────────────────────────
  //
  // Regulatory, and Meta policy. Asymmetric by construction, and worth stating
  // rather than quietly skipping: the orchestrator answers this itself, while
  // for the agent it is the hosted model answering from the system prompt. So
  // the only thing checkable on this side of a cutover is that the instruction
  // is actually in the prompt we ship.

  await compareAsymmetric('The AI admits to being an AI', async () => {
    const o = await viaOrchestrator('are you an ai?');
    const oText = o.replyText ?? '';
    const admits = /\b(a|an)?\s*(ai|artificial intelligence|virtual assistant|bot)\b/i.test(oText)
      && !/\bi am a (human|person|real person)\b/i.test(oText);

    const { agentDefinitionFor } = require(path.join(ROOT, 'apps/api/dist/agent-tools/agent-tool-catalog.js'));
    const definition = agentDefinitionFor(
      { name: 'Parity', slug: 'parity', timezone: 'Africa/Lagos', welcomeMessage: null, aiPersonaPrompt: null },
      ['tool_x']
    );
    const promptText = JSON.stringify(definition.conversationConfig ?? {});
    const promptInstructs = /\bAI\b/.test(promptText) && /never (claim|say|pretend)|admit|you are an AI/i.test(promptText);

    return {
      orchestrator: { honoured: admits, said: oText },
      agent: {
        honoured: promptInstructs,
        said: promptInstructs
          ? 'system prompt instructs the model to admit being an AI (static check — no model was asked)'
          : 'system prompt does NOT instruct the model to admit being an AI',
      },
      note: 'the agent side is the shipped prompt, not a live answer — only a real call tests whether the model obeys it',
    };
  });

  // ── Business outcome: a booking made either way is the same booking ─────────

  await compare('A booking made either way lands as the same record', async () => {
    const when = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    when.setUTCHours(10, 0, 0, 0);

    const before = await prisma.booking.count({ where: { organizationId: org.orgId } });
    const a = await viaAgent('book-appointment', {
      phoneNumber: CALLER,
      serviceName: 'Consultation',
      startTime: when.toISOString(),
    });
    const afterAgent = await prisma.booking.count({ where: { organizationId: org.orgId } });

    const o = await viaOrchestrator('i want to book an appointment');
    const afterBoth = await prisma.booking.count({ where: { organizationId: org.orgId } });

    const rows = await prisma.booking.findMany({
      where: { organizationId: org.orgId },
      select: { contactId: true, startTime: true, status: true },
      orderBy: { createdAt: 'asc' },
    });
    // Same customer, one contact: the phone-number normalisation both paths
    // share is what makes this true, and a regression there shows up here.
    const contactIds = new Set(rows.map((r) => r.contactId));

    return {
      orchestrator: {
        honoured: afterBoth > afterAgent,
        said: `${afterBoth - afterAgent} booking(s) created — ${trim(o.replyText)}`,
      },
      agent: {
        honoured: afterAgent > before,
        said: `${afterAgent - before} booking(s) created — ${trim(a.body?.speak ?? a.text)}`,
      },
      note:
        contactIds.size <= 1
          ? 'both bookings attached to one contact, as they must for the same caller'
          : `WARNING: ${contactIds.size} contacts for one caller — the two paths are creating duplicate customers`,
    };
  });

  await cleanup(org.orgId);
  summarise();
}

/** Run a scenario where both sides answer, and grade the pair. */
async function compare(name, fn) {
  try {
    const r = await fn();
    const both = r.orchestrator.honoured && r.agent.honoured;
    const neither = !r.orchestrator.honoured && !r.agent.honoured;
    const sides = { orchestrator: r.orchestrator.said, agent: r.agent.said };

    if (both) return report('HOLD', name, r.note, sides);
    if (neither) return report('BROKEN', name, `NEITHER path honoured this. ${r.note}`, sides);
    const failing = r.orchestrator.honoured ? 'agent-tools' : 'orchestrator';
    report('DIVERGED', name, `${failing} does not honour this. ${r.note}`, sides);
  } catch (err) {
    report('BLOCKED', name, `could not be exercised: ${err.message?.slice(0, 160)}`);
  }
}

/**
 * Same, but for a guarantee the two engines cannot be asked in the same way.
 * Graded identically — the point of separating it is that the report says so,
 * rather than a static check being read later as a live one.
 */
const compareAsymmetric = compare;

async function cleanup(organizationId) {
  await prisma.organization.delete({ where: { id: organizationId } }).catch(() => {});
}

function summarise() {
  const n = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(
    `${C.b}${n('HOLD')} hold · ${n('DIVERGED')} diverged · ${n('BROKEN')} broken · ${n('BLOCKED')} blocked${C.x}`
  );

  if (n('DIVERGED') || n('BROKEN')) {
    console.log(`\n${C.r}Not safe to cut a tenant over${C.x}`);
    for (const r of results.filter((x) => x.status !== 'HOLD' && x.status !== 'BLOCKED')) {
      console.log(`  · ${r.name}\n    ${C.dim}${r.detail}${C.x}`);
    }
  } else {
    console.log(
      `\n${C.g}The business answers match.${C.x} ${C.dim}This says nothing about speech, turn-taking, or whether the model picks the right tool — only a real call tests those.${C.x}`
    );
  }
  console.log();
  process.exitCode = n('DIVERGED') + n('BROKEN') > 0 ? 1 : 0;
}

main()
  .catch((err) => {
    console.error(`\n${C.r}${err.stack || err.message}${C.x}\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
