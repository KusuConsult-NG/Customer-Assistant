/**
 * There is exactly ONE Deepgram URL in this API, and the stream describes
 * itself honestly.
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * There were two. `createDeepgramWsForOrg` builds the URL from the caller's
 * wire format and the agency's configured language. Beside it sat
 * `createDeepgramWs()`, a fully hardcoded second copy:
 *
 *   model=nova-2&language=en&…&encoding=mulaw&sample_rate=8000&channels=1
 *
 * It had ZERO callers, and its comment claimed it was "used by legacy
 * Socket.IO path" — a caller that did not exist.
 *
 * Two things made it dangerous rather than merely untidy:
 *
 *  - `language=en` was hardcoded. Had anything called it, an agency
 *    configured for Hausa would have been transcribed as English, and
 *    wrong-language transcription reads as a citizen talking nonsense rather
 *    than as an error anybody can see.
 *  - It was a second copy of the WIRE FORMAT. The only reason
 *    `createDeepgramWsForOrg` takes `encoding` and `sampleRate` at all is
 *    that telling Deepgram mulaw/8000 while sending 48 kHz PCM transcribes
 *    every word at the wrong speed and pitch — nonsense, not a failure. The
 *    WhatsApp call bridge sends linear16/48000 and the Twilio handler sends
 *    mulaw/8000, so a hardcoded duplicate is precisely the thing that drifts
 *    out of agreement with the stream it describes.
 *
 * So this asserts the count, not just the behaviour: a second copy cannot
 * come back quietly, which is the same guarantee `@ace/scheduling-engine`'s
 * suite enforces about `generateIcalEvent` being its only export.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { deepgramModel } from '../src/telephony/voice-ai.service';

const SRC = join(__dirname, '..', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

describe('Deepgram wiring', () => {
  const files = sourceFiles(SRC);

  it('reads the source at all, so a matcher that finds nothing cannot pass', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith('voice-ai.service.ts'))).toBe(true);
  });

  // STREAMING (wss, a live call) and PRE-RECORDED (https, a WhatsApp voice
  // note) are two different Deepgram endpoints that share a path. The rule
  // this guards — one place that opens a live transcription — is about the
  // streaming one; the voice-note path is pinned separately below.
  it('builds the streaming listen URL in exactly one place', () => {
    const sites = files
      .filter((f) => !f.includes('.spec.'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .map((line, i) => ({ f, i, line }))
          .filter(({ line }) => /wss:\/\/api\.deepgram\.com\/v1\/listen/.test(line))
          // The explanation of why the second copy was deleted names the URL.
          .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      )
      .map(({ f, i, line }) => `${f.replace(SRC, 'src')}:${i + 1}  ${line.trim()}`);

    expect(sites).toHaveLength(1);
    expect(sites[0]).toContain('voice-ai.service.ts');
  });

  it('transcribes voice notes from one pre-recorded URL, with the same model setting', () => {
    const sites = files
      .filter((f) => !f.includes('.spec.'))
      .flatMap((f) =>
        readFileSync(f, 'utf8')
          .split('\n')
          .filter((line) => /https:\/\/api\.deepgram\.com\/v1\/listen/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
          .map(() => f.replace(SRC, 'src')),
      );
    expect(sites).toEqual(['src/whatsapp/media-understanding.ts']);
    const src = readFileSync(join(SRC, 'whatsapp', 'media-understanding.ts'), 'utf8');
    expect(src).toMatch(/model: deepgramModel\(\)/);
  });

  it('hardcodes neither the language nor the wire format in that URL', () => {
    // The two values that make a wrong transcript rather than an error.
    const src = readFileSync(join(SRC, 'telephony', 'voice-ai.service.ts'), 'utf8');
    const urlLines = src
      .split('\n')
      .filter((l) => /wss:\/\/api\.deepgram\.com\/v1\/listen/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));

    expect(urlLines).toHaveLength(1);
    expect(urlLines[0]).not.toMatch(/language=/);
    expect(urlLines[0]).not.toMatch(/encoding=/);
    expect(urlLines[0]).not.toMatch(/sample_rate=/);
    expect(urlLines[0]).not.toMatch(/model=/);
  });

  it('keeps no second factory function for it', () => {
    const src = readFileSync(join(SRC, 'telephony', 'voice-ai.service.ts'), 'utf8');
    // `createDeepgramWs()` had no callers and a comment claiming one.
    expect(src).not.toMatch(/^\s*createDeepgramWs\s*\(\s*\)\s*:/m);
    expect(src).toMatch(/createDeepgramWsForOrg/);
  });

  describe('the model', () => {
    const saved = process.env.DEEPGRAM_MODEL;
    afterEach(() => {
      if (saved === undefined) delete process.env.DEEPGRAM_MODEL;
      else process.env.DEEPGRAM_MODEL = saved;
    });

    it('defaults to the model this platform has always used', () => {
      // Deliberately NOT moved to nova-3. It is more accurate and Deepgram
      // recommends it, but changing which speech model hears every citizen is
      // a decision that wants evidence on Nigerian English — not a default
      // flipped while fixing something else.
      delete process.env.DEEPGRAM_MODEL;
      expect(deepgramModel()).toBe('nova-2');
    });

    it('takes an override, so nova-3 can be tried without a deploy', () => {
      process.env.DEEPGRAM_MODEL = 'nova-3';
      expect(deepgramModel()).toBe('nova-3');
    });

    it('ignores a malformed override rather than corrupting the query string', () => {
      for (const bad of ['', '  ', 'no', 'has space', 'has/slash', 'x'.repeat(100), 'a&b=c']) {
        process.env.DEEPGRAM_MODEL = bad;
        expect(deepgramModel()).toBe('nova-2');
      }
    });
  });
});
