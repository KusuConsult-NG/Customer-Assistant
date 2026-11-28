/**
 * Review the old ElevenLabs pronunciation dictionary in the line's own voice,
 * word by word, so each word the old line said right can be carried over once
 * a person has HEARD it. Run on the server (it needs the ElevenLabs key to
 * read the dictionary, and the Spitch key to speak):
 *
 *   node apps/api/dist/voice-local/pronunciation-review.js <agency-slug>
 *
 * For every word in the dictionary, and the words the line is known to get
 * wrong (KNOWN_TROUBLE), it renders a short sentence with the word as written
 * and with each candidate spelling: the dictionary's own spelling (an alias
 * rule) and any listed here. Words the line already respells (pronounce.ts and
 * LOCAL_VOICE_PRONOUNCE) are skipped. Only the voices that answer calls are
 * used (LOCAL_VOICE_ASSISTANT_GENDER). Each clip is stored in the server's own
 * file store with a link valid 12 hours, and the list is numbered so the
 * choices can be given back as "3b, 5 fine, 7 wrong".
 *
 * Nothing on a live call changes. A word is added to pronounce.ts only after
 * a person has confirmed it by ear.
 */
import { CALL_RECORDING_BUCKET, signedUrl, uploadObject } from '../common/object-storage';
import { pronunciationDictionaryLocatorsFromEnv } from '../agent-tools/agent-tool-catalog';
import { wavFile } from './pcm';
import { activePronunciations } from './pronounce';
import { parsePls, PLATEAU_DICTIONARY, type DictionaryRule } from './pronunciations-export';
import { assistantGenderFromEnv, assistantTtsFromEnv, type SpeechEngine } from './tts';

export const REVIEW_SENTENCE = 'Please confirm, is it {word}?';
const LINK_SECONDS = 12 * 3600;

/**
 * Words the line is known to say wrong, with spellings to try. "ward": Deepgram
 * heard the male voice's "ward" as "world" (edge check, 28 Nov 2026).
 */
export const KNOWN_TROUBLE: Array<{ word: string; spellings: string[]; sentence?: string }> = [
  { word: 'ward', spellings: ['wahd', 'wawd', 'wod'], sentence: 'Could you also tell me your {word} and community?' },
];

export interface ReviewItem {
  word: string;
  /** What the old dictionary said about it, for the person listening. */
  oldRule?: string;
  spellings: string[];
  sentence: string;
}

/**
 * The words to review: every dictionary word, then the known trouble words,
 * merged by word (any capitalisation), without those the line already respells.
 */
export function reviewItems(rules: DictionaryRule[], active: Array<{ written: string }>, extra = KNOWN_TROUBLE): ReviewItem[] {
  const done = new Set(active.map((p) => p.written.toLowerCase()));
  const items = new Map<string, ReviewItem>();
  const add = (word: string, spellings: string[], oldRule?: string, sentence = REVIEW_SENTENCE) => {
    const key = word.toLowerCase();
    if (!word.trim() || done.has(key)) return;
    const item = items.get(key) ?? { word, spellings: [], sentence, ...(oldRule ? { oldRule } : {}) };
    for (const s of spellings) if (s.trim() && s.toLowerCase() !== key && !item.spellings.includes(s)) item.spellings.push(s);
    if (sentence !== REVIEW_SENTENCE) item.sentence = sentence;
    items.set(key, item);
  };
  for (const r of rules) {
    const rule = r.alias !== undefined ? `said "${r.alias}"` : r.phoneme ? `${r.alphabet ?? 'phoneme'} /${r.phoneme}/` : undefined;
    for (const w of r.words) add(w, r.alias !== undefined ? [r.alias] : [], rule);
  }
  for (const t of extra) add(t.word, t.spellings, undefined, t.sentence);
  return [...items.values()];
}

/** "a", "b", … for the takes of one word: "a" is the word as written. */
const letter = (i: number) => String.fromCharCode(97 + i);

