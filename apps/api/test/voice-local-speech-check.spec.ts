import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deepgramClipCheck, spokenPunctuation, type ClipCheck } from '../src/voice-local/speech-check';
import { CachedSpeech, type SpeechEngine } from '../src/voice-local/tts';
import { TtsCache } from '../src/voice-local/tts-cache';
import { prerender } from '../src/voice-local/prerender';

/**
 * Spitch's voices sometimes READ PUNCTUATION ALOUD. Measured on the server on
 * 26 Nov 2026: jude said "...our citizen support system full stop" in the
 * recording notice saved on disk, so every call replayed it, and fresh renders
 * of the same sentence said "comma" — with or without the final full stop, so
 * deleting punctuation does not cure it. A clip is therefore HEARD before it is
 * kept: one that says a punctuation mark its text does not contain is never stored.
 */
const NOTICE =
  'To help us resolve your issue and follow up with you, this call is being recorded and your personal details will be logged into our citizen support system.';
const NOTICE_HEARD_OK =
  'to help us resolve your issue and follow-up with you this call is being recorded and your personal details will be logged into our citizen support system';

describe('spoken punctuation', () => {
  it('finds the marks heard on the real call and in the probe', () => {
    expect(spokenPunctuation(NOTICE, `${NOTICE_HEARD_OK} full stop`)).toEqual(['full stop']);
    expect(
      spokenPunctuation(
        NOTICE,
        'to help us resolve your issue and follow-up with you comma this call is being recorded comma and your personal details will be logged into our citizen support system full',
      ),
    ).toEqual(['comma', 'comma', 'full']);
    expect(spokenPunctuation(NOTICE, NOTICE_HEARD_OK)).toEqual([]);
  });

  it('does not flag a word the sentence itself says', () => {
    expect(spokenPunctuation('May I have your full name?', 'may i have your full name')).toEqual([]);
    expect(spokenPunctuation('The waiting period is two weeks.', 'the waiting period is two weeks')).toEqual([]);
    // ...but a second one it does not say is still caught.
    expect(spokenPunctuation('The waiting period is two weeks.', 'the waiting period is two weeks period')).toEqual(['period']);
    expect(spokenPunctuation('Is that correct?', 'is that correct question mark')).toEqual(['question mark']);
  });
});

class Engine implements SpeechEngine {
  readonly name = 'spitch';
  readonly voice = 'jude';
  readonly rate = '1.0';
  calls = 0;
  constructor(private readonly clips: string[]) {}
  async synthesize(): Promise<Buffer> {
    const tag = this.clips[Math.min(this.calls++, this.clips.length - 1)];
    return Buffer.from(tag.padEnd(64, '.'));
  }
}
/** A "listener" that hears what the fake clip says: `bad` clips end in "full stop". */
const listener: ClipCheck = async (text, audio) => {
  const heard = audio.toString().startsWith('bad') ? `${text} full stop` : text;
  const extras = spokenPunctuation(text, heard);
  return { ok: extras.length === 0, heard, extras };
};
const tmpCache = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ace-check-'));
  return { dir, cache: new TtsCache(dir) };
};

