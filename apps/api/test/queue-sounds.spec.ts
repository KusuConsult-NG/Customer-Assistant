/**
 * The waiting room's recordings: the approved hold wording, spoken by the
 * line's own voice with its pronunciations, as WAVs Asterisk plays directly.
 */
import { pronounced } from '../src/voice-local/pronounce';
import { holdTone, queueSound, QUEUE_SOUNDS, QUEUE_TEXTS } from '../src/voice-local/queue-sounds';

const header = (wav: Buffer) => ({
  riff: wav.toString('ascii', 0, 4),
  wave: wav.toString('ascii', 8, 12),
  format: wav.readUInt16LE(20),
  channels: wav.readUInt16LE(22),
  rate: wav.readUInt32LE(24),
  bits: wav.readUInt16LE(34),
});
const PHONE_WAV = { riff: 'RIFF', wave: 'WAVE', format: 1, channels: 1, rate: 8000, bits: 16 };

describe('waiting-room sounds', () => {
  it('the hold message is the approved wording', () => {
    expect(QUEUE_TEXTS.hold).toBe(
      'Thank you for calling the Plateau State Government Citizen Contact Centre. All our lines are busy at the moment. Please hold, and you will be answered shortly.',
    );
  });

  it('only the callback message promises a call back, and every ending says goodbye', () => {
    expect(QUEUE_TEXTS.callback).toMatch(/call you back on the number you are calling from/);
    expect(QUEUE_TEXTS.later).not.toMatch(/call you back/);
    expect(QUEUE_TEXTS.later).toMatch(/call again/);
    for (const t of [QUEUE_TEXTS.callback, QUEUE_TEXTS.later]) expect(t).toMatch(/Goodbye\.$/);
  });

  it('speaks each message in the given voice, as an 8 kHz 16-bit mono WAV with quiet after it', async () => {
    const said: string[] = [];
    const engine = { name: 'fake', synthesize: async (t: string) => (said.push(t), Buffer.alloc(8000 * 2, 1)) };
    for (const name of ['hold', 'still', 'callback', 'later'] as const) {
      const wav = await queueSound(name, () => engine);
      expect(header(wav)).toEqual(PHONE_WAV);
      expect(wav.length).toBe(44 + 8000 * 2 + 4000 * 2); // 1 s of speech + 0.5 s quiet
      expect(wav.subarray(wav.length - 8000).every((b) => b === 0)).toBe(true);
    }
    expect(said).toHaveLength(4);
    // With the line's pronunciations, as every spoken sentence on a call.
    expect(said[0]).toBe(pronounced(QUEUE_TEXTS.hold));
    expect(said[0]).toMatch(/^Thank you for calling the Platoe State Government/);
  });

  it('refuses, rather than writing an empty file, when no voice is configured', async () => {
    await expect(queueSound('hold', () => null)).rejects.toThrow(/No voice is configured/);
    await expect(queueSound('nonsense' as any, () => null)).rejects.toThrow(/Not a waiting-room sound/);
  });

  it('the hold tone: two seconds, a soft pulse with no click at its edges, then quiet', async () => {
    const pcm = holdTone();
    expect(pcm.length).toBe(2 * 8000 * 2);
    const s = (i: number) => pcm.readInt16LE(i * 2);
    let peak = 0;
    for (let i = 0; i < 2800; i++) peak = Math.max(peak, Math.abs(s(i)));
    expect(peak).toBeGreaterThan(1000);
    expect(peak).toBeLessThanOrEqual(Math.round(32767 * 0.05)); // about -26 dBFS: soft
    expect(Math.abs(s(0))).toBe(0);
    expect(Math.abs(s(2799))).toBeLessThan(50);
    for (let i = 2800; i < 16000; i++) expect(s(i)).toBe(0);
    expect(header(await queueSound('tone', () => null))).toEqual(PHONE_WAV);
    expect(QUEUE_SOUNDS).toEqual(['hold', 'still', 'callback', 'later', 'tone']);
  });
});
