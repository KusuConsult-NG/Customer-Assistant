/**
 * What the phone line enforces itself, whatever the model does: a number is
 * read back before it counts as confirmed, a knowledge answer comes with how
 * to speak it, a named LGA is saved, and a reply that has already spoken and
 * saved is not sent to the model a second time (conversation check, 28 Nov 2026).
 */
import type { ChatMessage, LlmEvent, ToolCall } from '../src/voice-local/llm';
import { CachedSpeech } from '../src/voice-local/tts';
import {
  agentWordsBeforeCaller,
  digitsSpoken,
  knowledgeGuidance,
  lgaNamed,
  readBackGuard,
  spellingPatienceMs,
  stillSpelling,
  VoiceSession,
} from '../src/voice-local/voice-session';
import { reviewItems, renderReview, KNOWN_TROUBLE } from '../src/voice-local/pronunciation-review';
import { callSystemPrompt, scriptForCaller } from '../src/voice-local/call-setup';
import { PLATEAU_LGAS } from '@ace/database';

jest.setTimeout(30_000);

const call = (name: string, args: object): LlmEvent => ({
  type: 'tool_calls',
  calls: [{ id: `c${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } } as ToolCall],
});

/** A session with a scripted model (`reply` decides from the history) and a recording tool runner. */
async function session(
  reply: (messages: ChatMessage[]) => LlmEvent[],
  runTool: (name: string, args: Record<string, any>) => any = () => ({ ok: true }),
) {
  let stt: any = null;
  const tools: Array<{ name: string; args: Record<string, any> }> = [];
  const logs: string[] = [];
  let modelCalls = 0;
  const s = new VoiceSession(
    {
      sendAudio: () => undefined,
      close: () => undefined,
      stt: async (ev) => {
        stt = ev;
        return { send: () => undefined, close: () => undefined };
      },
      assistantVoice: new CachedSpeech({ name: 't', synthesize: async () => Buffer.alloc(320) } as any, null),
      governorVoice: null,
      llm: async function* (messages) {
        modelCalls++;
        for (const e of reply(messages)) yield e;
      },
      tools: [],
      runTool: async (name, args) => {
        tools.push({ name, args });
        return runTool(name, args);
      },
      log: (e) => logs.push(e),
    },
    { systemPrompt: 'test', opening: 'Hello.', personal: [] },
  );
  await s.start();
  await new Promise((r) => setTimeout(r, 300));
  const heardBy = () => stt;
  const say = async (line: string) => {
    stt.onFinal(line, true);
    await new Promise((r) => setTimeout(r, 60));
    const until = Date.now() + 5_000;
    while (Date.now() < until && s.busy) await new Promise((r) => setTimeout(r, 20));
  };
  return { s, say, stt: heardBy, tools, logs, messages: () => (s as any).messages as ChatMessage[], modelCalls: () => modelCalls };
}

const last = (m: ChatMessage[]) => m[m.length - 1];
const lastUser = (m: ChatMessage[]) => String([...m].reverse().find((x) => x.role === 'user')?.content ?? '');

describe('helpers', () => {
  it('hears the digits a sentence says, written or in words', () => {
    expect(digitsSpoken('Shall we call you on 0 8 0 3, one two three, four five zero zero?')).toBe('08031234500');
    expect(digitsSpoken('How may I help you today?')).toBe('');
  });

  it("finds the agent's words the caller just answered", () => {
    const m: ChatMessage[] = [
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'Is it 0 8 0 3 1 2 3 4 5 6 7?' },
      { role: 'user', content: 'Yes.' },
      { role: 'assistant', content: null, tool_calls: [] },
    ];
    expect(agentWordsBeforeCaller(m)).toBe('Is it 0 8 0 3 1 2 3 4 5 6 7?');
    expect(agentWordsBeforeCaller([{ role: 'user', content: 'Hi' }])).toBe('');
  });

  it('a callback is booked only after the number was read back and not refused', () => {
    expect(readBackGuard('request-callback', { numberConfirmed: true }, 'Shall we call you on your number?', 'Yes').args.numberConfirmed).toBe(false);
    expect(readBackGuard('request-callback', { numberConfirmed: true }, 'Is it 0 8 0 3 1 2 3 4 5 0 0?', 'Yes, that is right.').note).toBeUndefined();
    expect(readBackGuard('request-callback', { numberConfirmed: true }, 'Is it 0 8 0 3 1 2 3 4 5 0 0?', 'No, it is another one.').args.numberConfirmed).toBe(false);
    expect(readBackGuard('request-callback', { numberConfirmed: false }, '', 'Yes').note).toBeUndefined(); // asking for the number is the first step
  });

  it("a hidden-number caller's number is saved only once they heard it read back; the rest of the save goes ahead", () => {
    const held = readBackGuard('update-caller-profile', { lga: 'Jos South', alternativePhone: '08031234567', alternativePhoneConfirmed: true }, 'Could you give me a number?', 'It is 0803 123 4567.');
    expect(held.args).toEqual({ lga: 'Jos South' });
    expect(held.note).toMatch(/NOT saved.*0 8 0 3 1 2 3 4 5 6 7/);
    const kept = readBackGuard('update-caller-profile', { alternativePhone: '08031234567', alternativePhoneConfirmed: true }, 'Let me read that back: 0803 123 4567. Is that correct?', 'Yes, that is correct.');
    expect(kept.args.alternativePhoneConfirmed).toBe(true);
  });

  it('a location is marked confirmed only after it was read back and not refused (both cheaper models saved it with the read-back)', () => {
    const loc = { community: 'Rantya', ward: 'Rantya', lga: 'Jos North', locationConfirmed: true };
    const early = readBackGuard('update-caller-profile', loc, 'Are you still calling from Kabong, Jos South?', "No. I'm now calling from Rantya, Rantya ward, still in Jos North.");
    expect(early.args).toEqual({ community: 'Rantya', ward: 'Rantya', lga: 'Jos North' }); // the flag goes; the tool then asks for the read-back
    expect(early.note).toMatch(/NOT marked confirmed/);
    const readBack = readBackGuard('update-caller-profile', loc, 'So you are now in Rantya, Rantya ward, Jos North. Is that correct?', "Yes, that's correct.");
    expect(readBack.args).toEqual(loc);
    expect(readBack.note).toBeUndefined();
    expect(readBackGuard('update-caller-profile', loc, 'So you are in Rantya, Rantya ward, Jos North?', 'No, Gyel B.').args.locationConfirmed).toBeUndefined();
  });

  it('a number is never saved unconfirmed, and never one the caller did not hear', () => {
    const g = readBackGuard('update-caller-profile', { lga: 'Jos South', alternativePhone: '08012345678' }, 'Which LGA?', 'Jos South.');
    expect(g.args).toEqual({ lga: 'Jos South' });
    expect(g.note).toMatch(/NOT saved.*0 8 0 1 2 3 4 5 6 7 8/);
  });

  it('a knowledge answer comes with how to speak it: three at a time, or no answer and a callback offer', () => {
    expect(knowledgeGuidance({ ok: true, speak: 'Five events…', data: { found: true } })).toMatch(/more than three.*first three.*whether to continue/);
    expect(knowledgeGuidance({ ok: true, speak: '', data: { found: false } })).toMatch(/do not have that information.*desk officer call them back/);
  });

  it('names the one LGA a caller said, never a guess', () => {
    expect(lgaNamed('Jos South.', PLATEAU_LGAS)).toBe('Jos South');
    expect(lgaNamed("I'm in Bokkos", PLATEAU_LGAS)).toBe('Bokkos');
    expect(lgaNamed('Yes.', PLATEAU_LGAS)).toBeNull();
    expect(lgaNamed('Jos South or Jos North', PLATEAU_LGAS)).toBeNull();
  });
});

describe('the session enforces it', () => {
  it('turns a callback booked without a read-back into the read-back step, then books it after the yes', async () => {
    const t = await session(
      (m) => {
        const l = last(m);
        if (l.role === 'tool') return [{ type: 'text', delta: 'Shall we call you on 0 8 0 3 1 2 3 4 5 0 0? Is that correct?' }];
        const u = lastUser(m);
        if (/callback/.test(u)) return [{ type: 'text', delta: 'Shall we call you on the number you are calling from?' }];
        if (/^Yes please/.test(u)) return [call('request-callback', { reason: 'officer', numberConfirmed: true })];
        if (/^Yes, that is right/.test(u)) return [call('request-callback', { reason: 'officer', numberConfirmed: true })];
        return [{ type: 'text', delta: 'Okay.' }];
      },
      (name, args) => (args.numberConfirmed ? { ok: true, data: { reference: '52719' } } : { ok: false, speak: 'Shall we call you on 0 8 0 3 1 2 3 4 5 0 0?' }),
    );
    await t.say('I want a callback.');
    await t.say('Yes please.');
    await t.say('Yes, that is right.');
    await t.s.finish('completed');
    expect(t.tools.map((c) => c.args.numberConfirmed)).toEqual([false, true]);
    expect(t.logs).toContain('voice_local_readback_required');
    const toolMsg = t.messages().find((x) => x.role === 'tool');
    expect(String((toolMsg as any).content)).toMatch(/Not booked yet/);
  });

  it('tells the model how to speak a knowledge answer', async () => {
    const t = await session(
      (m) => (last(m).role === 'tool' ? [{ type: 'text', delta: 'There are five events. Would you like the first three?' }] : [call('search-knowledge', { query: 'events' })]),
      () => ({ ok: true, speak: 'Five events in December…', data: { found: true } }),
    );
    await t.say('What events are on in December?');
    await t.s.finish('completed');
    const toolMsg = t.messages().find((x) => x.role === 'tool');
    expect(JSON.parse(String((toolMsg as any).content)).howToSpeakIt).toMatch(/first three/);
  });

  it('saves the LGA the caller named when the agent moved on to ward and community without saving it', async () => {
    const t = await session((m) => {
      const u = lastUser(m);
      if (/report/.test(u)) return [{ type: 'text', delta: 'Please, which Local Government Area of Plateau State are you calling from?' }];
      if (/Jos South/.test(u)) return [{ type: 'text', delta: 'Thank you. Could you also tell me your ward and community?' }];
      return [{ type: 'text', delta: 'Okay.' }];
    });
    await t.say('I want to report a broken borehole.');
    await t.say('Jos South.');
    await t.s.finish('completed');
    expect(t.tools).toEqual([{ name: 'update-caller-profile', args: { lga: 'Jos South' } }]);
    expect(t.logs).toContain('voice_local_lga_saved');
  });

  it('does not save an LGA mentioned outside an answer to the LGA question, or one the agent saved itself', async () => {
    const t = await session((m) => {
      const u = lastUser(m);
      if (/Jos South/.test(u)) return [{ type: 'text', delta: 'Which ward is the road in?' }];
      return [{ type: 'text', delta: 'How may I help you today?' }];
    });
    await t.say('Hello.');
    await t.say('The road in Jos South is broken.');
    await t.s.finish('completed');
    expect(t.tools).toEqual([]);
  });

  it('speaks and saves in one trip: no second model request when the reply already asked its question and the save succeeded', async () => {
    const t = await session((m) =>
      last(m).role === 'tool'
        ? [{ type: 'text', delta: 'Thank you.' }]
        : [{ type: 'text', delta: 'Thank you, Joy. Please, which Local Government Area are you calling from?' }, call('update-caller-profile', { fullName: 'Joy Sunday' })],
    );
    await t.say('Yes, that is right.');
    await t.s.finish('completed');
    expect(t.modelCalls()).toBe(1);
    expect(t.logs).toContain('voice_local_second_trip_skipped');
  });

  it('still asks the model again when the save failed, so it can put it right', async () => {
    const t = await session(
      (m) =>
        last(m).role === 'tool'
          ? [{ type: 'text', delta: 'Sorry, could you repeat your ward?' }]
          : [{ type: 'text', delta: 'Thank you. Could you also tell me your community?' }, call('update-caller-profile', { ward: 'X' })],
      () => ({ ok: false, message: 'refused' }),
    );
    await t.say('Gyel B ward.');
    await t.s.finish('completed');
    expect(t.modelCalls()).toBe(2);
    expect(t.logs).not.toContain('voice_local_second_trip_skipped');
  });
});

describe('the script sent per call', () => {
  const org: any = { name: 'Plateau State Government Citizen Contact Centre', slug: 'plateau-state', timezone: 'Africa/Lagos', welcomeMessage: '<governor>x</governor>' };
  const prompt = (status: string) => callSystemPrompt(org, { id: 'x', name: 'Ngozi', gender: 'female' } as any, { sip_callerstatus: status }, new Date('2026-11-28T10:00:00Z'));

  it('carries only the instructions for this kind of caller, and never the rule for calls this line does not place', () => {
    const fresh = prompt('new');
    expect(fresh).toMatch(/NEW OR UNPROFILED CALLER/);
    expect(fresh).not.toMatch(/  - RETURNING CALLER \(status/);
    expect(fresh).not.toMatch(/  - CORRECTIONS: when a returning caller/);
    const back = prompt('returning');
    expect(back).toMatch(/  - RETURNING CALLER \(status/);
    expect(back).toMatch(/  - CORRECTIONS: when a returning caller/);
    expect(back).not.toMatch(/NEW OR UNPROFILED CALLER/);
    const unsure = prompt('unknown');
    for (const rule of [/NEW OR UNPROFILED CALLER/, /  - RETURNING CALLER \(status/, /  - CORRECTIONS:/]) expect(unsure).toMatch(rule);
    for (const p of [fresh, back, unsure]) expect(p).not.toMatch(/WHEN WE CALLED THEM/);
    // Smaller for a known kind of caller; the place-name corrections stay in every one.
    expect(fresh.length).toBeLessThan(unsure.length);
    for (const p of [fresh, back, unsure]) expect(p).toMatch(/Galby/);
    expect(scriptForCaller('a\n- WHEN WE CALLED THEM x\nb', undefined)).toBe('a\nb');
  });

  it('never asks what the caller already said', () => {
    expect(prompt('new')).toMatch(/Never ask a question the caller has already answered in this call/);
  });

  it('asks for the spoken reply in the same response as a save', () => {
    expect(prompt('new')).toMatch(/write your spoken reply \(your thanks and your next question\) in the SAME response as the save, never a save on its own/);
  });
});

describe('spelling patience: a number read out in groups is one answer', () => {
  it('knows when the caller is part-way through a number or a spelling', () => {
    const asked = 'Could you please give me a telephone number we can reach you on?';
    expect(stillSpelling('It is 0803 123', asked)).toBe(true);
    expect(stillSpelling('zero eight zero three', asked)).toBe(true);
    expect(stillSpelling('It is 0803 123 4567', asked)).toBe(false); // a whole number
    expect(stillSpelling('Yes, use that one.', asked)).toBe(false); // words, not a number
    expect(stillSpelling('R A N', 'Could you spell your community for me?')).toBe(true);
    expect(stillSpelling('0803 123', 'How may I help you today?')).toBe(false); // not asked for one
  });

  it('reads LOCAL_VOICE_SPELLING_PATIENCE_MS, 0 to switch it off', () => {
    const saved = process.env.LOCAL_VOICE_SPELLING_PATIENCE_MS;
    try {
      delete process.env.LOCAL_VOICE_SPELLING_PATIENCE_MS;
      expect(spellingPatienceMs()).toBe(2_000);
      process.env.LOCAL_VOICE_SPELLING_PATIENCE_MS = '0';
      expect(spellingPatienceMs()).toBe(0);
      process.env.LOCAL_VOICE_SPELLING_PATIENCE_MS = '9000';
      expect(spellingPatienceMs()).toBe(2_000);
    } finally {
      if (saved === undefined) delete process.env.LOCAL_VOICE_SPELLING_PATIENCE_MS;
      else process.env.LOCAL_VOICE_SPELLING_PATIENCE_MS = saved;
    }
  });

  const asksForNumber = (m: ChatMessage[]) => {
    const u = lastUser(m);
    if (/report/.test(u)) return [{ type: 'text' as const, delta: 'Could you please give me a telephone number we can reach you on?' }];
    return [{ type: 'text' as const, delta: 'Thank you. Let me read that back.' }];
  };

  it('waits through a pause between groups, and answers the whole number', async () => {
    const t = await session(asksForNumber);
    await t.say('I want to report a broken road.');
    const before = t.modelCalls();
    t.stt().onInterim('it is 0803 123');
    t.stt().onFinal('It is 0803 123', true);
    await new Promise((r) => setTimeout(r, 800)); // the caller pauses mid-number
    expect(t.modelCalls()).toBe(before); // not taken as the end
    t.stt().onInterim('4567');
    t.stt().onFinal('4567.', true); // now a whole number: answered at once
    await new Promise((r) => setTimeout(r, 300));
    expect(t.modelCalls()).toBe(before + 1);
    expect(lastUser(t.messages())).toBe('It is 0803 123 4567.');
    await t.s.finish('completed');
  });

  it('a part-number the caller stops at is answered after the patience wait, not lost', async () => {
    const t = await session(asksForNumber);
    await t.say('I want to report a broken road.');
    const before = t.modelCalls();
    const at = Date.now();
    t.stt().onFinal('It is 0803 123', true);
    while (Date.now() - at < 4_000 && t.modelCalls() === before) await new Promise((r) => setTimeout(r, 20));
    expect(t.modelCalls()).toBe(before + 1);
    expect(Date.now() - at).toBeGreaterThanOrEqual(1_800);
    expect(t.logs).toContain('voice_local_spelling_patience');
    await t.s.finish('completed');
  });

  it('the wait restarts when the caller carries on: two seconds after their LAST group, not their first', async () => {
    const t = await session(asksForNumber);
    await t.say('I want to report a broken road.');
    const before = t.modelCalls();
    const at = Date.now();
    t.stt().onFinal('0803', true);
    await new Promise((r) => setTimeout(r, 1_500));
    // More words, with no end-of-turn signal from recognition yet: the wait must still restart.
    t.stt().onInterim('123');
    t.stt().onFinal('123', false);
    while (Date.now() - at < 6_000 && t.modelCalls() === before) await new Promise((r) => setTimeout(r, 20));
    expect(Date.now() - at).toBeGreaterThanOrEqual(3_300);
    expect(lastUser(t.messages())).toBe('0803 123');
    await t.s.finish('completed');
  });

  it('no patience when no number was asked for: the turn ends as usual', async () => {
    const t = await session((m) => [{ type: 'text', delta: /report/.test(lastUser(m)) ? 'How may I help you today?' : 'Okay.' }]);
    await t.say('I want to report a broken road.');
    const before = t.modelCalls();
    t.stt().onFinal('0803 123', true);
    await new Promise((r) => setTimeout(r, 300));
    expect(t.modelCalls()).toBe(before + 1);
    await t.s.finish('completed');
  });
});

describe('pronunciation review: the old dictionary, heard in the line\'s own voice', () => {
  it('lists every dictionary word and the known trouble words, without those already respelled', () => {
    const items = reviewItems(
      [
        { words: ['Mutfwang'], alias: 'Moot-fwang' },
        { words: ['Nanpan'], phoneme: 'nanpan', alphabet: 'ipa' },
        { words: ['Plateau'], alias: 'Plah-toh' },
      ],
      [{ written: 'Plateau' }],
    );
    expect(items.map((i) => i.word)).toEqual(['Mutfwang', 'Nanpan', ...KNOWN_TROUBLE.map((k) => k.word)]);
    expect(items[0]).toMatchObject({ spellings: ['Moot-fwang'], oldRule: 'said "Moot-fwang"' });
    expect(items[1]).toMatchObject({ spellings: [], oldRule: 'ipa /nanpan/' }); // heard as written; the listener says if it is wrong
    expect(items.find((i) => i.word === 'ward')!.sentence).toContain('{word} and community');
  });

  it('renders each take in each voice, numbered so a choice can be given back, and keeps going past a failure', async () => {
    const said: string[] = [];
    const engine = { name: 'spitch', synthesize: async (t: string) => { said.push(t); if (/wod/.test(t)) throw new Error('refused'); return Buffer.alloc(320); } } as any;
    const review = await renderReview(reviewItems([], []), [{ name: 'lucy', engine }], {
      upload: async (name) => name,
      link: async (p) => `https://x.test/${p}`,
    });
    expect(review[0].word).toBe('ward');
    expect(review[0].takes.map((t) => t.id)).toEqual(['1a', '1b', '1c', '1d']);
    expect(said[0]).toBe('Could you also tell me your ward and community?');
    expect(review[0].takes[3]).toMatchObject({ label: 'spelled: wod', failed: 'refused' });
    expect(review[0].takes[1].link).toMatch(/^https:\/\/x\.test\//);
  });
});
