/**
 * Does the REAL model, with the call's REAL prompt and tools, do what the
 * script says? Run on the server, where the model key is:
 *
 *   node apps/api/dist/voice-local/conversation-check.js <agency-slug> [runs]
 *
 * Read-only: tools are stand-ins that record what the model asked for and
 * answer like the real ones; nothing is written to the database and no call
 * is placed. The prompt and opening come from call-setup.ts, the same module a
 * live call uses, so what passes here is what a caller gets.
 *
 * Each scenario is a call reported from the live line:
 *   - a returning caller corrects their location: it must be SAVED as soon as
 *     it is confirmed (it used to be held for one save at the end, lost when
 *     the call ended, and asked again on the next call);
 *   - a returning caller whose profile is complete: no profile question again;
 *   - a new caller: each detail saved as it is confirmed, never asked twice.
 */
import { TEAM_PERSONAS, type AgentOrganization, type TeamPersona } from '../agent-tools/agent-tool-catalog';
import { callOpening, callSystemPrompt, type CallVariables } from './call-setup';
import { streamChat, type ChatMessage, type ToolCall } from './llm';
import { localToolDefinitions } from './voice-tools';
import { plain } from './voice-session';

export interface Turn {
  caller: string;
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
const claimsSave = /\b(updated|saved|noted (it|that|your)|registered your|recorded your)\b/i;

/** Problems common to every scenario. */
function commonProblems(turns: Turn[]): string[] {
  const out: string[] = [];
  turns.forEach((t, i) => {
    const text = t.replies.join(' ');
    const savedNow = t.calls.some((c) => c.name === 'update-caller-profile');
    if (claimsSave.test(text) && !savedNow && !t.calls.length) out.push(`turn ${i + 1}: says it saved/updated something but called no tool: "${text}"`);
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
        if (!saved(turns, 1, 'community', /rant/i) && !saved(turns, 1, 'ward', /rant/i)) p.push('the corrected location (Rantya) was not saved by the time the caller confirmed it');
        turns.forEach((t, i) => t.replies.forEach((r) => asks(r, /your (full )?name/i) && p.push(`turn ${i + 1}: asked a returning caller's name: "${r}"`)));
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

/** One scripted call against the real model. */
export async function runScenario(
  org: AgentOrganization & { timezone?: string | null },
  persona: TeamPersona,
  sc: Scenario,
  llm: typeof streamChat = streamChat,
): Promise<Turn[]> {
  const now = new Date();
  const tools = localToolDefinitions();
  const messages: ChatMessage[] = [
    { role: 'system', content: callSystemPrompt(org, persona, sc.vars, now) },
    { role: 'assistant', content: plain(callOpening(org, persona, sc.vars, now)) },
  ];
  const turns: Turn[] = [];
  for (const line of sc.lines) {
    const turn: Turn = { caller: line, replies: [], calls: [] };
    messages.push({ role: 'user', content: line });
    for (let round = 0; round < 6; round++) {
      let text = '';
      let calls: ToolCall[] = [];
      for await (const ev of llm(messages, tools, AbortSignal.timeout(30_000))) {
        if (ev.type === 'text') text += ev.delta;
        else calls = ev.calls;
      }
      if (text.trim()) turn.replies.push(text.trim());
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) break;
      for (const c of calls) {
        let args: Record<string, any> = {};
        try {
          args = JSON.parse(c.function.arguments || '{}');
        } catch {
          /* recorded as empty */
        }
        turn.calls.push({ name: c.function.name, args });
        const result =
          c.function.name === 'lookup-customer'
            ? sc.lookup
            : c.function.name === 'update-caller-profile'
              ? { ok: true, data: { saved: true, fields: Object.keys(args) } }
              : c.function.name === 'end_call'
                ? { ok: true, message: 'The call will end now.' }
                : { ok: true, data: {} };
        messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(result) });
      }
      if (calls.some((c) => c.function.name === 'end_call')) break;
    }
    turns.push(turn);
  }
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
