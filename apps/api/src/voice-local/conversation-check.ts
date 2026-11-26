/**
 * Does the REAL model, with the call's REAL prompt and tools, do what the
 * script says? Run on the server, where the model key is:
 *
 *   node apps/api/dist/voice-local/conversation-check.js <agency-slug> [runs]
 *
 * Read-only: tools are stand-ins that record what the model asked for and
 * answer like the real ones; nothing is written to the database and no call
 * is placed. Each scenario is driven through the REAL VoiceSession — the same
 * turn-taking, the same hold on unbacked "I've saved it" claims, the same
 * speech filter — with the prompt and opening from call-setup.ts, the module a
 * live call uses. What is checked is what a caller would HEAR.
 *
 * Each scenario is a call reported from the live line:
 *   - a returning caller corrects their location: the WHOLE new location is
 *     read back first, and saved as soon as they confirm it (it used to be
 *     held for one save at the end, lost when the call ended, and asked again
 *     on the next call; then saved unconfirmed, keeping a ward never said);
 *   - the same, when only part of the place is given and it is misheard
 *     ("Gyel B" heard as "Galby"): nothing is saved before a read-back;
 *   - a returning caller whose profile is complete: no profile question again;
 *   - a new caller: each detail saved as it is confirmed, never asked twice.
 */
import { TEAM_PERSONAS, type AgentOrganization, type TeamPersona } from '../agent-tools/agent-tool-catalog';
import { callOpening, callSystemPrompt, type CallVariables } from './call-setup';
import { streamChat } from './llm';
import type { SttEvents } from './stt';
import { CachedSpeech, type SpeechEngine } from './tts';
import { localToolDefinitions } from './voice-tools';
import { ACKS, HOLDING_LINE, VoiceSession, WRITE_TOOLS } from './voice-session';

export interface Turn {
  caller: string;
  /** What the caller would hear, sentence by sentence. */
  replies: string[];
  calls: Array<{ name: string; args: Record<string, any> }>;
}

export interface Scenario {
  name: string;
  vars: CallVariables;
  lookup: Record<string, unknown>;
  lines: string[];
  /** Problems found, or none. */
  check(turns: Turn[]): string[];
}

const saved = (turns: Turn[], upTo: number, field: string, re: RegExp) =>
  turns.slice(0, upTo + 1).some((t) => t.calls.some((c) => c.name === 'update-caller-profile' && re.test(String(c.args[field] ?? ''))));
const asks = (text: string, re: RegExp) => /\?/.test(text) && re.test(text);
/** A location change saved in turns up to `upTo` WITHOUT the caller's yes to a read-back. */
const savedUnconfirmed = (turns: Turn[], upTo: number) =>
  turns
    .slice(0, upTo + 1)
    .some((t) => t.calls.some((c) => c.name === 'update-caller-profile' && (c.args.community || c.args.ward || c.args.lga) && !/^(true|yes)$/i.test(String(c.args.locationConfirmed))));
const claimsSave = /\b(updated|saved|noted (it|that|your)|registered your|recorded your)\b/i;