/** Render every take of every item in every voice; return the numbered review. */
export async function renderReview(
  items: ReviewItem[],
  voices: Array<{ name: string; engine: SpeechEngine }>,
  store: { upload: (name: string, wav: Buffer) => Promise<string>; link: (path: string) => Promise<string> },
): Promise<Array<{ n: number; word: string; oldRule?: string; takes: Array<{ id: string; voice: string; label: string; link?: string; failed?: string }> }>> {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const out = [];
  for (const [i, item] of items.entries()) {
    const n = i + 1;
    const takes = [];
    for (const v of voices) {
      for (const [j, w] of [item.word, ...item.spellings].entries()) {
        const id = `${n}${letter(j)}`;
        const label = j === 0 ? `as written: ${w}` : `spelled: ${w}`;
        try {
          const pcm = await v.engine.synthesize(item.sentence.split('{word}').join(w));
          const path = await store.upload(`${stamp}-${n}${letter(j)}-${v.name}.wav`, wavFile(pcm));
          takes.push({ id, voice: v.name, label, link: await store.link(path) });
        } catch (err: any) {
          takes.push({ id, voice: v.name, label, failed: String(err?.message ?? err).slice(0, 120) });
        }
      }
    }
    out.push({ n, word: item.word, ...(item.oldRule ? { oldRule: item.oldRule } : {}), takes });
  }
  return out;
}

async function dictionaryRules(slug: string): Promise<DictionaryRule[]> {
  const { prisma, decryptSecret } = await import('@ace/database');
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: org.id }, select: { apiKey: true } });
  const key = config?.apiKey ? decryptSecret(config.apiKey, `HostedAgentConfig.apiKey org=${org.id}`) : process.env.ELEVENLABS_API_KEY?.trim() ?? '';
  await prisma.$disconnect();
  if (!key) {
    console.log('No ElevenLabs key here: reviewing only the known trouble words.');
    return [];
  }
  const dict = pronunciationDictionaryLocatorsFromEnv()[0] ?? PLATEAU_DICTIONARY;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/pronunciation-dictionaries/${encodeURIComponent(dict.pronunciationDictionaryId)}/${encodeURIComponent(dict.versionId)}/download`,
    { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) {
    console.log(`ElevenLabs refused the dictionary (HTTP ${res.status}): reviewing only the known trouble words.`);
    return [];
  }
  return parsePls(await res.text());
}

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: node apps/api/dist/voice-local/pronunciation-review.js <agency-slug>');
    process.exit(2);
  }
  const only = assistantGenderFromEnv();
  const voices: Array<{ name: string; engine: SpeechEngine }> = [];
  for (const gender of (only ? [only] : ['male', 'female']) as Array<'male' | 'female'>) {
    const engine = assistantTtsFromEnv(gender);
    if (!engine) continue;
    const name = `${(engine as any).voice ?? engine.name}`;
    if (!voices.some((v) => v.name === name)) voices.push({ name, engine });
  }
  if (!voices.length) throw new Error('No voice is configured on this server.');
  const items = reviewItems(await dictionaryRules(slug), activePronunciations());
  console.log(`${items.length} words to review in ${voices.map((v) => v.name).join(', ')}. Open each link to listen (valid 12 hours):\n`);
  const review = await renderReview(items, voices, {
    upload: (name, wav) => uploadObject(CALL_RECORDING_BUCKET, 'pronunciation-review', name, wav, 'audio/wav'),
    link: (path) => signedUrl(CALL_RECORDING_BUCKET, path, LINK_SECONDS),
  });
  for (const r of review) {
    console.log(`${r.n}. ${r.word}${r.oldRule ? `   (old line: ${r.oldRule})` : ''}`);
    for (const t of r.takes) console.log(`   ${t.id.padEnd(4)} ${t.voice.padEnd(8)} ${t.label.padEnd(28)} ${t.link ?? `FAILED: ${t.failed}`}`);
  }
  console.log('\nReply with, for each word: "fine" (as written is right), the take that sounds right (e.g. "3b"), or "wrong" with how it should sound.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
