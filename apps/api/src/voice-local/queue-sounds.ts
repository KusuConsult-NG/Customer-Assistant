/**
 * The waiting room's recordings (infra/sip-bridge extensions.conf [queue]),
 * spoken by the line's own assistant voice so a caller hears the same voice
 * before and after they are answered. Run on the server, where the voice key
 * is, once (and again whenever the wording or the voice changes):
 *
 *   cd /opt/customer-assistant/deploy/single-server
 *   for s in hold still callback later tone; do
 *     sudo docker compose --env-file server.env -f docker-compose.yml exec -T api node apps/api/dist/voice-local/queue-sounds.js $s > bridge/sounds/queue-$s.wav
 *   done
 *
 * Each sound is written to standard output as an 8 kHz, 16-bit mono WAV, the
 * format Asterisk plays without converting. Nothing else goes to standard
 * output, so the file is only the recording. The bridge reads them from
 * /opt/bridge/sounds (QUEUE_SOUNDS); a missing recording is replaced by one of
 * Asterisk's own English prompts, so the waiting room works before they exist.
 */
import { SAMPLE_RATE } from './audiosocket';
import { wavFile } from './pcm';
import { pronounced } from './pronounce';
import { assistantGenderFromEnv, assistantTtsFromEnv, type SpeechEngine } from './tts';

/** What each recording says. `hold` is the wording approved on 28 Nov 2026. */
export const QUEUE_TEXTS = {
  hold:
    'Thank you for calling the Plateau State Government Citizen Contact Centre. ' +
    'All our lines are busy at the moment. Please hold, and you will be answered shortly.',
  still: 'Thank you for holding. You are still in the queue, and you will be answered as soon as a line is free.',
  callback:
    'We are sorry, all our lines are still busy. ' +
    'A desk officer will call you back on the number you are calling from, as soon as a line is free. ' +
    'Thank you for calling. Goodbye.',
  later: 'We are sorry, all our lines are still busy. Please call again in a few minutes. Thank you for calling. Goodbye.',
} as const;

export type QueueSound = keyof typeof QUEUE_TEXTS | 'tone';
export const QUEUE_SOUNDS: QueueSound[] = ['hold', 'still', 'callback', 'later', 'tone'];

/**
 * The soft tone a waiting caller hears between checks, so the line never
 * sounds dead: a short 440 Hz pulse at about -26 dBFS with gentle edges, then
 * quiet, two seconds in all (the waiting room checks for a free line after
 * each one).
 */
export function holdTone(seconds = 2, pulseSeconds = 0.35, hz = 440): Buffer {
  const total = Math.round(seconds * SAMPLE_RATE);
  const pulse = Math.round(pulseSeconds * SAMPLE_RATE);
  const ramp = Math.round(0.05 * SAMPLE_RATE);
  const amp = 32767 * 0.05;
  const out = Buffer.alloc(total * 2);
  for (let i = 0; i < pulse; i++) {
    const edge = Math.min(1, i / ramp, (pulse - 1 - i) / ramp);
    out.writeInt16LE(Math.round(amp * edge * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)), i * 2);
  }
  return out;
}

/** One recording as a WAV: the tone generated here, the rest spoken by `engine`. */
export async function queueSound(name: QueueSound, engine: () => SpeechEngine | null): Promise<Buffer> {
  if (name === 'tone') return wavFile(holdTone());
  const text = QUEUE_TEXTS[name];
  if (!text) throw new Error(`Not a waiting-room sound: ${name}. They are: ${QUEUE_SOUNDS.join(', ')}.`);
  const e = engine();
  if (!e) throw new Error('No voice is configured on this server (SPITCH_API_KEY).');
  const pcm = await e.synthesize(pronounced(text));
  // Half a second of quiet after speech, so the next sound does not start on its last word.
  return wavFile(Buffer.concat([pcm, Buffer.alloc(Math.round(0.5 * SAMPLE_RATE) * 2)]));
}

async function main() {
  const name = (process.argv[2] ?? '').trim() as QueueSound;
  if (!QUEUE_SOUNDS.includes(name)) throw new Error(`Usage: queue-sounds.js ${QUEUE_SOUNDS.join(" or ")} (writes a WAV to standard output)`);
  const wav = await queueSound(name, () => assistantTtsFromEnv(assistantGenderFromEnv()));
  process.stdout.write(wav);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
