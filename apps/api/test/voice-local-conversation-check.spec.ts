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

describe('conversation check: the checker itself', () => {
  it('passes a model that saves a confirmed correction at once', async () => {
    const good = model((said) =>
      /^No\./.test(said)
        ? [{ type: 'text', delta: 'Just to confirm, Rantya in Rantya ward, Jos North?' }]
        : /correct/.test(said)
          ? [call('update-caller-profile', { community: 'Rantya', ward: 'Rantya', lga: 'Jos North' })]
          : [{ type: 'text', delta: 'How may the Plateau State Government assist you today?' }],
    );
    const turns = await runScenario(org, persona, correction, good as any);
    expect(correction.check(turns)).toEqual([]);
  });

  it('fails a model that says it will update but saves nothing (what the live line did)', async () => {
    const bad = model(() => [{ type: 'text', delta: 'Thank you for that correction, Steven. Let me update that information for you. May we use this number?' }]);
    const problems = correction.check(await runScenario(org, persona, correction, bad as any));
    expect(problems.join('\n')).toMatch(/not saved by the time the caller confirmed/);
  });

  it('fails a model that re-asks a complete returning caller for details on file', async () => {
    const reasks = model(() => [{ type: 'text', delta: 'Great. Could you tell me your ward and community?' }]);
    expect(complete.check(await runScenario(org, persona, complete, reasks as any)).join('\n')).toMatch(/already on file/);
    const fine = model(() => [{ type: 'text', delta: 'Thank you, Steven. How may the Plateau State Government assist you today?' }]);
    expect(complete.check(await runScenario(org, persona, complete, fine as any))).toEqual([]);
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
    const problems = newCaller.check(await runScenario(org, persona, newCaller, late as any)).join('\n');
    expect(problems).toMatch(/confirmed name was not saved/);
    expect(problems).toMatch(/asked the name again/);
  });

  it('sends the model the same prompt a live call sends, with this call\'s values after it', async () => {
    let first: ChatMessage[] = [];
    const spy = async function* (messages: ChatMessage[]): AsyncGenerator<LlmEvent> {
      if (!first.length) first = messages.map((m) => ({ ...m })) as ChatMessage[];
      yield { type: 'text', delta: 'How may I help?' };
    };
    await runScenario(org, persona, complete, spy as any);
    expect(String(first[0].content)).toContain('{{representative_name}}');
    expect(String(first[0].content)).toMatch(/- \{\{sip_callername\}\} = "Steven"/);
    expect(String(first[0].content)).toMatch(/Save each detail the caller confirms with update-caller-profile straight away/);
    expect(String(first[1].content)).toMatch(/^Good (morning|afternoon|evening), and welcome/);
  });
});
