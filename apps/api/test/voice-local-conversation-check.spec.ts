/**
 * The conversation check runs against the real model on the server. These
 * tests prove the CHECKER: a model that behaves passes, and one that behaves
 * the way the live line did (holding the save for later, claiming an update it
 * did not make, re-asking what it was told) is caught, with the reason.
 */
import { TEAM_PERSONAS } from '../src/agent-tools/agent-tool-catalog';
import { runScenario, scenarios } from '../src/voice-local/conversation-check';
import type { ChatMessage, LlmEvent } from '../src/voice-local/llm';

const org: any = {
  name: 'Plateau State Government Citizen Contact Centre',
  slug: 'plaschema',
  timezone: 'Africa/Lagos',
  welcomeMessage: '<governor>{greeting}, and welcome. Our virtual assistant, {name}, will help you now.</governor> <break time="1.0s" /> I\'m {name}, the virtual assistant. How may I help you today?',
};
const persona = { ...TEAM_PERSONAS.nanpan, id: 'gwaman', name: 'Gwaman', greetingPhrase: 'my name is Gwaman' };
const [correction, complete, newCaller] = scenarios(org);

/** A scripted model: given the history, what it says and which tools it calls. */
const model = (decide: (last: string, msgs: ChatMessage[]) => LlmEvent[]) =>
  async function* (messages: ChatMessage[]): AsyncGenerator<LlmEvent> {
    const last = messages[messages.length - 1];
    if (last.role === 'tool') return void (yield { type: 'text', delta: 'Thank you.' });
    for (const e of decide(String(last.content), messages)) yield e;
  };
const call = (name: string, args: object): LlmEvent => ({ type: 'tool_calls', calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

jest.setTimeout(60_000);

describe('conversation check: the checker itself', () => {
  it('passes a model that saves a confirmed correction at once', async () => {
    const good = model((said) =>
      /^No\./.test(said)
        ? [{ type: 'text', delta: 'Just to confirm, Rantya in Rantya ward, Jos North?' }]
        : /correct/.test(said)
          ? [call('update-caller-profile', { community: 'Rantya', ward: 'Rantya', lga: 'Jos North' })]
          : [{ type: 'text', delta: 'How may the Plateau State Government assist you today?' }],
    );
    const turns = await runScenario(org, persona, correction, good as any, { settleMs: 300 });
    expect(correction.check(turns)).toEqual([]);
  });

  it('fails a model that says it will update but saves nothing (what the live line did)', async () => {
    const bad = model(() => [{ type: 'text', delta: 'Thank you for that correction, Steven. Let me update that information for you. May we use this number?' }]);
    const problems = correction.check(await runScenario(org, persona, correction, bad as any, { settleMs: 300 }));
    expect(problems.join('\n')).toMatch(/not saved by the time the caller confirmed/);
  });

  it('fails a model that re-asks a complete returning caller for details on file', async () => {
    const reasks = model(() => [{ type: 'text', delta: 'Great. Could you tell me your ward and community?' }]);
    expect(complete.check(await runScenario(org, persona, complete, reasks as any, { settleMs: 300 })).join('\n')).toMatch(/already on file/);
    const fine = model(() => [{ type: 'text', delta: 'Thank you, Steven. How may the Plateau State Government assist you today?' }]);
    expect(complete.check(await runScenario(org, persona, complete, fine as any, { settleMs: 300 }))).toEqual([]);
  });

  it('fails a model that keeps a new caller\'s name until the end, or asks it twice', async () => {
    const late = model((said) =>
      /Joy Sunday/.test(said)
        ? [{ type: 'text', delta: 'Is your name Joy Sunday?' }]
        : /Jos South/.test(said)
          ? [{ type: 'text', delta: 'Jos South, correct? And may I have your name again?' }]
          : said === 'Yes.'
            ? [call('update-caller-profile', { fullName: 'Joy Sunday', lga: 'Jos South' })]
            : [{ type: 'text', delta: 'I am sorry to hear that. May I have your full name?' }],
    );
    const problems = newCaller.check(await runScenario(org, persona, newCaller, late as any, { settleMs: 300 })).join('\n');
    expect(problems).toMatch(/confirmed name was not saved/);
    expect(problems).toMatch(/asked the name again/);
  });

  it('never lets the caller hear "I\'ve updated your location" unless a save succeeded, and tells the model', async () => {
    // Exactly what the real model did in the first server run.
    const seen: string[] = [];
    let saveOnRetry = false;
    const claims = async function* (messages: ChatMessage[]): AsyncGenerator<LlmEvent> {
      const last = messages[messages.length - 1];
      seen.push(String(last.content));
      if (last.role === 'tool') return void (yield { type: 'text', delta: "Thank you, Steven. I've updated your location to Rantya." });
      if (/^\[Note from the system/.test(String(last.content)) && saveOnRetry) {
        return void (yield call('update-caller-profile', { community: 'Rantya', ward: 'Rantya' }));
      }
      yield { type: 'text', delta: 'Thank you for that correction, Steven. Let me update that information for you. ' };
      yield { type: 'text', delta: "Hold on a moment while I save that. I've updated your location. Are you comfortable with us using this number?" };
    };
    // 1. The model never saves: the claims are never heard; the model was told.
    let turns = await runScenario(org, persona, { ...correction, lines: [correction.lines[0]] }, claims as any, { settleMs: 300 });
    const heard = turns[0].replies.join(' ');
    expect(heard).not.toMatch(/update|save/i);
    expect(heard).toMatch(/Thank you for that correction/);
    expect(seen.some((c) => /^\[Note from the system/.test(c))).toBe(true);
    // 2. Told, it saves: the claim is then heard, after the write that makes it true.
    seen.length = 0;
    saveOnRetry = true;
    turns = await runScenario(org, persona, { ...correction, lines: [correction.lines[0]] }, claims as any, { settleMs: 300 });
    expect(turns[0].calls.map((c) => c.name)).toEqual(['update-caller-profile']);
    expect(turns[0].replies.join(' ')).toMatch(/I've updated your location to Rantya/);
    expect(correction.check(turns).filter((p) => /hears that something was saved/.test(p))).toEqual([]);
  }, 30_000);

  it('sends the model the same prompt a live call sends, with this call\'s values after it', async () => {
    let first: ChatMessage[] = [];
    const spy = async function* (messages: ChatMessage[]): AsyncGenerator<LlmEvent> {
      if (!first.length) first = messages.map((m) => ({ ...m })) as ChatMessage[];
      yield { type: 'text', delta: 'How may I help?' };
    };
    await runScenario(org, persona, complete, spy as any, { settleMs: 300 });
    expect(String(first[0].content)).toContain('{{representative_name}}');
    expect(String(first[0].content)).toMatch(/- \{\{sip_callername\}\} = "Steven"/);
    expect(String(first[0].content)).toMatch(/Save each detail the caller confirms with update-caller-profile straight away/);
    expect(String(first[1].content)).toMatch(/^Good (morning|afternoon|evening), and welcome/);
  });
});
