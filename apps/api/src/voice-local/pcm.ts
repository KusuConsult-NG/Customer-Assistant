/** Small, exact audio helpers for 8 kHz telephone audio. */
import { FRAME_BYTES, SAMPLE_RATE } from './audiosocket';

/** G.711 µ-law byte → 16-bit linear sample. */
export function mulawToLinear(u: number): number {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

/** µ-law/8000 (what ElevenLabs returns as `ulaw_8000`) → slin16/8000. */
export function mulawBufferToSlin(ulaw: Buffer): Buffer {
  const out = Buffer.alloc(ulaw.length * 2);
  for (let i = 0; i < ulaw.length; i++) out.writeInt16LE(mulawToLinear(ulaw[i]), i * 2);
  return out;
}

/** Split audio into 20 ms frames; the last is padded with silence. */
export function toFrames(slin: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < slin.length; i += FRAME_BYTES) {
    const f = slin.subarray(i, i + FRAME_BYTES);
    frames.push(f.length === FRAME_BYTES ? Buffer.from(f) : Buffer.concat([f, Buffer.alloc(FRAME_BYTES - f.length)]));
  }
  return frames;
}

export function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((SAMPLE_RATE * ms) / 1000) * 2);
}

/** Root-mean-square level of a slin16 frame, 0..32767. */
export function rms(slin: Buffer): number {
  let sum = 0;
  const n = Math.floor(slin.length / 2);
  for (let i = 0; i < n; i++) {
    const s = slin.readInt16LE(i * 2);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

/** A playable WAV of slin16 at `rate` with `channels` interleaved channels. */
export function wavFile(pcm: Buffer, channels = 1, rate = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/**
 * Both sides of a call as one stereo recording: caller on the left, the
 * assistant on the right, aligned on a shared 20 ms clock. Each side is a list
 * of [frameIndex, frame]; a frame index with nothing is silence.
 */
export class CallRecorder {
  private caller = new Map<number, Buffer>();
  private agent = new Map<number, Buffer>();
  private last = 0;
  /** ~20 minutes, past which a call stops being recorded rather than the server running out of memory. */
  static readonly MAX_FRAMES = 20 * 60 * 50;

  add(side: 'caller' | 'agent', index: number, frame: Buffer): void {
    if (index >= CallRecorder.MAX_FRAMES) return;
    (side === 'caller' ? this.caller : this.agent).set(index, frame);
    if (index > this.last) this.last = index;
  }

  get frames(): number {
    return this.caller.size + this.agent.size === 0 ? 0 : this.last + 1;
  }

  toWav(): Buffer {
    const frames = this.frames;
    const samples = FRAME_BYTES / 2;
    const out = Buffer.alloc(frames * samples * 4);
    for (let f = 0; f < frames; f++) {
      const l = this.caller.get(f);
      const r = this.agent.get(f);
      for (let i = 0; i < samples; i++) {
        const o = (f * samples + i) * 4;
        out.writeInt16LE(l ? l.readInt16LE(i * 2) : 0, o);
        out.writeInt16LE(r ? r.readInt16LE(i * 2) : 0, o + 2);
      }
    }
    return wavFile(out, 2);
  }
}