/** Problems common to every scenario, in what the caller would hear. */
function commonProblems(turns: Turn[]): string[] {
  const out: string[] = [];
  turns.forEach((t, i) => {
    const text = t.replies.join(' ');
    const wrote = t.calls.some((c) => WRITE_TOOLS.has(c.name));
    if (claimsSave.test(text) && !wrote) out.push(`turn ${i + 1}: the caller hears that something was saved, but nothing was: "${text}"`);
    if (/\[[^\]]+\]|\{\{/.test(text)) out.push(`turn ${i + 1}: stage direction or placeholder in speech: "${text}"`);
  });
  return out;
}

export function scenarios(org: { name: string }): Scenario[] {
  const base = { representative_name: 'Gwaman', organization_name: org.name };
  return [
    {
      name: 'returning caller corrects their location',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Kabong; community: Rockhaven; follow-up number: not yet agreed',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rockhaven, Kabong ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Kabong', community: 'Rockhaven', phoneConfirmedForFollowUp: null } },
      lines: ["No. I'm now calling from Rantya, Rantya ward, still in Jos North.", "Yes, that's correct.", 'Yes, you can use this number.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const first = turns[0].replies.join(' ');
        if (!(asks(first, /rant/i) && /jos north/i.test(first))) p.push(`the new location was not read back in full before saving: "${first}"`);
        if (turns[0].calls.some((c) => c.name === 'update-caller-profile' && /^(true|yes)$/i.test(String(c.args.locationConfirmed)))) {
          p.push('saved the new location as confirmed before the caller had heard it read back');
        }
        if (!saved(turns, 1, 'community', /rant/i) && !saved(turns, 1, 'ward', /rant/i)) p.push('the corrected location (Rantya) was not saved by the time the caller confirmed it');
        turns.forEach((t, i) => t.replies.forEach((r) => asks(r, /your (full )?name/i) && p.push(`turn ${i + 1}: asked a returning caller's name: "${r}"`)));
        return p;
      },
    },
    {
      name: 'returning caller gives only part of a new place, misheard',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos South; ward: Kabong; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Kabong ward, Jos South?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos South', ward: 'Kabong', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      // What the live line heard on 26 Nov 2026 when the caller said "Gyel B".
      lines: ["Okay. No. I'm not in Kabong. I am in Galby."],
      check: (turns) => {
        const p = commonProblems(turns);
        const text = turns[0].replies.join(' ');
        if (savedUnconfirmed(turns, 0) || turns[0].calls.some((c) => c.name === 'update-caller-profile' && /^(true|yes)$/i.test(String(c.args.locationConfirmed)))) {
          p.push('saved a changed location before the caller confirmed a read-back');
        }
        if (!/\?/.test(text)) p.push(`did not ask the caller to confirm or clarify the new place: "${text}"`);
        if (/how may|assist you today|reason for your call/i.test(text)) p.push(`moved on to the reason for the call before the location was settled: "${text}"`);
        return p;
      },
    },
    {
      name: 'returning caller with a complete profile',
      vars: {
        ...base,
        sip_callerstatus: 'returning',
        sip_callername: 'Steven',
        sip_callerprofile: 'LGA: Jos North; ward: Rantya; community: Rantya; follow-up number: this number',
        sip_callermissing: 'none',
        sip_welcome: 'Welcome back, Steven. Are you still calling from Rantya, Rantya ward, Jos North?',
      },
      lookup: { ok: true, data: { known: true, name: 'Steven', lga: 'Jos North', ward: 'Rantya', community: 'Rantya', phoneConfirmedForFollowUp: true } },
      lines: ['Yes, I am.'],
      check: (turns) => {
        const p = commonProblems(turns);
        const text = turns[0].replies.join(' ');
        if (asks(text, /\b(name|local government|lga|ward|community|number)\b/i)) p.push(`asked for a detail already on file: "${text}"`);
        if (!/help|assist|reason for your call/i.test(text)) p.push(`did not move on to the caller's reason for calling: "${text}"`);
        return p;
      },
    },
    {
      name: 'new caller gives their details',
      vars: {
        ...base,
        sip_callerstatus: 'new',
        sip_callername: '',
        sip_callerprofile: '',
        sip_callermissing: 'name, LGA, ward, community, follow-up number',
        sip_welcome: 'How may I help you today?',
      },
      lookup: { ok: true, data: { known: false } },
      lines: ['Hello, I want to report a broken borehole in my area.', 'My name is Joy Sunday.', "Yes, that's right.", 'Jos South.', 'Yes.'],
      check: (turns) => {
        const p = commonProblems(turns);
        // The name is confirmed on line 3: saved in that reply, or at the latest the next.
        if (!saved(turns, 3, 'fullName', /joy\s+sunday/i)) p.push('the confirmed name was not saved before the next detail was taken');
        if (!saved(turns, 4, 'lga', /jos\s*south/i)) p.push('the LGA (Jos South) was not saved by the end');
        turns.slice(3).forEach((t, i) => t.replies.forEach((r) => asks(r, /your (full )?name/i) && p.push(`turn ${i + 4}: asked the name again after it was confirmed: "${r}"`)));
        return p;
      },
    },
  ];
}

/** What the stand-in tools answer: shaped like the real ones, writing nothing. */
function standIn(sc: Scenario, name: string, args: Record<string, any>): unknown {
  if (name === 'lookup-customer') return sc.lookup;
  if (name === 'update-caller-profile') {
    // The real tool's rule (AgentToolsService.updateCallerProfile): changing a
    // location on file needs locationConfirmed, else nothing is saved.
    const onFile = (sc.lookup as any)?.data ?? {};
    const differs = (k: string, f: string) => args[k] && onFile[f] && String(args[k]).trim().toLowerCase() !== String(onFile[f]).trim().toLowerCase();
    if ((differs('community', 'community') || differs('ward', 'ward') || differs('lga', 'lga')) && !/^(true|yes)$/i.test(String(args.locationConfirmed))) {
      const loc = [args.community || onFile.community, (args.ward || onFile.ward) && `${args.ward || onFile.ward} ward`, args.lga || onFile.lga].filter(Boolean).join(', ');
      return { ok: false, speak: '', data: { saved: false, locationToConfirm: loc, instruction: `Read this whole location back to the caller and ask if it is correct: "${loc}". Wait for a clear yes, then call update-caller-profile again with locationConfirmed=true. Nothing was saved yet.` } };
    }
    return { ok: true, data: { saved: true, fields: Object.keys(args) } };
  }
  return { ok: true, data: {} };
}

