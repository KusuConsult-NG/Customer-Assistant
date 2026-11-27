/**
 * The local line's conversation flow, as fixed on 27 Nov 2026 after the move
 * off ElevenLabs left the agent sounding slow and unintelligent:
 *
 *   - its instructions contradicted each other (read the name back / thank
 *     and move on; never say "let me check" / the persona's "Let me check
 *     that for you right now"; 35–55 words / complete answers), and the model
 *     picked a different side on different calls;
 *   - it was told to look every caller up on the first turn although the line
 *     had already looked them up — silence after the caller's first "hello";
 *   - the contact centre's model was given booking, payment and enrolment tools
 *     and instructions it has no use for;
 *   - sentences ran into each other 0.16 s apart, and long sentences went to
 *     the voice whole;
 *   - words the ElevenLabs dictionary said right had no way to be fixed.
 */
import { agentPromptFor, CONTACT_CENTRE_TOOLS, SYSTEM_PROMPT } from '../src/agent-tools/agent-tool-catalog';
import { callSystemPrompt } from '../src/voice-local/call-setup';
import { voiceModel } from '../src/voice-local/llm';
import { parsePls } from '../src/voice-local/pronunciations-export';
import { pronounced, PRONUNCIATIONS, pronunciationsFromEnv } from '../src/voice-local/pronounce';
import { DEFAULT_SENTENCE, parseTakeArgs, renderTakes, takeTexts } from '../src/voice-local/pronunciation-takes';
import { rms } from '../src/voice-local/pcm';
import { CachedSpeech, KEEP_COMMAS_MAX_CHARS, RESAMPLER_VERSION, SpitchTts } from '../src/voice-local/tts';
import { localToolDefinitions } from '../src/voice-local/voice-tools';
import {
  lastCallerWords,
  LONG_SENTENCE_CHARS,
  MAX_PREBUFFER_WAIT_MS,
  prebufferWaitMs,
  REPLY_DEADLINE_MS,
  replyDeadlineMs,
  SENTENCE_GAP_MS,
  splitLongSentence,
  unconfirmedReport,
  VoiceSession,
} from '../src/voice-local/voice-session';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require('../../../scripts/update-state-info-center.js');

const plateau = {
  name: 'Plateau State Government Citizen Contact Centre',
  slug: 'plateau-state',
  timezone: 'Africa/Lagos',
  welcomeMessage: state.STATE_WELCOME_MESSAGE,
  aiPersonaPrompt: state.STATE_PERSONA_PROMPT,
};
const otherAgency = { name: 'Jos Clinic', slug: 'jos-clinic', timezone: 'Africa/Lagos' };

