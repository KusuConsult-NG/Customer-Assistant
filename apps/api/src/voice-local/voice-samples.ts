/**
 * Hear one sentence in every Spitch voice, to choose the line's voices by ear.
 * Run on the server, where the voice key is, with no calls in progress (it
 * uses the same Spitch account as live calls):
 *
 *   node apps/api/dist/voice-local/voice-samples.js
 *   node apps/api/dist/voice-local/voice-samples.js "Your own sentence." --voices amina,aliyu,jude
 *
 * Each voice says the sentence at the line's speed (SPITCH_SPEED), with the
 * line's pronunciations applied (pronounce.ts and LOCAL_VOICE_PRONOUNCE), at
 * telephone quality: what a caller would hear. The clips are kept in the
 * server's own file store and a link to each (valid 12 hours) is printed. A
 * voice Spitch refuses for English is listed with its refusal, not skipped.
 *
 * Nothing on a live call changes. The chosen voices are then set in
 * server.env: SPITCH_VOICE for the male assistants, SPITCH_FEMALE_VOICE for
 * the female ones, and the api restarted.
 */
import { CALL_RECORDING_BUCKET, signedUrl, uploadObject } from '../common/object-storage';
import { wavFile } from './pcm';
import { pronounced } from './pronounce';
import { resetSpitchCircuit, SpitchTts, speedFromEnv, type SpeechEngine } from './tts';

/** Every voice the official Spitch SDK lists for speech (spitch@1.51.0, SpeechGenerateParams.voice). */
export const SPITCH_VOICES = [
  'sade', 'segun', 'femi', 'funmi', 'amina', 'aliyu', 'hasan', 'zainab', 'john', 'jude', 'lina', 'lucy', 'henry', 'kani',
  'remi', 'kingsley', 'ngozi', 'amara', 'obinna', 'ebuka', 'hana', 'haile', 'tena', 'tesfaye', 'ufoma', 'tega', 'justice', 'boma',
] as const;

export const SAMPLE_SENTENCE =
  'Good afternoon, and thank you for calling the Plateau State Government Citizen Contact Centre. ' +
  'Please, which Local Government Area of Plateau State are you calling from?';

const LINK_SECONDS = 12 * 3600;

export interface SampleRequest {
  sentence: string;
  voices: string[];
}

/** `["Sentence."] [--voices a,b]` → what to render. Unknown voice names are refused. */
export function parseSampleArgs(argv: string[]): SampleRequest {
  const args = [...argv];
  let voices: string[] = [...SPITCH_VOICES];
  const at = args.indexOf('--voices');
  if (at >= 0) {
    voices = (args[at + 1] ?? '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    args.splice(at, 2);
    const unknown = voices.filter((v) => !(SPITCH_VOICES as readonly string[]).includes(v));
    if (unknown.length) throw new Error(`Not a Spitch voice: ${unknown.join(', ')}. The voices are: ${SPITCH_VOICES.join(', ')}.`);
    if (!voices.length) throw new Error('--voices needs a comma-separated list, e.g. --voices amina,jude');
  }
  const sentence = args.join(' ').trim() || SAMPLE_SENTENCE;
  return { sentence, voices };
}

/** Render the sentence in each voice, one at a time, and return a link or the refusal for each. */
export async function renderVoiceSamples(
  req: SampleRequest,
  engineFor: (voice: string) => SpeechEngine,
  store: { upload: (name: string, wav: Buffer) => Promise<string>; link: (path: string) => Promise<string> },
): Promise<Array<{ voice: string; link?: string; refused?: string }>> {
  const text = pronounced(req.sentence);
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
  const out: Array<{ voice: string; link?: string; refused?: string }> = [];
  for (const voice of req.voices) {
    // A few voices refusing English must not trip the breaker that live calls
    // use to fail fast, and mark every voice after them refused.
    resetSpitchCircuit();
    try {
      const pcm = await engineFor(voice).synthesize(text);
      const path = await store.upload(`${stamp}-voice-${voice}.wav`, wavFile(pcm));
      out.push({ voice, link: await store.link(path) });
    } catch (err: any) {
      out.push({ voice, refused: String(err?.message ?? err).slice(0, 160) });
    }
  }
  return out;
}

async function main() {
  const req = parseSampleArgs(process.argv.slice(2));
  const key = process.env.SPITCH_API_KEY?.trim();
  if (!key) throw new Error('SPITCH_API_KEY is not set on this server.');
  const speed = speedFromEnv('SPITCH_SPEED');
  const samples = await renderVoiceSamples(
    req,
    (voice) => new SpitchTts({ key, voice, language: process.env.SPITCH_LANGUAGE?.trim() || undefined, speed }),
    {
      upload: (name, wav) => uploadObject(CALL_RECORDING_BUCKET, 'voice-samples', name, wav, 'audio/wav'),
      link: (path) => signedUrl(CALL_RECORDING_BUCKET, path, LINK_SECONDS),
    },
  );
  console.log(`"${req.sentence}"\nNow on the line: SPITCH_VOICE=${process.env.SPITCH_VOICE || 'jude'}, SPITCH_FEMALE_VOICE=${process.env.SPITCH_FEMALE_VOICE || 'lucy'}. Open each link to listen (valid 12 hours):\n`);
  for (const s of samples) console.log(`  ${s.voice.padEnd(10)} ${s.link ?? `not available in English: ${s.refused}`}`);
  console.log('\nThen set the ones you choose in server.env (SPITCH_VOICE for male assistants, SPITCH_FEMALE_VOICE for female) and restart the api.');
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
