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
 */
export interface Pronunciation {
  /** The word as written (matched as a whole word, any capitalisation). */
  written: string;
  /** What the voice is given to read instead. */
  say: string;
  /** Who confirmed it by ear, and when. */
  confirmed: string;
}

export const PRONUNCIATIONS: Pronunciation[] = [];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `text` with every listed word replaced by its spoken spelling. */
export function pronounced(text: string, table: Pronunciation[] = PRONUNCIATIONS): string {
  let out = text;
  for (const p of table) {
    if (!p.written.trim() || !p.say.trim()) continue;
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}'])${escape(p.written)}(?![\\p{L}\\p{N}'])`, 'giu'), p.say);
  }
  return out;
}