describe('the instructions agree with themselves', () => {
  const prompt = agentPromptFor(plateau as any);
  const local = callSystemPrompt(plateau as any, { id: 'x', name: 'Gwaman' } as any, { sip_callerstatus: 'new' }, new Date('2026-11-27T19:00:00Z'));

  it('looks the caller up on the first turn ONLY when the line could not', () => {
    expect(prompt).not.toMatch(/MANDATORY FIRST-TURN LOOKUP|MANDATORY TURN-1 RULE|Never skip lookup-customer on Turn 1/);
    expect(prompt).toMatch(/Only when it is unknown \(or empty\) do you call your customer lookup tool/);
    expect(prompt).toMatch(/that IS the lookup — answer the caller at once and do not call lookup-customer/);
  });

  it('thanks a caller by name only after the name was read back and confirmed', () => {
    const line = prompt.split('\n').find((l) => l.includes('It is a pleasure speaking with you.'))!;
    expect(line).toMatch(/CONFIRMED the name you read back/);
    expect(prompt).toMatch(/repeat it back and ask them to confirm it/);
  });

  it('says "let me check" nowhere it is asked for, and the line overrides the stored persona', () => {
    expect(state.STATE_PERSONA_PROMPT).not.toMatch(/let me check/i);
    expect(local).toMatch(/this overrides any such expression suggested by the agency's text above/);
  });

  it('has one rule for reply length that leaves room for the script', () => {
    expect(local).not.toMatch(/35 to 55 words/);
    expect(local).toMatch(/one or two sentences and ONE question/);
    expect(local).toMatch(/PHASE 6 summary/);
  });

  it('asks a withheld caller for a number, and nobody else', () => {
    expect(prompt).toMatch(/When the caller's number is shown, never ask them to tell you their phone number/);
    expect(prompt).not.toMatch(/Never ask the caller to tell you their phone number — the system already has it\./);
  });

  it('recognises "Galby" as Gyel B and never says the misheard form back', () => {
    expect(SYSTEM_PROMPT).toMatch(/\*\*"Galby"\*\*.*Gyel B/);
    expect(prompt).toMatch(/never repeat the misheard form/);
  });

  it('carries no health-insurance example', () => {
    expect(prompt).not.toMatch(/Informal Sector plan|active enrollee/);
  });
});

describe('the contact centre is given only the tools it uses', () => {
  it('its prompt has no enrolment section and no appointment rule; another agency keeps both', () => {
    const cc = agentPromptFor(plateau as any);
    expect(cc).not.toContain('## Registering a Caller for a Service');
    expect(cc).not.toMatch(/Before proposing ANY appointment time/);
    // The section after it is still there: only the one section went.
    expect(cc).toContain('## Interruption & Flow Control');
    const other = agentPromptFor(otherAgency as any);
    expect(other).toContain('## Registering a Caller for a Service');
    expect(other).toMatch(/Before proposing ANY appointment time/);
  });

  it('its model is offered exactly the contact-centre tools', () => {
    const names = localToolDefinitions({ contactCentre: true }).map((d) => d.function.name).sort();
    expect(names).toEqual([...CONTACT_CENTRE_TOOLS].sort());
    for (const gone of ['book-appointment', 'check-availability', 'payment-details', 'register-enrollee', 'cancel-booking']) {
      expect(names).not.toContain(gone);
    }
    // Every other agency is unchanged.
    expect(localToolDefinitions().map((d) => d.function.name)).toEqual(expect.arrayContaining(['book-appointment', 'register-enrollee']));
  });
});

describe('the model', () => {
  const saved = process.env.LOCAL_VOICE_LLM_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOCAL_VOICE_LLM_MODEL;
    else process.env.LOCAL_VOICE_LLM_MODEL = saved;
  });
  it('defaults to gpt-4o, and the server setting still decides', () => {
    delete process.env.LOCAL_VOICE_LLM_MODEL;
    expect(voiceModel()).toBe('gpt-4o');
    process.env.LOCAL_VOICE_LLM_MODEL = 'gpt-4o-mini';
    expect(voiceModel()).toBe('gpt-4o-mini');
  });
});

describe('long sentences are spoken in parts', () => {
  it('leaves a normal sentence whole', () => {
    expect(splitLongSentence('Thank you for confirming that, Steven.')).toEqual(['Thank you for confirming that, Steven.']);
  });

  it('splits a long sentence at the comma nearest its middle, never at a thousands comma', () => {
    const long =
      'To help us resolve your issue and follow up with you, this call is being recorded and your personal details will be logged into our citizen support system.';
    expect(long.length).toBeGreaterThan(LONG_SENTENCE_CHARS);
    const parts = splitLongSentence(long);
    expect(parts).toEqual([
      'To help us resolve your issue and follow up with you,',
      'this call is being recorded and your personal details will be logged into our citizen support system.',
    ]);
    const money = 'The State approved a budget of 1,000 naira for every one of the seventeen local government areas in the year two thousand and twenty six for this.';
    expect(splitLongSentence(money)).toEqual([money]);
  });
});

