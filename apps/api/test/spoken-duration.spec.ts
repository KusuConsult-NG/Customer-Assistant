/**
 * Every long thing the phone agent says must finish before the line hangs up.
 *
 * ElevenLabs ends a call `silenceEndCallTimeout` seconds after the CALLER last
 * spoke; the agent's own speech does not reset it. At 10 seconds it cut the
 * agent off mid-sentence on every long turn and calls dropped. The test that
 * existed then checked that the timeout WAS 10 — it passed, because 10 was what
 * someone had chosen.
 *
 * So this checks the RELATIONSHIP instead. Each scripted turn is spoken at the
 * configured voice speed (a conservative estimate, slower than real), and the
 * timeout must cover the longest one plus a tool call plus time for the caller
 * to answer. Lengthening the script, slowing the voice, or shortening the
 * timeout each fail here — before a citizen hears it.
 */
import { agentPromptFor, AgentOrganization, firstMessageFor } from '../src/agent-tools/agent-tool-catalog';
import { SILENCE_END_CALL_TIMEOUT_SECONDS, VOICE_SETTINGS } from '../src/agent-tools/elevenlabs-contracts';
import {
  estimateSpokenSeconds,
  IncidentKind,
  reportRegisteredReply,
  urgentReportReply,
} from '../src/agent-tools/spoken-replies';

const PLATEAU: AgentOrganization = {
  name: 'Plateau State Government Citizen Contact Centre',
  slug: 'plateau-state',
  timezone: 'Africa/Lagos',
  welcomeMessage: null,
  aiPersonaPrompt: null,
};

/** A long real name and a full-length reference, so every estimate is the long case. */
const NAME = 'Christopher Dakwoyel';
const REFERENCE = 'TCK-2026-000123';

/** create-ticket is a database write and a classification before the agent speaks. */
const TOOL_CALL_SECONDS = 10;
/** After the agent's question, the caller needs time to think and answer. */
const CALLER_ANSWER_SECONDS = 15;
/**
 * For the urgent reply the agent is TOLD to add to it — explain which agency
 * does what and reassure the caller — so the scripted words are not the whole
 * turn. Half again on top is the allowance for that.
 */
const MODEL_ELABORATION = 1.5;

const speed = VOICE_SETTINGS.speed;

/** Fill the script's placeholders with long real values. */
const fill = (s: string) =>
  s.replace(/\[REFERENCE NUMBER\]/g, REFERENCE).replace(/\[Caller's Name\]/g, NAME);

/**
 * Every line the prompt tells the agent to say word for word: `say: "…"`.
 * Anchored on "say" rather than on any pair of quotes, because the prompt also
 * quotes single words in prose and pairing those produces fragments that are
 * nothing the agent says.
 */
function scriptedLines(): string[] {
  const prompt = agentPromptFor(PLATEAU);
  return [...prompt.matchAll(/\b[Ss]ay(?:s)?(?: exactly)?:?\s*"([^"\n]{40,})"/g)].map((m) => fill(m[1]));
}

interface Turn {
  what: string;
  seconds: number;
  /** Whether a tool call sat between the caller's last word and this turn. */
  afterTool: boolean;
}

function turns(): Turn[] {
  const out: Turn[] = [
    {
      what: 'create-ticket: report registered (Phase 8 + Phase 10)',
      seconds: estimateSpokenSeconds(reportRegisteredReply(REFERENCE, NAME), speed),
      afterTool: true,
    },
    ...(['security', 'fire', 'disaster', 'medical'] as IncidentKind[]).map((kind) => ({
      what: `create-ticket: urgent ${kind} report`,
      seconds: estimateSpokenSeconds(urgentReportReply(REFERENCE, kind), speed) * MODEL_ELABORATION,
      afterTool: true,
    })),
    {
      what: 'opening greeting (Governor, pause, assistant)',
      seconds: estimateSpokenSeconds(firstMessageFor(PLATEAU), speed),
      afterTool: false,
    },
  ];
  for (const line of scriptedLines()) {
    out.push({ what: `prompt: "${line.slice(0, 50)}…"`, seconds: estimateSpokenSeconds(line, speed), afterTool: false });
  }
  return out;
}

const needed = (t: Turn) => t.seconds + (t.afterTool ? TOOL_CALL_SECONDS : 0) + CALLER_ANSWER_SECONDS;

describe('The silence timeout outlasts everything the agent says', () => {
  it('finds the scripted lines it is meant to measure', () => {
    // A pattern that matched nothing would pass every check below.
    const lines = scriptedLines();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.some((l) => l.startsWith('Once again, thank you'))).toBe(true);
  });

  it('measures the way the agent reads: digit by digit, reference by character', () => {
    // "0 8 0 3" is four characters; TCK000123 is read one character at a time.
    expect(estimateSpokenSeconds('0 8 0 3', 1)).toBeCloseTo(4 / 2.5, 5);
    expect(estimateSpokenSeconds('TCK000123', 1)).toBeCloseTo(9 / 2.5, 5);
    // A slower voice takes longer to say the same thing.
    expect(estimateSpokenSeconds('one two three four', 0.9)).toBeGreaterThan(estimateSpokenSeconds('one two three four', 1));
    // A break is heard; a voice tag is not.
    expect(estimateSpokenSeconds('<governor>Hello</governor> <break time="1.0s" /> Hi', 1)).toBeCloseTo(2 / 2.3 + 1, 5);
  });

  it(`covers the longest turn at speed ${speed}, with a tool call and the caller's answer`, () => {
    const all = turns();
    const longest = all.reduce((a, b) => (needed(b) > needed(a) ? b : a));
    const report = all
      .map((t) => `${needed(t).toFixed(0).padStart(4)}s needed  ${t.seconds.toFixed(0).padStart(3)}s spoken  ${t.what}`)
      .join('\n');
    if (needed(longest) > SILENCE_END_CALL_TIMEOUT_SECONDS) {
      throw new Error(
        `The line would hang up on callers. SILENCE_END_CALL_TIMEOUT_SECONDS is ${SILENCE_END_CALL_TIMEOUT_SECONDS}, ` +
          `but "${longest.what}" needs ${needed(longest).toFixed(0)}s at speed ${speed}. ` +
          `Raise the timeout, or shorten what the agent says.\n${report}`
      );
    }
  });

  it('would have failed with the 10-second timeout that dropped calls', () => {
    const longest = Math.max(...turns().map(needed));
    expect(longest).toBeGreaterThan(10);
  });
});