describe('a clip is heard before it is kept', () => {
  it('on a call: the caller still hears it, but a clip that says "full stop" is never stored', async () => {
    const { dir, cache } = tmpCache();
    const rejected: string[] = [];
    const speech = new CachedSpeech(new Engine(['bad', 'good']), cache, listener, (text, r) => rejected.push(`${text}|${'extras' in r ? r.extras.join(',') : r.error}`));
    const first = await speech.speak('Okay, let me check.');
    expect(first.audio.toString().startsWith('bad')).toBe(true); // nothing is held back from the caller
    await speech.settle();
    await cache.flush();
    expect(speech.peek('Okay, let me check.')).toBeNull();
    expect(rejected).toEqual(['Okay, let me check.|full stop']);
    // The next call renders it again, and this time the clean clip is kept.
    expect((await speech.speak('Okay, let me check.')).cached).toBe(false);
    await speech.settle();
    await cache.flush();
    expect(speech.peek('Okay, let me check.')!.toString().startsWith('good')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a clip that could not be checked is not stored either', async () => {
    const { dir, cache } = tmpCache();
    const speech = new CachedSpeech(new Engine(['good']), cache, async () => {
      throw new Error('Deepgram 503');
    });
    await speech.speak('Okay, let me check.');
    await speech.settle();
    await cache.flush();
    expect(speech.peek('Okay, let me check.')).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the pre-render re-renders a bad clip and keeps only the clean one', async () => {
    const { dir, cache } = tmpCache();
    const engine = new Engine(['bad', 'good']);
    const speech = new CachedSpeech(engine, cache, listener);
    const r = await prerender([NOTICE], speech, cache, true, () => undefined);
    expect(r).toEqual({ present: 0, rendered: 1, replaced: 0, failed: [] });
    expect(engine.calls).toBe(2);
    expect(speech.peek(NOTICE)!.toString().startsWith('good')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the pre-render reports a sentence that keeps coming out wrong, and stores nothing', async () => {
    const { dir, cache } = tmpCache();
    const engine = new Engine(['bad']);
    const speech = new CachedSpeech(engine, cache, listener);
    const r = await prerender([NOTICE], speech, cache, true, () => undefined);
    expect(r.rendered).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]).toContain('full stop');
    expect(engine.calls).toBe(3);
    expect(speech.peek(NOTICE)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('--recheck finds the bad clip already on disk and replaces it', async () => {
    const { dir, cache } = tmpCache();
    // What the server holds today: the notice, saved by an earlier pre-render, saying "full stop".
    const old = new CachedSpeech(new Engine(['bad']), cache);
    await old.speak(NOTICE, { alwaysCache: true });
    await cache.flush();
    const speech = new CachedSpeech(new Engine(['good']), cache, listener);
    // Without --recheck a clip on disk is trusted, as before.
    expect((await prerender([NOTICE], speech, cache, true, () => undefined)).present).toBe(1);
    expect(speech.peek(NOTICE)!.toString().startsWith('bad')).toBe(true);
    const r = await prerender([NOTICE], speech, cache, true, () => undefined, { recheck: true });
    expect(r).toEqual({ present: 0, rendered: 0, replaced: 1, failed: [] });
    expect(speech.peek(NOTICE)!.toString().startsWith('good')).toBe(true);
    // A report (no --apply) names it and changes nothing.
    const { dir: d2, cache: c2 } = tmpCache();
    await new CachedSpeech(new Engine(['bad']), c2).speak(NOTICE, { alwaysCache: true });
    await c2.flush();
    const lines: string[] = [];
    const s2 = new CachedSpeech(new Engine(['good']), c2, listener);
    const rep = await prerender([NOTICE], s2, c2, false, (m) => lines.push(m), { recheck: true });
    expect(rep.present).toBe(0);
    expect(lines.join('\n')).toContain('says "full stop"');
    expect(s2.peek(NOTICE)!.toString().startsWith('bad')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(d2, { recursive: true, force: true });
  });
});

describe('deepgramClipCheck', () => {
  it('sends the 8 kHz clip as a WAV, without punctuation, and reads the transcript', async () => {
    let seen: { url: string; body: Buffer; auth: string } | null = null;
    const fetchImpl = (async (url: string, init: any) => {
      seen = { url, body: Buffer.from(init.body), auth: init.headers.Authorization };
      return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: `${NOTICE_HEARD_OK} full stop` }] }] } }) };
    }) as any;
    const r = await deepgramClipCheck('dg-key', fetchImpl)(NOTICE, Buffer.alloc(1600));
    expect(r).toEqual({ ok: false, heard: `${NOTICE_HEARD_OK} full stop`, extras: ['full stop'] });
    expect(seen!.url).toContain('punctuate=false');
    expect(seen!.auth).toBe('Token dg-key');
    expect(seen!.body.toString('ascii', 0, 4)).toBe('RIFF');
    expect(seen!.body.readUInt32LE(24)).toBe(8000);
    expect(seen!.body.length).toBe(44 + 1600);
  });

  it('throws when Deepgram refuses, rather than calling the clip clean', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 401, text: async () => 'bad key' })) as any;
    await expect(deepgramClipCheck('k', fetchImpl)('Hello.', Buffer.alloc(320))).rejects.toThrow('401');
  });
});