describe('pronunciations', () => {
  const table = [{ written: 'Gyel', say: 'Jel', confirmed: 'test' }];
  it('replaces whole words only, whatever their case', () => {
    expect(pronounced('You are in Gyel B ward, gyel.', table)).toBe('You are in Jel B ward, Jel.');
    expect(pronounced('Gyelbo and Gyel-B', table)).toBe('Gyelbo and Jel-B');
  });
  it('ships no entry nobody has listened to', () => {
    for (const p of PRONUNCIATIONS) expect(p.confirmed.trim()).not.toBe('');
  });
  it('reads the old ElevenLabs dictionary file', () => {
    const pls = `<?xml version="1.0" encoding="UTF-8"?>
<lexicon version="1.0" xmlns="http://www.w3.org/2005/01/pronunciation-lexicon" alphabet="ipa" xml:lang="en-US">
  <lexeme><grapheme>Nanpan</grapheme><alias>Nahn-pahn</alias></lexeme>
  <lexeme><grapheme>Mutfwang</grapheme><phoneme>mʊtˈfwɑŋ</phoneme></lexeme>
</lexicon>`;
    expect(parsePls(pls)).toEqual([
      { words: ['Nanpan'], alias: 'Nahn-pahn' },
      { words: ['Mutfwang'], phoneme: 'mʊtˈfwɑŋ', alphabet: 'ipa' },
    ]);
  });
});

