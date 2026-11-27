/**
 * Hear how the line's own voices say a word, spelled several ways, before one
 * is chosen. Run on the server, where the voice key is:
 *
 *   node apps/api/dist/voice-local/pronunciation-takes.js Plateau "Plah-toe" "Plah toe"
 *   node apps/api/dist/voice-local/pronunciation-takes.js Gyel "Jel" --sentence "You are in {word} B ward."
 *
 * For each of the line's voices (the male and the female Spitch voice) it
 * renders the sentence with the word as written and with each spelling, keeps
 * the clips as telephone-quality WAV files in the server's own file store, and
 * prints a link to each (valid 12 hours) to open on a phone or laptop.
 *
 * Nothing on a live call changes. The chosen spelling is then set in
 * server.env as LOCAL_VOICE_PRONOUNCE="Word=Spelling" (pronounce.ts) and the
 * api restarted.
 */
import { CALL_RECORDING_BUCKET, signedUrl, uploadObject } from '../common/object-storage';
import { wavFile } from './pcm';
import { assistantTtsFromEnv, type SpeechEngine } from './tts';

export const DEFAULT_SENTENCE = 'Thank you for calling the {word} State Government Citizen Contact Centre.';
const LINK_SECONDS = 12 * 3600;

export interface TakeRequest {
  word: string;
  spellings: string[];
  sentence: string;
}

/** `Plateau "Plah-toe" "Plah toe" --sentence "…{word}…"` → what to render. Throws on a bad request. */
export function parseTakeArgs(argv: string[]): TakeRequest {
  const args = [...argv];
  let sentence = DEFAULT_SENTENCE;
  const at = args.indexOf('--sentence');
  if (at >= 0) {
    sentence = args[at + 1] ?? '';
    args.splice(at, 2);
  }
  const [word, ...spellings] = args.map((a) => a.trim()).filter(Boolean);
  if (!word || !spellings.length) {
    throw new Error('Usage: node apps/api/dist/voice-local/pronunciation-takes.js <word> <spelling> [spelling…] [--sentence "…{word}…"]');
  }
  if (!sentence.includes('{word}')) throw new Error('The --sentence must contain {word}, where the word is said.');
  return { word, spellings, sentence };
}

/** The texts to render: the word as written first, then each spelling. */
export function takeTexts(req: TakeRequest): Array<{ label: string; text: string }> {
  return [req.word, ...req.spellings].map((w, i) => ({
    label: i === 0 ? `as written: ${w}` : `spelled: ${w}`,
    text: req.sentence.split('{word}').join(w),
  }));
}

/** Render every take in every voice, store it, and return a listening link for each. */
export async function renderTakes(
  req: TakeRequest,
  voices: Array<{ name: string; engine: SpeechEngine }>,
  store: { upload: (name: string, wav: Buffer) => Promise<string>; link: (path: string) => Promise<string> },
): Promise<Array<{ voice: string; label: string; link: string }>> {
  const out: Array<{ voice: string; label: string; link: string }> = [];
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  for (const v of voices) {
    for (const [i, t] of takeTexts(req).entries()) {
      const pcm = await v.engine.synthesize(t.text);
      const path = await store.upload(`${stamp}-${v.name}-${i}.wav`, wavFile(pcm));
      out.push({ voice: v.name, label: t.label, link: await store.link(path) });
    }
  }
  return out;
}

async function main() {
  const req = parseTakeArgs(process.argv.slice(2));
  const voices: Array<{ name: string; engine: SpeechEngine }> = [];
  for (const gender of ['male', 'female'] as const) {
    const engine = assistantTtsFromEnv(gender);
    if (!engine) continue;
    const name = `${engine.name}-${(engine as any).voice ?? gender}`;
    if (!voices.some((v) => v.name === name)) voices.push({ name, engine });
  }
  if (!voices.length) throw new Error('No voice is configured on this server (LOCAL_VOICE_TTS_PROVIDER and its key).');
  const takes = await renderTakes(req, voices, {
    upload: (name, wav) => uploadObject(CALL_RECORDING_BUCKET, 'pronunciation-takes', name, wav, 'audio/wav'),
    link: (path) => signedUrl(CALL_RECORDING_BUCKET, path, LINK_SECONDS),
  });
  console.log(`"${req.sentence.split('{word}').join(req.word)}" — open each link to listen (valid 12 hours):\n`);
  for (const t of takes) console.log(`  ${t.voice.padEnd(14)} ${t.label.padEnd(24)} ${t.link}`);
  console.log(`\nThen set the one that sounds right in server.env, e.g. LOCAL_VOICE_PRONOUNCE="${req.word}=${req.spellings[0]}", and restart the api.`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
