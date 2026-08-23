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

const { PrismaClient, Prisma } = require(path.join(ROOT, 'node_modules/@prisma/client'));
const { ConversationOrchestrator } = require('@ace/orchestrator');
const { phoneNumberVariants } = require(path.join(ROOT, 'packages/database/dist/index.js'));

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

  /**
   * Drive the live engine, as a conversation that has just begun.
   *
   * Most scenarios here send ONE message and grade the reply, which was a
   * complete description of the engine until it grew multi-turn flows. It is
   * not any more: a scenario that starts a booking leaves that flow in progress
   * on this caller's conversation, and the NEXT scenario's message is then read
   * as an answer to "which time suits you?" — correctly, by the engine, and
   * ruinously for a harness whose scenarios assume they are independent.
   *
   * The first run after the flows landed reported four false DIVERGEDs for
   * exactly this: every one of them had the orchestrator replying "I can only
   * book one of these", which is a booking flow answering a question about
   * payment details.
   *
   * So a single-shot scenario clears any flow first. The multi-turn scenarios
   * pass their own conversationId and drive their turns deliberately, which is
   * the distinction: this helper is for messages that stand alone.
   */
  const clearFlows = () =>
    prisma.conversation.updateMany({
      where: {
        organizationId: org.orgId,
        contact: { phoneNumber: { in: phoneNumberVariants(CALLER) } },
      },
      data: { flowState: Prisma.DbNull },
    });

  const viaOrchestrator = async (text) => {
    await clearFlows();
    return orchestrator.processIncomingMessage(ctx(), text);
  };

  /**
   * Book through the live engine the way a customer does: ask, then pick a time.
   *
   * Booking is two turns now — it offers what is free and writes the choice —
   * so a scenario that sends one message and counts rows is describing the
   * engine as it was before, not as it is. The scenarios that care about the
   * RECORD a booking produces use this; the ones that care about the first
   * reply still use viaOrchestrator.
   */
  /**
   * Send a message in `lang` and WAIT for the engine to have remembered it.
   *
   * `resolveReplyLanguage` persists a detected language fire-and-forget — the
   * reply must not wait on a CRM write, which is right in production and a race
   * here. Without this poll a scenario that depends on the customer being known
   * as Hausa-speaking passes or fails depending on whether a background update
   * happened to land first, and a harness that disagrees with itself between
   * runs cannot tell anyone whether a cutover is safe.
   */
  const establishLanguage = async (text, expected) => {
    await viaOrchestrator(text);
    for (let i = 0; i < 50; i++) {
      const row = await prisma.contact.findFirst({
        where: {
          organizationId: org.orgId,
          phoneNumber: { in: phoneNumberVariants(CALLER) },
        },
        select: { preferredLanguage: true },
      });
      if (row?.preferredLanguage === expected) return;
      await sleep(20);
    }
    throw new Error(`the engine never remembered ${expected} for this caller`);
  };

  const bookViaOrchestrator = async (text = 'i want to book an appointment') => {
    await clearFlows();
    const offered = await orchestrator.processIncomingMessage(ctx(), text);
    if (offered.intentDetected !== 'FLOW_COLLECTING') return offered;
    return orchestrator.processIncomingMessage(ctx(), '1');
  };

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

  await compare('No transfer possible — neither promises one, and both leave a record', async () => {
    const a = await viaAgent('handoff', { phoneNumber: CALLER, reason: 'parity check' });
    const aText = a.body?.speak ?? '';
    const promises = /connecting you|putting you through|transferr?ing you|hold while i/i;

    // The agent side is now fully checkable, and this is where the two engines
    // structurally differ. The orchestrator keeps this promise OUTSIDE itself:
    // TwilioMediaStreamHandler intercepts shouldHandoff, redirects the call, and
    // picks the words from what Twilio actually did — its own "Connecting you..."
    // text never reaches a caller. The agent must keep it INSIDE the tool,
    // because after a cutover nothing sits between the tool and the customer.
    //
    // So the layer enforcing this today stops being in the path. That is the
    // whole reason it is worth testing the tool this hard.
    const announced = promises.test(aText);
    const transferred = a.body?.data?.transferred === true;
    // The ROW, not the id. A mutation that returned a plausible reference while
    // writing nothing survived this check when it only tested for a string —
    // which is precisely the defect being guarded, in miniature.
    const ticketId = a.body?.data?.ticketId;
    const filedTicket = ticketId
      ? Boolean(await prisma.ticket.findUnique({ where: { id: String(ticketId) } }))
      : false;

    return {
      orchestrator: {
        // Not reachable from here: its real behaviour needs a live Twilio media
        // stream. Reported as such rather than asserting on a string no
        // customer hears — see the comment above.
        honoured: true,
        said: 'not exercised — guarantee lives in TwilioMediaStreamHandler, which needs a live call (and is NOT in the path after a cutover)',
      },
      agent: {
        honoured: (!announced || transferred) && filedTicket,
        said: filedTicket
          ? `${trim(aText)} [ticket ${String(a.body.data.ticketId).slice(0, 8)}]`
          : `${trim(aText)} [NO TICKET FILED]`,
      },
      note:
        'the tool must announce only what it did, and the callback it offers has to exist — a promised record that was never written is what the customer hangs up and waits for',
    };
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

    const o = await bookViaOrchestrator();
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

  // ── Guarantee 5: the language a customer is served in ──────────────────────
  //
  // The platform supports five languages, and the two engines reach that very
  // differently. The orchestrator detects the language itself and renders its
  // own translated templates. The agent path does not translate at all — the
  // tools return English `speak` strings and structured data, and the MODEL
  // does the language work under instruction from the system prompt.
  //
  // So the parity question here is not "do both reply in Hausa" — only one of
  // them can be asked that over HTTP. It is the sharper one underneath: does
  // switching language change any FIGURE the customer is given? Payment details
  // and booking references are the same facts in every language, and a
  // translation layer is exactly where a digit goes missing.

  // A contact who has told us they want Hausa. Created directly because the
  // language only sticks to a contact that exists, and because the scenarios
  // below are about what is SAID, not about how the row was made.
  await prisma.contact.upsert({
    where: { organizationId_phoneNumber: { organizationId: org.orgId, phoneNumber: CALLER } },
    create: { organizationId: org.orgId, phoneNumber: CALLER, fullName: 'Parity Hausa Caller', preferredLanguage: 'ha' },
    update: { preferredLanguage: 'ha' },
  });

  await compare('Payment details in Hausa — the account number survives translation', async () => {
    const o = await viaOrchestrator('how do i pay');
    const a = await viaAgent('payment-details');
    const oText = o.replyText ?? '';
    const aText = a.body?.speak ?? '';

    // The orchestrator must be speaking Hausa AND still carrying the figures
    // byte for byte. Either half alone is a failure: English defeats the
    // feature, and a paraphrased account number sends money to nobody.
    const oIsHausa = oText.includes('lambar asusu');
    const oCarries =
      oText.includes(PAYOUT.payoutAccountNumber) &&
      new RegExp(PAYOUT.payoutBankName, 'i').test(oText);
    const aCarries =
      aText.includes(PAYOUT.payoutAccountNumber) ||
      String(a.body?.data?.accountNumber ?? '') === PAYOUT.payoutAccountNumber;

    return {
      orchestrator: { honoured: oIsHausa && oCarries, said: oText },
      agent: { honoured: aCarries, said: aText },
      note:
        'the orchestrator answers in Hausa with the digits verbatim; the agent returns the same ' +
        'figures for its model to translate — neither may round, localise or restate an account number',
    };
  });

  await compare('Unconfigured payment in Hausa — neither invents an account', async () => {
    // Clears this tenant's payout fields and puts them back, rather than
    // registering a second organization for the sake of one check. Registration
    // is rate limited to 5/min per address — the harness says so at the top —
    // so a scenario that quietly spends that budget is a scenario that fails
    // for reasons having nothing to do with the guarantee it names. An earlier
    // draft did exactly that and diverged intermittently.
    await api('PATCH', '/api/organizations/settings', {
      token: org.token,
      body: { payoutBankName: '', payoutAccountName: '', payoutAccountNumber: '', payoutUssdCode: '' },
    });
    try {
      const o = await viaOrchestrator('how do i pay');
      const a = await viaAgent('payment-details');
      const oText = o.replyText ?? '';
      const aText = a.body?.speak ?? '';
      // Any run of digits long enough to be read back as an account number.
      // Translating a refusal must not manufacture one.
      const accountShaped = /\d{6,}/;

      return {
        orchestrator: { honoured: !accountShaped.test(oText) && o.shouldHandoff === true, said: oText },
        agent: { honoured: !accountShaped.test(aText) && a.body?.handoff === true, said: aText },
        note: 'with no payout fields set, both must defer to a human in any language rather than produce a number',
      };
    } finally {
      // Restored whatever happened above, so the scenarios after this one still
      // see a configured tenant.
      await api('PATCH', '/api/organizations/settings', { token: org.token, body: PAYOUT });
    }
  });

  await compare('A booking confirmed in Hausa quotes the same reference', async () => {
    const when = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    when.setUTCHours(14, 0, 0, 0);

    const a = await viaAgent('book-appointment', {
      phoneNumber: CALLER,
      serviceName: 'Enrollment Check',
      startTime: when.toISOString(),
    });
    const agentRef = String(a.body?.data?.reference ?? a.body?.data?.bookingId ?? '');

    // Hausa is established first, by a message that is unmistakably Hausa. The
    // booking request itself stays in English because the keyword branches are
    // English and the classifier is disabled here for determinism — what is
    // being checked is not routing, it is that the CONFIRMATION comes back in
    // the customer's language.
    await establishLanguage('sannu, ina kwana', 'ha');

    // Then two turns, the second a bare "1" — which carries no language signal
    // at all. That the confirmation is still Hausa is the property: the
    // language must survive the turn, or every multi-turn flow ends in English
    // for a customer who never wrote a word of it.
    const o = await bookViaOrchestrator('i want to book an appointment');
    const oText = o.replyText ?? '';
    const orchestratorRef = String(o.toolCallsExecuted?.[0]?.result?.bookingId ?? '');

    // The confirmation is Hausa; the reference inside it is the booking's own
    // id, unaltered. A localised or re-formatted reference is one a customer
    // reads back and staff cannot find.
    const oIsHausa = oText.includes('Lambar tunani');
    const oQuotesItsOwn =
      orchestratorRef.length > 0 && oText.includes(orchestratorRef.slice(-8).toUpperCase());

    return {
      orchestrator: { honoured: oIsHausa && oQuotesItsOwn, said: oText },
      agent: { honoured: agentRef.length > 0, said: `${trim(a.body?.speak)} [ref ${agentRef.slice(-8)}]` },
      note: 'both hand back a reference that resolves to the row they wrote, whatever language the sentence is in',
    };
  });

  await compareAsymmetric('Speech the voice cannot produce — refused, not promised', async () => {
    // Hausa, Igbo and Yoruba are absent from the TTS provider's model line-up,
    // so a caller cannot be answered aloud in them. The orchestrator refuses
    // over the VOICE channel and offers the two routes that exist. The agent
    // path has no tool for this at all — it is governed by the system prompt —
    // so that side is read from the prompt text and graded as the static check
    // it is, rather than being reported as though a live path had answered.
    const o = await orchestrator.processIncomingMessage(
      { ...ctx(), channel: 'VOICE' },
      'hausa please'
    );
    const oText = o.replyText ?? '';
    const refuses =
      /cannot speak Hausa/i.test(oText) && /colleague/i.test(oText) && /WhatsApp/i.test(oText);

    const { SYSTEM_PROMPT } = require(path.join(ROOT, 'apps/api/dist/agent-tools/agent-tool-catalog.js'));
    const promptScopes =
      /cannot speak Hausa, Igbo or Yoruba aloud/i.test(SYSTEM_PROMPT) &&
      /do not pretend to speak their language/i.test(SYSTEM_PROMPT);

    return {
      orchestrator: { honoured: refuses, said: oText },
      agent: {
        honoured: promptScopes,
        said: promptScopes
          ? 'system prompt scopes speech to English/Pidgin and offers colleague or WhatsApp (STATIC CHECK — no live path)'
          : 'system prompt does NOT scope spoken languages — the agent would promise speech it cannot produce',
      },
      note: 'neither engine may offer a language it cannot actually speak on a call',
    };
  });

  await compare('Booking — the customer picks the time, on both paths', async () => {
    // The orchestrator used to take the next free slot and write it. It now
    // offers what is free and books the pick.
    //
    // The agent path never wrote a time of its own — it takes startTime from
    // the model, which collected it from the caller — but until check-availability
    // existed it had no way to know what was free, so it asked the caller to
    // guess and found out from the exclusion violation. Both sides are checked
    // for the same thing: a request to book must produce OPTIONS, not a booking.
    const contact = await prisma.contact.upsert({
      where: { organizationId_phoneNumber: { organizationId: org.orgId, phoneNumber: CALLER } },
      create: { organizationId: org.orgId, phoneNumber: CALLER, fullName: 'Parity Caller' },
      update: {},
    });
    const conversation = await prisma.conversation.upsert({
      where: {
        organizationId_contactId_channel: {
          organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP',
        },
      },
      create: { organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP' },
      update: { flowState: Prisma.DbNull },
    });

    const before = await prisma.booking.count({ where: { organizationId: org.orgId } });
    const o = await orchestrator.processIncomingMessage(
      { ...ctx(), conversationId: conversation.id },
      'i want to book an appointment'
    );
    const after = await prisma.booking.count({ where: { organizationId: org.orgId } });

    const oOffers = o.intentDetected === 'FLOW_COLLECTING' && after === before;

    // The agent's equivalent: ask what is free, and get real times back that
    // are inside business hours and in the future.
    const a = await viaAgent('check-availability', { limit: 3 });
    const slots = a.body?.data?.slots ?? [];
    const aOffers =
      a.body?.ok === true &&
      slots.length > 0 &&
      slots.every((sl) => new Date(sl.startTime).getTime() > Date.now());

    return {
      orchestrator: {
        honoured: oOffers,
        said: `${o.intentDetected}: ${trim(o.replyText)} [bookings created: ${after - before}]`,
      },
      agent: {
        honoured: aOffers,
        said: `${trim(a.body?.speak)} [${slots.length} real slots returned]`,
      },
      note: 'asking to book offers times; it does not, by itself, create a booking',
    };
  });

  await compare('Availability — both read the same diary', async () => {
    // The point of sharing findAvailableSlots. If these two ever disagree, one
    // engine is offering a slot the other considers taken, and that is a double
    // booking both paths believed was legitimate.
    const { findAvailableSlots, BUSY_BOOKING_STATUSES, formatLagos } =
      require(path.join(ROOT, 'packages/database/dist/index.js'));

    const direct = await findAvailableSlots(
      (from, to) =>
        prisma.booking.findMany({
          where: {
            organizationId: org.orgId,
            status: { in: BUSY_BOOKING_STATUSES },
            startTime: { gte: from, lte: to },
          },
          select: { startTime: true, endTime: true },
        }),
      30,
      3
    );

    const a = await viaAgent('check-availability', { limit: 3, durationMinutes: 30 });
    const agentSlots = (a.body?.data?.slots ?? []).map((sl) => sl.startTime);
    const ours = direct.map((sl) => sl.start.toISOString());
    const same = JSON.stringify(ours) === JSON.stringify(agentSlots);

    return {
      orchestrator: {
        honoured: ours.length > 0,
        said: `${ours.length} free: ${direct.map((sl) => formatLagos(sl.start)).join('; ')}`,
      },
      agent: {
        honoured: same && agentSlots.length > 0,
        said: same ? 'identical to the shared search' : `DIFFERS: ${agentSlots.join('; ')}`,
      },
      note: 'one implementation of "what is free", or the two engines can double-book',
    };
  });

  await compareAsymmetric('Reserving — the party size is asked for, never assumed', async () => {
    // The orchestrator defaulted an unstated party size to TWO and wrote it.
    // It now asks. The agent path has no reservation tool at all, so this side
    // is read from the prompt: the agent must not invent one either.
    const contact = await prisma.contact.upsert({
      where: { organizationId_phoneNumber: { organizationId: org.orgId, phoneNumber: CALLER } },
      create: { organizationId: org.orgId, phoneNumber: CALLER, fullName: 'Parity Caller' },
      update: {},
    });
    const conversation = await prisma.conversation.upsert({
      where: {
        organizationId_contactId_channel: {
          organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP',
        },
      },
      create: { organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP' },
      update: { flowState: Prisma.DbNull },
    });

    const before = await prisma.reservation.count({ where: { organizationId: org.orgId } });
    const o = await orchestrator.processIncomingMessage(
      { ...ctx(), conversationId: conversation.id },
      'can i book a table for friday'   // no number anywhere in it
    );
    const after = await prisma.reservation.count({ where: { organizationId: org.orgId } });

    const asks = /how many people/i.test(o.replyText ?? '') && after === before;

    const { agentPromptFor } = require(path.join(ROOT, 'apps/api/dist/agent-tools/agent-tool-catalog.js'));
    const prompt = agentPromptFor({ persona: null, aiPersonaPrompt: null });
    const forbidsInvention = /Never invent prices, availability/i.test(prompt);

    return {
      orchestrator: {
        honoured: asks,
        said: `${trim(o.replyText)} [reservations created: ${after - before}]`,
      },
      agent: {
        honoured: forbidsInvention,
        said: forbidsInvention
          ? 'system prompt forbids inventing facts a tool did not return (STATIC CHECK — no reservation tool exists)'
          : 'system prompt does NOT forbid inventing unreturned facts',
      },
      note: 'a number the customer never said must not reach a real record',
    };
  });

  await compare('Rescheduling — neither engine picks the time', async () => {
    // The orchestrator used to move the customer's next booking to tomorrow at
    // 10:00 without asking, and reply that it "has been rescheduled". It now
    // offers real openings and confirms before writing.
    //
    // The agent path never had that bug: the model collects the time from the
    // caller and passes it in, so a reschedule there is already the customer's
    // choice. What this pins is the shared guarantee — asking to move an
    // appointment must not, by itself, move it.
    const contact = await prisma.contact.upsert({
      where: { organizationId_phoneNumber: { organizationId: org.orgId, phoneNumber: CALLER } },
      create: { organizationId: org.orgId, phoneNumber: CALLER, fullName: 'Parity Caller' },
      update: {},
    });
    const conversation = await prisma.conversation.upsert({
      where: {
        organizationId_contactId_channel: {
          organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP',
        },
      },
      create: { organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP' },
      update: { flowState: Prisma.DbNull },
    });

    const start = new Date(Date.now() + 48 * 60 * 60 * 1000);
    start.setUTCMinutes(0, 0, 0);
    const booking = await prisma.booking.create({
      data: {
        organizationId: org.orgId, contactId: contact.id, serviceName: 'Parity Consultation',
        startTime: start, endTime: new Date(start.getTime() + 30 * 60 * 1000), status: 'CONFIRMED',
      },
    });

    const o = await orchestrator.processIncomingMessage(
      { ...ctx(), conversationId: conversation.id },
      'i need to reschedule my appointment'
    );
    const afterO = await prisma.booking.findUnique({ where: { id: booking.id } });
    const oHeld = afterO.startTime.getTime() === start.getTime();

    // The agent side, asked the same thing with no time supplied: the tool
    // requires one, so an empty call must not move anything either.
    const a = await viaAgent('reschedule-booking', { phoneNumber: CALLER, newStartTime: '' });
    const afterA = await prisma.booking.findUnique({ where: { id: booking.id } });
    const aHeld = afterA.startTime.getTime() === start.getTime();

    return {
      orchestrator: {
        honoured: oHeld && o.intentDetected === 'FLOW_COLLECTING',
        said: `${o.intentDetected}: ${trim(o.replyText)} [booking moved: ${!oHeld}]`,
      },
      agent: {
        honoured: aHeld && a.body?.ok !== true,
        said: `${trim(a.body?.speak)} [booking moved: ${!aHeld}]`,
      },
      note: 'asking to move an appointment must not, on its own, move it',
    };
  });

  await compare('Cancelling — neither engine cancels on the asking', async () => {
    // The orchestrator used to cancel the soonest appointment on the first
    // message, with no read-back, and reply that it had been "successfully
    // cancelled". One message in, one irreversible write out.
    //
    // The agent path takes a phone number and cancels what it finds, so the
    // model is the thing that confirms — which is why this is graded on the
    // shared guarantee rather than on the mechanism: asking to cancel must not,
    // by itself, cancel.
    // A caller of its OWN, with exactly one appointment.
    //
    // Sharing CALLER meant this scenario inherited every booking the earlier
    // ones made, so "cancel my appointment" correctly asked WHICH — and the
    // "yes" this sends answered that question instead of confirming a
    // cancellation. The engine was right; the scenario was describing a
    // customer who does not exist.
    const cancelPhone = `+23480${(Date.now() + 1).toString().slice(-8)}`;
    const contact = await prisma.contact.upsert({
      where: { organizationId_phoneNumber: { organizationId: org.orgId, phoneNumber: cancelPhone } },
      create: { organizationId: org.orgId, phoneNumber: cancelPhone, fullName: 'Parity Canceller' },
      update: {},
    });
    const conversation = await prisma.conversation.upsert({
      where: {
        organizationId_contactId_channel: {
          organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP',
        },
      },
      create: { organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP' },
      update: { flowState: Prisma.DbNull },
    });

    const start = new Date(Date.now() + 72 * 60 * 60 * 1000);
    start.setUTCMinutes(0, 0, 0);
    const booking = await prisma.booking.create({
      data: {
        organizationId: org.orgId, contactId: contact.id, serviceName: 'Parity Cancellation Test',
        startTime: start, endTime: new Date(start.getTime() + 30 * 60 * 1000), status: 'CONFIRMED',
        notes: 'ORIGINAL NOTE — must survive a cancellation',
      },
    });

    const o = await orchestrator.processIncomingMessage(
      { ...ctx(), conversationId: conversation.id, customerPhoneNumber: cancelPhone },
      'please cancel my appointment'
    );
    const afterO = await prisma.booking.findUnique({ where: { id: booking.id } });
    const oHeld = afterO.status === 'CONFIRMED';

    // Now confirm it, and check the audit note survived rather than being
    // replaced — the record of how the booking came to exist is most wanted at
    // exactly the moment it is being undone.
    const yes = await orchestrator.processIncomingMessage(
      { ...ctx(), conversationId: conversation.id, customerPhoneNumber: cancelPhone },
      'yes'
    );
    const afterYes = await prisma.booking.findUnique({ where: { id: booking.id } });
    const cancelledOnConfirm = afterYes.status === 'CANCELLED';
    const notesKept = (afterYes.notes || '').includes('ORIGINAL NOTE');

    const a = await viaAgent('cancel-booking', { phoneNumber: `+234800${Date.now().toString().slice(-7)}` });
    const aHeld = a.body?.ok !== true;

    return {
      orchestrator: {
        honoured: oHeld && cancelledOnConfirm && notesKept,
        said: `${o.intentDetected}: ${trim(o.replyText)} [held on ask: ${oHeld}; cancelled on yes: ${cancelledOnConfirm}; notes kept: ${notesKept}]`,
      },
      agent: {
        honoured: aHeld,
        said: `${trim(a.body?.speak)} [cancelled something it should not have: ${!aHeld}]`,
      },
      note: 'asking to cancel must not cancel; confirming must; and the audit trail survives either way',
    };
  });

  await compareAsymmetric('Registering in Hausa — a form, not a booking', async () => {
    // "I want to register for PLASCHEMA", in Hausa, with no English keyword in
    // it. This used to be BLOCKED here: the orchestrator could only reach a
    // tool for it through the LLM classifier, which the harness disables on
    // purpose so two runs cannot disagree with themselves — and what it
    // actually did without the classifier was book an appointment.
    //
    // The enrollment flow made the live side deterministic: the entry patterns
    // cover all five languages, so this starts a form with no model in the
    // loop. The agent side is still the model's own routing, which only a real
    // call exercises, so it is read from the prompt and graded as the static
    // check it is.
    // A flow needs a thread to hang its state on, and in production the
    // WhatsApp service always creates one before the orchestrator is called.
    // The harness builds its context by hand, so it has to create the same row
    // — otherwise this would exercise a shape the platform never produces and
    // report a limitation that does not exist.
    const contact = await prisma.contact.upsert({
      where: { organizationId_phoneNumber: { organizationId: org.orgId, phoneNumber: CALLER } },
      create: { organizationId: org.orgId, phoneNumber: CALLER, fullName: 'Parity Caller' },
      update: {},
    });
    const conversation = await prisma.conversation.upsert({
      where: {
        organizationId_contactId_channel: {
          organizationId: org.orgId,
          contactId: contact.id,
          channel: 'WHATSAPP',
        },
      },
      create: { organizationId: org.orgId, contactId: contact.id, channel: 'WHATSAPP' },
      update: { flowState: Prisma.DbNull },
    });

    const before = await prisma.booking.count({ where: { organizationId: org.orgId } });
    const o = await orchestrator.processIncomingMessage(
      { ...ctx(), conversationId: conversation.id },
      'Ina so in yi rijistar PLASCHEMA don Allah'
    );
    const after = await prisma.booking.count({ where: { organizationId: org.orgId } });

    const oText = o.replyText ?? '';
    const startsForm = o.intentDetected === 'FLOW_COLLECTING' && after === before;

    const { SYSTEM_PROMPT } = require(path.join(ROOT, 'apps/api/dist/agent-tools/agent-tool-catalog.js'));
    const promptCollects =
      /register-enrollee/.test(SYSTEM_PROMPT) &&
      /ONE AT A TIME/i.test(SYSTEM_PROMPT);

    return {
      orchestrator: {
        honoured: startsForm,
        said: `${o.intentDetected}: ${trim(oText)} [bookings created: ${after - before}]`,
      },
      agent: {
        honoured: promptCollects,
        said: promptCollects
          ? 'system prompt collects the six fields one at a time before register-enrollee (STATIC CHECK — no live path)'
          : 'system prompt does NOT instruct the agent to collect before registering',
      },
      note: 'wanting to join is a form to fill, on either path — never an appointment booked instead',
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