describe('what Spitch is given', () => {
  // The cleaning before this change, exactly, so the default is proven unchanged.
  const before = (text: string) =>
    text
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/:\s*$/g, '')
      .replace(/(?<!\d)\.(?=\s|$)/g, '')
      .replace(/,(?=\s|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const samples = ['Thank you for confirming that, Steven.', 'It costs 39.7 million, I think.', 'Note: ', 'Hello <b>there</b>, friend. Okay.', 'Is that correct?'];

  it('by default, exactly as before: no commas, no full stops, same cache key', () => {
    const spitch = new SpitchTts({ key: 'k' });
    for (const s of samples) expect(spitch.spitchText(s)).toBe(before(s));
    expect(spitch.dsp).toBe(RESAMPLER_VERSION);
  });

  it('with SPITCH_KEEP_COMMAS, keeps commas in a short sentence only, under its own cache key', () => {
    const spitch = new SpitchTts({ key: 'k', keepCommas: true });
    expect(spitch.spitchText('Thank you for confirming that, Steven.')).toBe('Thank you for confirming that, Steven');
    const long = `${'word '.repeat(KEEP_COMMAS_MAX_CHARS / 5)}and then, more.`;
    expect(spitch.spitchText(long)).not.toContain(',');
    expect(spitch.dsp).not.toBe(RESAMPLER_VERSION);
    const a = new CachedSpeech(new SpitchTts({ key: 'k' }) as any, null).key('Hello there.');
    const b = new CachedSpeech(spitch as any, null).key('Hello there.');
    expect(a).not.toBe(b);
  });
});

describe('the call loop speaks with pauses, in parts, and in the right words', () => {
  const tone = (ms: number) => {
    const buf = Buffer.alloc(ms * 16);
    for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(Math.round(5000 * Math.sin(i / 3)), i * 2);
    return buf;
  };

  async function run(opening: string, reply: string) {
    const asked: string[] = [];
    const frames: Buffer[] = [];
    let stt: any = null;
    const logs: string[] = [];
    const engine = {
      name: 'test',
      voice: 'v',
      async synthesize(text: string) {
        asked.push(text);
        return tone(200);
      },
    };
    const session = new VoiceSession(
      {
        sendAudio: (f) => frames.push(f),
        close: () => undefined,
        stt: async (ev) => {
          stt = ev;
          return { send: () => undefined, close: () => undefined };
        },
        assistantVoice: new CachedSpeech(engine as any, null),
        governorVoice: null,
        llm: async function* () {
          yield { type: 'text' as const, delta: reply };
        },
        tools: [],
        runTool: async () => ({ ok: true }),
        log: (e) => logs.push(e),
      },
      { systemPrompt: 'test', opening, personal: [] },
    );
    await session.start();
    await new Promise((r) => setTimeout(r, 600));
    const openingFrames = frames.splice(0);
    stt.onFinal('Where am I?', true);
    const until = Date.now() + 4_000;
    while (Date.now() < until && (session.busy || !logs.includes('voice_local_turn'))) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    const replyFrames = frames.splice(0);
    await session.finish('completed');
    return { asked, openingFrames, replyFrames, transcript: session.transcript };
  }

  /** Silent runs (in frames) strictly between the first and last audible frame. */
  const gaps = (fs: Buffer[]) => {
    const loud = fs.map((f, i) => (rms(f) > 200 ? i : -1)).filter((i) => i >= 0);
    const out: number[] = [];
    let run = 0;
    for (let i = loud[0]; i <= loud[loud.length - 1]; i++) {
      if (rms(fs[i]) <= 200) run++;
      else if (run) {
        out.push(run);
        run = 0;
      }
    }
    return out;
  };

  it('puts a speaker\'s pause between the sentences of a reply, and leaves the opening as it was', async () => {
    const { openingFrames, replyFrames } = await run('Welcome to the centre. How may I help you today?', 'You are in Jos North. Is that correct?');
    const replyGaps = gaps(replyFrames);
    expect(replyGaps.length).toBe(1);
    expect(replyGaps[0]).toBeGreaterThanOrEqual(SENTENCE_GAP_MS / 20);
    expect(replyGaps[0]).toBeLessThanOrEqual(SENTENCE_GAP_MS / 20 + 2);
    // The opening's two sentences play back to back, as before.
    expect(gaps(openingFrames).every((g) => g <= 1)).toBe(true);
  }, 15_000);

  it('sends a long sentence to the voice in two parts', async () => {
    const long =
      'To help us resolve your issue and follow up with you, this call is being recorded and your personal details will be logged into our citizen support system.';
    const { asked, transcript } = await run('Hello there, welcome.', long);
    expect(asked).toContain('To help us resolve your issue and follow up with you,');
    expect(asked).toContain('this call is being recorded and your personal details will be logged into our citizen support system.');
    // The record keeps the whole sentence.
    expect(transcript.some((t) => t.role === 'agent' && t.message.includes(long.slice(0, -1)))).toBe(true);
  }, 15_000);

  it('gives the voice the listed spelling in a reply, but never in the opening or the record', async () => {
    PRONUNCIATIONS.push({ written: 'Gyel', say: 'Jel', confirmed: 'test only' });
    try {
      const { asked, transcript } = await run('Welcome to Gyel ward.', 'You are in Gyel B ward.');
      expect(asked).toContain('Welcome to Gyel ward.');
      expect(asked).toContain('You are in Jel B ward.');
      expect(transcript.some((t) => t.role === 'agent' && t.message === 'You are in Gyel B ward.')).toBe(true);
    } finally {
      PRONUNCIATIONS.pop();
    }
  }, 15_000);
});

// ── 27 Nov, second round: from the server's conversation check on the new code ──

describe('a report is registered only after a clear yes', () => {
  const prompt = agentPromptFor(plateau as any);
  const local = callSystemPrompt(plateau as any, { id: 'x', name: 'Gwaman' } as any, { sip_callerstatus: 'new' }, new Date('2026-11-27T19:00:00Z'));

  it('says what is and is not a yes, asks the closing question first, and saves the LGA when named', () => {
    expect(prompt).toMatch(/"No", "Nothing else", a correction or anything unclear is NOT a yes/);
    expect(prompt).toMatch(/always ask the PHASE 3 closing question \("Is there any additional information, evidence or detail/);
    expect(local).toMatch(/clearly names their Local Government Area, call update-caller-profile with that lga in the SAME reply/);
  });

  it('refuses create-ticket after the caller says "No…", and only then', () => {
    const confirmed = { summaryConfirmed: true };
    expect(unconfirmedReport('create-ticket', confirmed, 'No, nothing else.')).toMatchObject({ ok: false });
    expect(unconfirmedReport('create-ticket', confirmed, '  no that is wrong')).toMatchObject({ ok: false });
    expect(unconfirmedReport('create-ticket', confirmed, 'Yes, that is correct.')).toBeNull();
    expect(unconfirmedReport('create-ticket', confirmed, 'Nothing more, that is right.')).toBeNull();
    // An emergency still happening is never held for a summary.
    expect(unconfirmedReport('create-ticket', { ...confirmed, isOngoing: true }, 'No, they are still shooting')).toBeNull();
    // Not a confirmed registration, or not a report: not this guard's business.
    expect(unconfirmedReport('create-ticket', {}, 'No.')).toBeNull();
    expect(unconfirmedReport('update-caller-profile', confirmed, 'No.')).toBeNull();
  });

  it("reads the caller's own last words, never a note from the system", () => {
    expect(
      lastCallerWords([
        { role: 'system', content: 's' },
        { role: 'user', content: 'No, nothing else.' },
        { role: 'assistant', content: 'Is this accurate?' },
        { role: 'user', content: '[No reply from the caller for 12 seconds (check 1). They have not spoken.]' },
      ]),
    ).toBe('No, nothing else.');
    expect(lastCallerWords([{ role: 'user', content: '(Said while the greeting was still playing, before you asked your question:) No thanks' }])).toBe('No thanks');
    expect(lastCallerWords([{ role: 'system', content: 's' }])).toBe('');
  });

  it('on a call: nothing is written after "No, nothing else.", and the report is filed after "Yes"', async () => {
    const written: string[] = [];
    const toolReplies: string[] = [];
    let stt: any = null;
    const ticket = { id: 't1', type: 'function' as const, function: { name: 'create-ticket', arguments: '{"subject":"Borehole","summaryConfirmed":true}' } };
    const session = new VoiceSession(
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
          const last = messages[messages.length - 1];
          if (last.role === 'tool') {
            toolReplies.push(String(last.content));
            yield { type: 'text' as const, delta: 'Is this summary accurate?' };
            return;
          }
          yield { type: 'tool_calls' as const, calls: [ticket] };
        },
        tools: [],
        runTool: async (name) => {
          written.push(name);
          return { ok: true };
        },
        log: () => undefined,
      },
      { systemPrompt: 'test', opening: 'Hello.', personal: [] },
    );
    await session.start();
    await new Promise((r) => setTimeout(r, 200));
    const answer = async (said: string) => {
      stt.onFinal(said, true);
      const until = Date.now() + 3_000;
      do await new Promise((r) => setTimeout(r, 30));
      while (Date.now() < until && session.busy);
    };
    await answer('No, nothing else.');
    expect(written).toEqual([]);
    expect(toolReplies[0]).toMatch(/Nothing was registered/);
    await answer('Yes, that is correct.');
    expect(written).toEqual(['create-ticket']);
    await session.finish('completed');
  }, 15_000);
});

describe('the pause before a reply is a server setting', () => {
  const saved = process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS;
    else process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS = saved;
  });

  it('defaults to what it was, takes 0–5000 ms, and ignores anything else', () => {
    delete process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS;
    expect(prebufferWaitMs()).toBe(MAX_PREBUFFER_WAIT_MS);
    process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS = '800';
    expect(prebufferWaitMs()).toBe(800);
    process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS = '0';
    expect(prebufferWaitMs()).toBe(0);
    for (const bad of ['-1', '9000', 'fast']) {
      process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS = bad;
      expect(prebufferWaitMs()).toBe(MAX_PREBUFFER_WAIT_MS);
    }
  });

  /** How long after the caller finished the reply's first sound left, with a slow second sentence. */
  async function firstSoundAfter(wait: string | undefined): Promise<number> {
    if (wait === undefined) delete process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS;
    else process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS = wait;
    let stt: any = null;
    let askedAt = 0;
    let firstLoud = 0;
    const tone = Buffer.alloc(16 * 300);
    for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(5000 * Math.sin(i / 3)), i * 2);
    const session = new VoiceSession(
      {
        sendAudio: (f) => {
          if (askedAt && !firstLoud && rms(f) > 200) firstLoud = Date.now();
        },
        close: () => undefined,
        stt: async (ev) => {
          stt = ev;
          return { send: () => undefined, close: () => undefined };
        },
        assistantVoice: new CachedSpeech(
          {
            name: 't',
            synthesize: async (text: string) => {
              await new Promise((r) => setTimeout(r, /slow/.test(text) ? 1_500 : 20));
              return tone;
            },
          } as any,
          null,
        ),
        governorVoice: null,
        llm: async function* () {
          yield { type: 'text' as const, delta: 'Thank you for that, Steven. This second sentence is slow to make.' };
        },
        tools: [],
        runTool: async () => ({ ok: true }),
        log: () => undefined,
      },
      { systemPrompt: 'test', opening: 'Hello there.', personal: [] },
    );
    await session.start();
    await new Promise((r) => setTimeout(r, 500));
    askedAt = Date.now();
    stt.onFinal('Hello', true);
    const until = Date.now() + 5_000;
    while (Date.now() < until && !firstLoud) await new Promise((r) => setTimeout(r, 20));
    await session.finish('completed');
    return firstLoud - askedAt;
  }

  it('at 0 the reply starts without waiting for its slow second sentence; by default it waits', async () => {
    expect(await firstSoundAfter('0')).toBeLessThan(600);
    expect(await firstSoundAfter(undefined)).toBeGreaterThan(1_200);
  }, 20_000);

  it('never leaves the caller waiting past the reply deadline, however long the pre-buffer would wait', async () => {
    const saved = process.env.LOCAL_VOICE_REPLY_DEADLINE_MS;
    try {
      delete process.env.LOCAL_VOICE_REPLY_DEADLINE_MS;
      expect(replyDeadlineMs()).toBe(REPLY_DEADLINE_MS);
      for (const bad of ['-1', '9000', 'soon']) {
        process.env.LOCAL_VOICE_REPLY_DEADLINE_MS = bad;
        expect(replyDeadlineMs()).toBe(REPLY_DEADLINE_MS);
      }
      // Pre-buffer allowed 5 s, deadline 300 ms: the first sentence plays at
      // the deadline, without waiting 1.5 s for the slow second sentence.
      process.env.LOCAL_VOICE_REPLY_DEADLINE_MS = '300';
      expect(replyDeadlineMs()).toBe(300);
      const first = await firstSoundAfter('5000');
      expect(first).toBeLessThan(900);
    } finally {
      if (saved === undefined) delete process.env.LOCAL_VOICE_REPLY_DEADLINE_MS;
      else process.env.LOCAL_VOICE_REPLY_DEADLINE_MS = saved;
    }
  }, 20_000);
});

