/**
 * Say an official's honours the way they are written, on a phone line.
 *
 * Names in the State's directory carry letters after them — "Rt. Hon. Joyce
 * Lohya Ramnap, mni", "Edward Pwajok SAN", "Gyang Buba, CFR", "Olivia Dazyem
 * Esq". Callers heard the names without them: the agent paraphrases what a
 * lookup returns and dropped the letters, and a lower-case "mni" handed to the
 * voice is read as a syllable, or not at all. The agency asked that every
 * title be called out.
 *
 * So the text the agent reads is made speakable BEFORE it reaches the model:
 * a post-nominal is spelled out letter by letter ("M N I", "S A N"), and "Esq"
 * becomes "Esquire". The prompt rule (agentPromptFor) then tells the agent to
 * say a name exactly as given, titles before and honours after, never
 * shortened.
 *
 * Deliberately narrow. Only listed honours are touched, and only where one
 * follows a name (after a comma, or straight after a capitalised word), so
 * "CON" in "CONTACT" or a "JP" in a sentence about Jos Plateau are left alone.
 */

/** Nigerian national honours, professional fellowships and service marks seen on officials. */
const POST_NOMINALS = [
  // National honours
  'GCFR', 'GCON', 'CFR', 'CON', 'OFR', 'OON', 'MFR', 'MON',
  // Institutes and service colleges
  'mni', 'MNI', 'psc', 'fwc', 'fdc', 'ndc', 'NPOM',
  // Law and professional bodies
  'SAN', 'FCA', 'ACA', 'FCCA', 'FCIB', 'FNIM', 'FNSE', 'FNIA', 'FCIArb', 'FCIS', 'FNIPR',
  // Others
  'KSM', 'KSJ', 'JP', 'PhD', 'Ph.D', 'Ph.D.',
];

/** How one honour is said. */
function spoken(token: string): string {
  if (/^Ph\.?D\.?$/.test(token)) return 'P H D';
  return token.replace(/[^A-Za-z]/g, '').toUpperCase().split('').join(' ');
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Longest first, so "Ph.D." wins over "Ph.D" and "GCON" over "CON".
const ALTERNATION = [...POST_NOMINALS].sort((a, b) => b.length - a.length).map(escape).join('|');

/**
 * After a comma (", mni") or straight after a capitalised word ("Pwajok SAN"),
 * and followed by the end, whitespace or punctuation — never inside a word.
 */
const HONOUR = new RegExp(
  `(,\\s*|(?<=\\b[A-Z][A-Za-z'\\-]+)\\s+)(${ALTERNATION})(?=$|[\\s,;:)(]|\\.(?:\\s|$))`,
  'g'
);
/** "Esq" / "Esq." after a name is read as the word, not the letters. */
const ESQUIRE = /(?<=\b[A-Z][A-Za-z'\-]+,?\s+)Esq\.?(?=$|[\s,;:)(])/g;

/** Make the honours in `text` speakable; everything else is left exactly as written. */
export function speakableHonours(text: string): string {
  return text
    .replace(ESQUIRE, 'Esquire')
    .replace(HONOUR, (_m, lead: string, honour: string) => `${lead}${spoken(honour)}`);
}
