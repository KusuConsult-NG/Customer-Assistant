/**
 * How the local line's voice should SAY words it gets wrong.
 *
 * The ElevenLabs line had a pronunciation dictionary in its workspace
 * (Nanpan, Mutfwang, Plateau, Gyel, Rantya, Datong, PLASCHEMA, …); Spitch
 * takes no dictionary, no SSML and no phonemes (its SDK's speech parameters
 * are text, voice, language, format and speed), so words the old line said
 * right came out wrong on the new one. The only lever is the text itself: a
 * word is replaced by a spelling the voice reads the right way.
 *
 * Applied ONLY to what is sent to the voice for a reply. The caller's record,
 * the transcript and the model's history keep the real spelling, and the
 * opening is never respelled (it is the agency's approved recording and its
 * cached clips).
 *
 * Every entry must be one a person has LISTENED to on the line — a respelling
 * that looks right can sound worse. Add one with the word as written, the
 * spelling the voice should read, and who confirmed it by ear and when.
 * `node apps/api/dist/voice-local/pronunciations-export.js <slug>` prints the
 * old ElevenLabs dictionary's rules, the starting point for this table.
 *
 * Words can also be set on the server without a rebuild, in server.env:
 *   LOCAL_VOICE_PRONOUNCE="Plateau=Plah-toe; Gyel=Jel"
 * (an api restart applies it). `pronunciation-takes.js` renders candidate
 * spellings in the line's own voices and prints links to listen to them first.
 */
export interface Pronunciation {
  /** The word as written (matched as a whole word, any capitalisation). */
  written: string;
  /** What the voice is given to read instead. */
  say: string;
  /** Who confirmed it by ear, and when. */
  confirmed: string;
}

export const PRONUNCIATIONS: Pronunciation[] = [
  {
    written: 'PLASCHEMA',
    say: 'Plas-cheh-ma',
    confirmed:
      'Sound "PLAS-CHE-MA" given by the owner (Steven) after test call local-0a9bafd4, 27 Nov 2026 (Spitch said "plaschem"); ' +
      'same sound as the old ElevenLabs rule "PLAS-CHEH-MA". Permanent entry.',
  },
  {
    written: 'Plateau',
    say: 'Platoe',
    confirmed:
      'Confirmed by ear by the owner (Steven) on 27 Nov 2026 in both spitch-jude-3.wav and spitch-lucy-3.wav (Option 3: "Platoe"). Permanent entry.',
  },
  {
    written: 'Gyel',
    say: 'Gyell',
    confirmed:
      'Confirmed by ear by the owner (Steven) on 28 Nov 2026 from the pronunciation takes of "You are in Gyel B ward." (spelling "Gyell"; the ward is said "Gyell-B"). Permanent entry.',
  },
];

/** The code table with any word the server setting also lists replaced by the server's spelling. */
export function activePronunciations(): Pronunciation[] {
  const fromEnv = pronunciationsFromEnv();
  const overridden = new Set(fromEnv.map((p) => p.written.toLowerCase()));
  return [...PRONUNCIATIONS.filter((p) => !overridden.has(p.written.toLowerCase())), ...fromEnv];
}

let parsed: { raw: string; table: Pronunciation[] } | null = null;

/** `LOCAL_VOICE_PRONOUNCE` ("Word=Spelling; Other=Spelling"), parsed once per value. Malformed parts are skipped. */
export function pronunciationsFromEnv(raw = process.env.LOCAL_VOICE_PRONOUNCE ?? ''): Pronunciation[] {
  if (parsed && parsed.raw === raw) return parsed.table;
  const table: Pronunciation[] = [];
  for (const part of raw.split(/[;\n]/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const written = part.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const say = part.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!written || !say || written.length > 60 || say.length > 60) continue;
    table.push({ written, say, confirmed: 'server setting LOCAL_VOICE_PRONOUNCE' });
  }
  parsed = { raw, table };
  return table;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with every listed word replaced by its spoken spelling. */
export function pronounced(text: string, table: Pronunciation[] = activePronunciations()): string {
  let out = text;
  for (const p of table) {
    if (!p.written.trim() || !p.say.trim()) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}'])${escape(p.written)}(?![\\p{L}\\p{N}'])`, 'giu'), p.say);
  }
  return out;
}