describe('pronunciations set on the server, and hearing them first', () => {
  it('reads "Word=Spelling; Other=Spelling", quotes and all, and skips what is malformed', () => {
    expect(pronunciationsFromEnv('"Plateau=Plah-toe; Gyel = Jel; =x; nothing; Bad=;"').map((p) => [p.written, p.say])).toEqual([
      ['Plateau', 'Plah-toe'],
      ['Gyel', 'Jel'],
    ]);
    expect(pronunciationsFromEnv('')).toEqual([]);
  });

  it('a server setting reaches what the voice is given', () => {
    const saved = process.env.LOCAL_VOICE_PRONOUNCE;
    process.env.LOCAL_VOICE_PRONOUNCE = 'Plateau=Plah-toe';
    try {
      expect(pronounced('Welcome to the Plateau State Government.')).toBe('Welcome to the Plah-toe State Government.');
    } finally {
      if (saved === undefined) delete process.env.LOCAL_VOICE_PRONOUNCE;
      else process.env.LOCAL_VOICE_PRONOUNCE = saved;
    }
    expect(pronounced('Welcome to the Plateau State Government.')).toBe('Welcome to the Plateau State Government.');
  });

  it('says PLASCHEMA as PLAS-CHE-MA, and a server setting for the same word wins', () => {
    const saved = process.env.LOCAL_VOICE_PRONOUNCE;
    try {
      delete process.env.LOCAL_VOICE_PRONOUNCE;
      expect(pronounced('Speak to someone from PLASCHEMA today.')).toBe('Speak to someone from Plas-cheh-ma today.');
      expect(pronounced('free Plaschema health insurance')).toBe('free Plas-cheh-ma health insurance');
      process.env.LOCAL_VOICE_PRONOUNCE = 'PLASCHEMA=Plas-che-mah';
      expect(pronounced('Speak to someone from PLASCHEMA today.')).toBe('Speak to someone from Plas-che-mah today.');
    } finally {
      if (saved === undefined) delete process.env.LOCAL_VOICE_PRONOUNCE;
      else process.env.LOCAL_VOICE_PRONOUNCE = saved;
    }
  });

  it('renders the word as written and each spelling, in every voice, and returns a link for each', async () => {
    const req = parseTakeArgs(['Plateau', 'Plah-toe', 'Plah toe']);
    expect(req.sentence).toBe(DEFAULT_SENTENCE);
    expect(takeTexts(req).map((t) => t.text)).toEqual([
      'Thank you for calling the Plateau State Government Citizen Contact Centre.',
      'Thank you for calling the Plah-toe State Government Citizen Contact Centre.',
      'Thank you for calling the Plah toe State Government Citizen Contact Centre.',
    ]);
    const said: string[] = [];
    const stored: string[] = [];
    const engine = (name: string) => ({ name, synthesize: async (t: string) => (said.push(`${name}:${t}`), Buffer.alloc(1600)) });
    const takes = await renderTakes(req, [{ name: 'jude', engine: engine('jude') }, { name: 'lucy', engine: engine('lucy') }], {
      upload: async (name, wav) => {
        expect(wav.subarray(0, 4).toString()).toBe('RIFF');
        stored.push(name);
        return `pronunciation-takes/${name}`;
      },
      link: async (path) => `https://example.test/api/files/call-recordings/${path}`,
    });
    expect(takes).toHaveLength(6);
    expect(said.filter((s) => s.startsWith('lucy:'))).toHaveLength(3);
    expect(takes[1]).toMatchObject({ voice: 'jude', label: 'spelled: Plah-toe' });
    expect(new Set(stored).size).toBe(6);
  });

  it('refuses a request it cannot render', () => {
    expect(() => parseTakeArgs(['Plateau'])).toThrow(/Usage/);
    expect(() => parseTakeArgs(['Gyel', 'Jel', '--sentence', 'no placeholder'])).toThrow(/\{word\}/);
    expect(parseTakeArgs(['Gyel', 'Jel', '--sentence', 'You are in {word} B ward.']).sentence).toBe('You are in {word} B ward.');
  });
});

