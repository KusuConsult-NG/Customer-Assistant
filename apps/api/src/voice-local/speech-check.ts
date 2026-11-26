/**
 * HEARING a synthesised clip before it is kept on disk.
 *
 * Spitch's voices sometimes read punctuation aloud. Measured on the server on
 * 26 Nov 2026: jude's saved recording notice ended "...our citizen support
 * system full stop", so every call replayed it, and fresh renders of the same
 * sentence said "comma". It is random (2 of 12 renders for jude, 1 for john,
 * 2 for henry; 0 for kingsley, daniel and lucy), it struck only the long
 * 155-character sentence, and it happened with the final "." removed too — so
 * deleting punctuation does not cure it and would cost every pause.
 *
 * A clip on disk is played on every later call, so one bad render is a fault
 * heard thousands of times. Every clip is therefore transcribed before it is
 * stored, and one that says a punctuation mark its text does not contain is not.
 */
import { wavFile } from './pcm';

/** Longest first, so "full stop" is counted once and not also as "full". */
const MARKS = [
  'exclamation mark',
  'exclamation point',
  'question mark',
  'full stop',
  'semicolon',
  'period',
  'comma',
  'colon',
  'full',
  'dot',
];

const words = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

function count(haystack: string, phrase: string): { n: number; rest: string } {
  const needle = ` ${phrase} `;
  let n = 0;
  let rest = haystack;
  let at: number;
  while ((at = rest.indexOf(needle)) !== -1) {
    n++;
    rest = `${rest.slice(0, at)} ${rest.slice(at + needle.length - 1)}`;
  }
  return { n, rest };
}

/**
 * The punctuation marks HEARD in a clip beyond those its text says in words,
 * in the order of `MARKS`, one entry per extra occurrence. "May I have your
 * full name?" heard as "...your full name" is clean; heard with "full stop"
 * appended it is not.
 */
export function spokenPunctuation(text: string, heard: string): string[] {
  let said = words(text);
  let got = words(heard);
  const extras: string[] = [];
  for (const mark of MARKS) {
    const inText = count(said, mark);
    const inHeard = count(got, mark);
    said = inText.rest;
    got = inHeard.rest;
    for (let i = inText.n; i < inHeard.n; i++) extras.push(mark);
  }
  return extras;
}

export type ClipVerdict = { ok: boolean; heard: string; extras: string[] };
/** Hears `audio` (8 kHz 16-bit mono, what every clip is stored as) against the text it was made from. Throws if it cannot hear it. */
export type ClipCheck = (text: string, audio: Buffer) => Promise<ClipVerdict>;

/** The check, done by Deepgram's pre-recorded API: the same key the line already transcribes callers with. */
export function deepgramClipCheck(key: string, fetchImpl: typeof fetch = fetch): ClipCheck {
  return async (text, audio) => {
    const res = await fetchImpl('https://api.deepgram.com/v1/listen?model=nova-2&punctuate=false&smart_format=false', {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
      body: wavFile(audio, 1, 8000),
      signal: AbortSignal.timeout(15_000),
    } as any);
    if (!res.ok) throw new Error(`Deepgram could not hear the clip (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 120)}`);
    const body: any = await res.json();
    const heard = String(body?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '');
    const extras = spokenPunctuation(text, heard);
    return { ok: extras.length === 0, heard, extras };
  };
}

/** The check for this server, or null when it has no Deepgram key (the line cannot hear callers either, then). */
export function clipCheckFromEnv(): ClipCheck | null {
  const key = process.env.DEEPGRAM_API_KEY?.trim();
  return key ? deepgramClipCheck(key) : null;
}
