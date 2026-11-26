import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { installTakes, linesByPeriod, parseChoices, periodOf, readTakeWav, renderTakes } from '../src/voice-local/governor-takes';
import { wavFile } from '../src/voice-local/pcm';
import { spokenPunctuation, type ClipCheck } from '../src/voice-local/speech-check';
import { CachedSpeech, type SpeechEngine } from '../src/voice-local/tts';
import { TtsCache } from '../src/voice-local/tts-cache';

/**
 * Spitch renders every take of a line differently, and on 26 Nov 2026 the
 * Governor's clip on calls dragged "Plateau" while another take of the same
 * voice, spelling and speed was the one the agency wanted. Nothing measurable
 * told them apart, so a person picks the take and it becomes what calls play.
 */
const LINES = ['morning', 'afternoon', 'evening'].map(
  (p) => `Good ${p}, and welcome to the Plateau State Government Citizen Contact Centre. Our virtual assistant will help you now.`,
);

class Engine implements SpeechEngine {
  readonly name = 'spitch';
  readonly voice = 'voice_gov';
  calls = 0;
  /** `script[i]` names the i-th take; a name starting "bad" reads a full stop aloud. */
  constructor(
    readonly rate = '1.0',
    private readonly script: string[] = [],
  ) {}
  async synthesize(): Promise<Buffer> {
    const tag = this.script[this.calls] ?? `take${this.calls}`;
    this.calls++;
    const b = Buffer.alloc(800);
    b.write(tag);
    return b;
  }
}
const listener: ClipCheck = async (text, audio) => {
  const heard = audio.toString().startsWith('bad') ? `${text} full stop` : text;
  const extras = spokenPunctuation(text, heard);
  return { ok: !extras.length, heard, extras };
};
const tag = (b: Buffer | null) => (b ? b.toString().replace(/\0+$/, '') : null);

describe('governor takes', () => {
  let root: string;
  let cache: TtsCache;
  let dir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-takes-'));
    cache = new TtsCache(path.join(root, 'cache'));
    dir = path.join(root, 'takes');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('knows each line by its time of day, and refuses a greeting that cannot be chosen that way', () => {
    expect(periodOf(LINES[2])).toBe('evening');
    expect([...linesByPeriod(LINES).keys()]).toEqual(['morning', 'afternoon', 'evening']);
    // A welcome that names the assistant in the Governor's part has a line per name.
    expect(() => linesByPeriod([LINES[0], LINES[0].replace('assistant', 'assistant, Gwaman,')])).toThrow('more than one');
    expect(() => linesByPeriod(['Welcome to the centre.'])).toThrow('does not start with');
  });

  it('writes the clip calls play now as take 0, then new takes, throwing away any that reads punctuation aloud', async () => {
    const speech = new CachedSpeech(new Engine('1.0', ['m1', 'bad', 'm2', 'a1', 'a2', 'e1', 'e2']), cache, listener);
    speech.install(LINES[0], await new Engine('1.0', ['current']).synthesize());
    await cache.flush();
    const logs: string[] = [];
    const files = await renderTakes(LINES, speech, dir, 2, (m) => logs.push(m));
    expect(files).toEqual(['morning-0.wav', 'morning-1.wav', 'morning-2.wav', 'afternoon-1.wav', 'afternoon-2.wav', 'evening-1.wav', 'evening-2.wav']);
    expect(logs).toEqual(['  morning: a take said "full stop" aloud and was thrown away']);
    // Every file is what the line plays: 8 kHz mono, and the right take.
    expect(tag(readTakeWav(fs.readFileSync(path.join(dir, 'morning-0.wav'))))).toBe('current');
    expect(tag(readTakeWav(fs.readFileSync(path.join(dir, 'morning-2.wav'))))).toBe('m2');
    // Rendering changed nothing a call plays.
    expect(tag(speech.peek(LINES[0]))).toBe('current');
    expect(speech.peek(LINES[2])).toBeNull();
  });

  it('installs the chosen takes as the clips calls play, under the same key a call looks up', async () => {
    const engine = new Engine('1.0', ['m1', 'm2', 'a1', 'a2', 'e1', 'e2']);
    await renderTakes(LINES, new CachedSpeech(engine, cache, listener), dir, 2, () => undefined);
    const done = await installTakes(parseChoices(['evening=2', 'morning=1']), LINES, new CachedSpeech(new Engine('1.0'), cache), cache, dir);
    expect(done).toEqual(['evening: take 2 installed', 'morning: take 1 installed']);
    // What a call does: a fresh CachedSpeech for the same engine settings finds the chosen take.
    const call = new CachedSpeech(new Engine('1.0'), new TtsCache(path.join(root, 'cache')));
    expect(tag(call.peek(LINES[2]))).toBe('e2');
    expect(tag(call.peek(LINES[0]))).toBe('m1');
    expect(call.peek(LINES[1])).toBeNull(); // not chosen, not touched
    // And plays it without asking Spitch.
    const e = new Engine('1.0');
    expect((await new CachedSpeech(e, cache).speak(LINES[2], { alwaysCache: true })).cached).toBe(true);
    expect(e.calls).toBe(0);
  });

  it('refuses, and changes nothing, when the voice or speed has changed since the takes were made', async () => {
    await renderTakes(LINES, new CachedSpeech(new Engine('1.0'), cache, listener), dir, 2, () => undefined);
    const faster = new CachedSpeech(new Engine('1.15'), cache);
    await expect(installTakes(parseChoices(['morning=1', 'evening=1']), LINES, faster, cache, dir)).rejects.toThrow('has changed since the takes were made');
    expect(faster.peek(LINES[0])).toBeNull();
    expect(faster.peek(LINES[2])).toBeNull();
  });

  it('refuses a take that does not exist, a malformed choice, and a choice before any takes were made', async () => {
    const speech = new CachedSpeech(new Engine('1.0'), cache);
    await expect(installTakes(parseChoices(['evening=1']), LINES, speech, cache, dir)).rejects.toThrow('run with --render first');
    await renderTakes(LINES, new CachedSpeech(new Engine('1.0'), cache, listener), dir, 2, () => undefined);
    await expect(installTakes(parseChoices(['evening=3']), LINES, speech, cache, dir)).rejects.toThrow('takes 1 to 2 were made');
    expect(() => parseChoices(['evening:2'])).toThrow('write it as evening=2');
    expect(() => parseChoices([])).toThrow('No takes chosen');
    // Take 0 keeps what calls play now.
    expect(await installTakes(parseChoices(['evening=0']), LINES, speech, cache, dir)).toEqual(['evening: kept the clip calls play now']);
    expect(speech.peek(LINES[2])).toBeNull();
  });

  it('reads only the 8 kHz mono WAV it writes, and refuses anything else rather than converting it', () => {
    const pcm = Buffer.alloc(320, 1);
    expect(readTakeWav(wavFile(pcm, 1, 8000)).equals(pcm)).toBe(true);
    expect(() => readTakeWav(wavFile(pcm, 2, 8000))).toThrow('8 kHz 16-bit mono');
    expect(() => readTakeWav(wavFile(pcm, 1, 24000))).toThrow('8 kHz 16-bit mono');
    expect(() => readTakeWav(Buffer.from('not audio at all, honestly not at all'))).toThrow('not a WAV');
  });
});