// ── Go-live checklist A4 and H2: the call loop itself ──────────────────────

describe('checklist A4: the agent stops when the caller talks over it', () => {
  it('stops its speech within a frame or two of the caller speaking, then answers what they said', async () => {
    let stt: any = null;
    const sent: Buffer[] = [];
    const logs: string[] = [];
    const answered: string[] = [];
    const tone = Buffer.alloc(16 * 4_000); // four seconds of speech
    for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(5000 * Math.sin(i / 3)), i * 2);
    const session = new VoiceSession(
      {
        sendAudio: (f) => sent.push(f),
        close: () => undefined,
        stt: async (ev) => {
          stt = ev;
          return { send: () => undefined, close: () => undefined };
        },
        assistantVoice: new CachedSpeech({ name: 't', synthesize: async () => tone } as any, null),
        governorVoice: null,
        llm: async function* (messages) {
          const last = String(messages[messages.length - 1].content ?? '');
          answered.push(last);
          yield { type: 'text' as const, delta: /wait/i.test(last) ? 'Of course, go ahead.' : 'Here is a long answer that takes a while to say.' };
        },
        tools: [],
        runTool: async () => ({ ok: true }),
        log: (e) => logs.push(e),
      },
      { systemPrompt: 'test', opening: 'Hello.', personal: [] },
    );
    await session.start();
    await new Promise((r) => setTimeout(r, 4_300)); // the opening (four seconds) has played
    stt.onFinal('Tell me about the projects.', true);
    const until = Date.now() + 3_000;
    while (Date.now() < until && !sent.slice(-5).some((f) => rms(f) > 200)) await new Promise((r) => setTimeout(r, 20));
    // The caller talks over it: loud audio and words.
    const loud = Buffer.alloc(320);
    for (let i = 0; i < 160; i++) loud.writeInt16LE(Math.round(6000 * Math.sin(i / 2)), i * 2);
    for (let i = 0; i < 10; i++) session.onCallerAudio(loud);
    const before = sent.length;
    stt.onInterim('wait wait please');
    await new Promise((r) => setTimeout(r, 200));
    expect(logs).toContain('voice_local_barge_in');
    // Within 200 ms the stream is silence: the long answer stopped.
    expect(sent.slice(before + 2).every((f) => rms(f) <= 200)).toBe(true);
    stt.onFinal('Wait, wait please.', true);
    const end = Date.now() + 3_000;
    while (Date.now() < end && !answered.some((a) => /wait/i.test(a))) await new Promise((r) => setTimeout(r, 20));
    expect(answered.some((a) => /wait/i.test(a))).toBe(true);
    await session.finish('completed');
  }, 20_000);
});