/** Until the session has been quiet (not answering, nothing queued) for `settleMs`. */
async function settle(session: VoiceSession, settleMs: number, maxMs = 90_000): Promise<void> {
  const end = Date.now() + maxMs;
  let quietSince = 0;
  while (Date.now() < end) {
    if (session.busy || session.outcome) quietSince = 0;
    else if (!quietSince) quietSince = Date.now();
    else if (Date.now() - quietSince >= settleMs) return;
    if (session.outcome) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** One scripted call, through the real VoiceSession, against `llm` (the real model by default). */
export async function runScenario(
  org: AgentOrganization & { timezone?: string | null },
  persona: TeamPersona,
  sc: Scenario,
  llm: typeof streamChat = streamChat,
  opts: { settleMs?: number } = {},
): Promise<Turn[]> {
  const now = new Date();
  const heard: string[] = [];
  const calls: Turn['calls'] = [];
  // Speech is "synthesised" as a 20 ms frame, and recorded as heard.
  const engine: SpeechEngine = {
    name: 'conversation-check',
    synthesize: async (text: string) => {
      heard.push(text);
      return Buffer.alloc(320);
    },
  };
  let events: SttEvents | null = null;
  const session = new VoiceSession(
    {
      sendAudio: () => undefined,
      close: () => undefined,
      stt: async (ev) => {
        events = ev;
        return { send: () => undefined, close: () => undefined };
      },
      assistantVoice: new CachedSpeech(engine as any, null),
      governorVoice: null,
      llm: (m, t, s) => llm(m, t, s),
      tools: localToolDefinitions(),
      runTool: async (name, args) => {
        calls.push({ name, args });
        return standIn(sc, name, args);
      },
      log: () => undefined,
    },
    { systemPrompt: callSystemPrompt(org, persona, sc.vars, now), opening: callOpening(org, persona, sc.vars, now), personal: [] },
  );
  const settleMs = opts.settleMs ?? 600;
  await session.start();
  await settle(session, settleMs);
  const notReplies = new Set([...ACKS, HOLDING_LINE]);
  const turns: Turn[] = [];
  for (const line of sc.lines) {
    if (session.outcome) break;
    const h0 = heard.length;
    const c0 = calls.length;
    events!.onFinal(line, true);
    await new Promise((r) => setTimeout(r, 50));
    await settle(session, settleMs);
    turns.push({ caller: line, replies: heard.slice(h0).filter((t) => !notReplies.has(t)), calls: calls.slice(c0) });
  }
  await session.finish('completed');
  return turns;
}

async function main() {
  const slug = process.argv[2];
  const runs = Math.max(1, Number(process.argv[3] || 3));
  if (!slug) {
    console.error('Usage: node apps/api/dist/voice-local/conversation-check.js <agency-slug> [runs]');
    process.exit(2);
  }
  const { prisma } = await import('@ace/database');
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
  });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const persona: TeamPersona = { ...TEAM_PERSONAS.nanpan, id: 'gwaman', name: 'Gwaman', greetingPhrase: 'my name is Gwaman' };
  let failed = 0;
  for (const sc of scenarios(org)) {
    let passes = 0;
    for (let r = 1; r <= runs; r++) {
      const turns = await runScenario(org, persona, sc);
      const problems = sc.check(turns);
      if (!problems.length) passes++;
      console.log(`\n── ${sc.name} — run ${r}: ${problems.length ? 'FAIL' : 'PASS'}`);
      for (const t of turns) {
        console.log(`  CALLER: ${t.caller}`);
        for (const c of t.calls) console.log(`    [tool] ${c.name} ${JSON.stringify(c.args)}`);
        for (const rep of t.replies) console.log(`  AGENT:  ${rep}`);
      }
      for (const p of problems) console.log(`  ✗ ${p}`);
    }
    console.log(`== ${sc.name}: ${passes}/${runs} passed`);
    if (passes < runs) failed++;
  }
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
