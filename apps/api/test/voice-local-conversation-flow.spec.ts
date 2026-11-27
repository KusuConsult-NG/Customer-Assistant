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
import { pronounced, PRONUNCIATIONS } from '../src/voice-local/pronounce';
import { rms } from '../src/voice-local/pcm';
import { CachedSpeech, KEEP_COMMAS_MAX_CHARS, RESAMPLER_VERSION, SpitchTts } from '../src/voice-local/tts';
import { localToolDefinitions } from '../src/voice-local/voice-tools';
import { LONG_SENTENCE_CHARS, SENTENCE_GAP_MS, splitLongSentence, VoiceSession } from '../src/voice-local/voice-session';
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