describe('checklist H2: a silent caller is asked whether they are there, then the call ends', () => {
  it('sends the model a no-reply note after 12 s of silence, at most three times, and hangs up when it calls end_call', async () => {
    // Real time plus jumps: the audio player runs on this clock, so it must keep moving.
    let offset = 0;
    const notes: string[] = [];
    let closed = false;
    const session = new VoiceSession(
      {
        sendAudio: () => undefined,
        close: () => (closed = true),
        stt: async () => ({ send: () => undefined, close: () => undefined }),
        assistantVoice: new CachedSpeech({ name: 't', synthesize: async () => Buffer.alloc(320) } as any, null),
        governorVoice: null,
        now: () => Date.now() + offset,
        llm: async function* (messages) {
          const last = String(messages[messages.length - 1].content ?? '');
          if (/No reply from the caller/.test(last)) notes.push(last);
          if (/check 3/.test(last)) {
            yield { type: 'text' as const, delta: 'Thank you for calling. Goodbye.' };
            yield { type: 'tool_calls' as const, calls: [{ id: 'e', type: 'function' as const, function: { name: 'end_call', arguments: '{}' } }] };
            return;
          }
          yield { type: 'text' as const, delta: 'Are you still there?' };
        },
        tools: [],
        runTool: async () => ({ ok: true }),
        log: () => undefined,
      },
      { systemPrompt: 'test', opening: 'Hello.', personal: [] },
    );
    await session.start();
    for (let i = 0; i < 3 && !closed; i++) {
      // Silence counts from when the agent last spoke: wait for it to finish.
      const quiet = Date.now() + 3_000;
      while (Date.now() < quiet && session.busy) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 100));
      offset += 12_500; // twelve and a half silent seconds
      const until = Date.now() + 3_000;
      while (Date.now() < until && notes.length < i + 1) await new Promise((r) => setTimeout(r, 50));
    }
    const until = Date.now() + 3_000;
    while (Date.now() < until && !closed) await new Promise((r) => setTimeout(r, 50));
    expect(notes.map((n) => n.match(/check (\d)/)![1])).toEqual(['1', '2', '3']);
    expect(closed).toBe(true);
    expect(session.outcome).toBe('completed');
  }, 20_000);
});
