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

// ── Resampling to the telephone rate ──────────────────────────────────────
//
// Every engine that cannot produce 8 kHz itself (Spitch and YarnGPT return
// 24 kHz WAV, OpenAI 24 kHz PCM) is resampled here. The filter decides how
// the assistant SOUNDS on a call, so it is a real low-pass, not an average:
//
//   - passband flat to 3.4 kHz, the top of the telephone band, so "s", "f",
//     "t" and "th" survive. The 3-tap average and the triangular window that
//     preceded this were -2.5 dB and -7.4 dB at 3.4 kHz: muffled speech.
//   - stopband below -70 dB from 4.4 kHz, so a 9 kHz sibilant does not fold
//     back onto 1 kHz as a metallic buzz (the triangle let it through at
//     -25 dB).
//
// A Kaiser-windowed sinc, tabulated once per input rate and interpolated, so a
// fractional ratio (22.05 / 44.1 kHz) costs the same as an integer one.

/** Top of the band we keep flat. */
export const PASSBAND_HZ = 3400;
/** Where the stopband starts; content between 4.0 and 4.4 kHz folds above 3.6 kHz, outside the telephone band. */
export const STOPBAND_HZ = 4400;
const STOPBAND_DB = 70;
const TABLE_STEPS = 512;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 50; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

interface Kernel {
  half: number;
  table: Float64Array;
}
const kernels = new Map<number, Kernel>();

/** The low-pass impulse response for input rate `rate`, sampled every 1/TABLE_STEPS input samples. */
function kernelFor(rate: number): Kernel {
  const hit = kernels.get(rate);
  if (hit) return hit;
  const nyquistOut = SAMPLE_RATE / 2;
  // An input slower than 8 kHz is being interpolated, not decimated: its own
  // Nyquist is the limit.
  const stop = Math.min(STOPBAND_HZ, rate / 2);
  const pass = Math.min(PASSBAND_HZ, stop * 0.8);
  const cutoff = Math.min((pass + stop) / 2, nyquistOut + 200) / rate; // cycles per input sample
  const transition = (stop - pass) / rate;
  const taps = Math.ceil((STOPBAND_DB - 8) / (2.285 * 2 * Math.PI * transition));
  const half = Math.ceil(taps / 2);
  const beta = 0.1102 * (STOPBAND_DB - 8.7);
  const i0b = besselI0(beta);
  const n = half * TABLE_STEPS;
  const table = new Float64Array(n + 2);
  for (let j = 0; j <= n + 1; j++) {
    const d = j / TABLE_STEPS;
    if (d > half) {
      table[j] = 0;
      continue;
    }
    const x = 2 * cutoff * d;
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = d / half;
    table[j] = 2 * cutoff * sinc * (besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / i0b);
  }
  const k = { half, table };
  kernels.set(rate, k);
  return k;
}

/** Build the filters for the rates the engines use, at start-up rather than inside a live call. */
export function warmResampler(rates: number[] = [16000, 22050, 24000, 44100, 48000]): void {
  for (const r of rates) kernelFor(r);
}

function tap(k: Kernel, d: number): number {
  const pos = Math.abs(d) * TABLE_STEPS;
  const j = Math.floor(pos);
  if (j >= k.table.length - 1) return 0;
  const f = pos - j;
  return k.table[j] * (1 - f) + k.table[j + 1] * f;
}

/** Mono samples at `rate` → slin16 at 8 kHz, band-limited for the telephone. */
export function resampleTo8k(mono: ArrayLike<number>, rate: number): Buffer {
  // Typed arrays throughout, never Buffer.readInt16LE/writeInt16LE per sample:
  // this runs on the call's event loop, so its cost is time the 20 ms
  // playback clock waits.
  const inFrames = mono.length;
  if (rate === SAMPLE_RATE) {
    const out = new Int16Array(inFrames);
    for (let i = 0; i < inFrames; i++) out[i] = clamp16(mono[i]);
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  }
  const ratio = rate / SAMPLE_RATE;
  const outFrames = Math.max(1, Math.floor(inFrames / ratio));
  const out = new Int16Array(outFrames);
  const k = kernelFor(rate);
  if (Number.isInteger(ratio)) {
    // 24/16/48 kHz: every output sample sits exactly on an input sample, so
    // one set of weights serves them all — no table interpolation.
    const half = k.half;
    const w = new Float64Array(2 * half + 1);
    for (let d = -half; d <= half; d++) w[d + half] = tap(k, d);
    let full = 0;
    for (let j = 0; j < w.length; j++) full += w[j];
    for (let i = 0; i < outFrames; i++) {
      const t = i * ratio;
      const lo = t - half;
      const hi = t + half;
      let acc = 0;
      if (lo >= 0 && hi < inFrames) {
        for (let j = 0, s = lo; s <= hi; j++, s++) acc += mono[s] * w[j];
        out[i] = clamp16(acc / full);
      } else {
        let wSum = 0;
        for (let s = Math.max(0, lo); s <= Math.min(inFrames - 1, hi); s++) {
          const x = w[s - lo];
          acc += mono[s] * x;
          wSum += x;
        }
        out[i] = clamp16(wSum > 0 ? acc / wSum : 0);
      }
    }
    return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  }
  for (let i = 0; i < outFrames; i++) {
    const t = i * ratio;
    const start = Math.max(0, Math.ceil(t - k.half));
    const end = Math.min(inFrames - 1, Math.floor(t + k.half));
    let acc = 0;
    let wSum = 0;
    for (let s = start; s <= end; s++) {
      const w = tap(k, t - s);
      acc += mono[s] * w;
      wSum += w;
    }
    // Normalised by the weights actually used, so DC is exact everywhere,
    // including the first and last few milliseconds of a clip.
    out[i] = clamp16(wSum > 0 ? acc / wSum : 0);
  }
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

/** 24 kHz 16-bit mono PCM (OpenAI TTS `response_format: 'pcm'`) → slin16/8000. */
export function downsample24kTo8k(pcm24k: Buffer): Buffer {
  const n = Math.floor(pcm24k.length / 2);
  const samples = new Int16Array(n);
  Buffer.from(samples.buffer).set(pcm24k.subarray(0, n * 2));
  return resampleTo8k(Float64Array.from(samples), 24000);
}

/**
 * Decode a WAV buffer (PCM 8/16/24/32-bit or IEEE float, any rate, any channel
 * count — Spitch and YarnGPT both answer `format: "wav"`) to slin16/8000.
 *
 * A streamed WAV may carry a data size of 0 or 0xFFFFFFFF because the length
 * was unknown when the header was written; that means "to the end of the
 * file", not "no audio" — reading it as no audio failed the call over.
 */
export function wavToSlin8k(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    const head = wav.subarray(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    throw new Error(`Invalid WAV buffer (${wav.length} bytes, starts "${head}")`);
  }
  let format = 1;
  let channels = 1;
  let sampleRate = SAMPLE_RATE;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (chunkId === 'fmt ' && bodyStart + 16 <= wav.length) {
      format = wav.readUInt16LE(bodyStart);
      channels = wav.readUInt16LE(bodyStart + 2);
      sampleRate = wav.readUInt32LE(bodyStart + 4);
      bitsPerSample = wav.readUInt16LE(bodyStart + 14);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format GUID's first two bytes.
      if (format === 0xfffe && chunkSize >= 26 && bodyStart + 26 <= wav.length) format = wav.readUInt16LE(bodyStart + 24);
    } else if (chunkId === 'data') {
      dataOffset = bodyStart;
      const rest = wav.length - bodyStart;
      dataLength = chunkSize === 0 || chunkSize === 0xffffffff ? rest : Math.min(chunkSize, rest);
      break;
    }
    offset = bodyStart + chunkSize + (chunkSize & 1);
  }

  if (dataOffset < 0 || dataLength <= 0) throw new Error('WAV missing data chunk');
  if (!channels || !sampleRate) throw new Error('WAV header has no channels or sample rate');
  const bytes = bitsPerSample / 8;
  const read: ((pos: number) => number) | null =
    format === 3 && bitsPerSample === 32
      ? (p) => wav.readFloatLE(p) * 32767
      : format === 1 && bitsPerSample === 16
        ? (p) => wav.readInt16LE(p)
        : format === 1 && bitsPerSample === 24
          ? (p) => wav.readIntLE(p, 3) / 256
          : format === 1 && bitsPerSample === 32
            ? (p) => wav.readInt32LE(p) / 65536
            : format === 1 && bitsPerSample === 8
              ? (p) => (wav[p] - 128) * 256
              : null;
  if (!read) throw new Error(`Unsupported WAV encoding: format ${format}, ${bitsPerSample}-bit`);

  const frameSize = channels * bytes;
  const inFrames = Math.floor(dataLength / frameSize);
  const mono = new Float64Array(inFrames);
  if (format === 1 && bitsPerSample === 16) {
    // The common case (Spitch, YarnGPT): one aligned copy, read as Int16Array.
    const samples = new Int16Array(inFrames * channels);
    Buffer.from(samples.buffer).set(wav.subarray(dataOffset, dataOffset + inFrames * frameSize));
    for (let i = 0; i < inFrames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += samples[i * channels + c];
      mono[i] = sum / channels;
    }
    return resampleTo8k(mono, sampleRate);
  }
  for (let i = 0; i < inFrames; i++) {
    let sum = 0;
    const base = dataOffset + i * frameSize;
    for (let c = 0; c < channels; c++) sum += read(base + c * bytes);
    mono[i] = sum / channels;
  }
  return resampleTo8k(mono, sampleRate);
}

// ── Clip edges ────────────────────────────────────────────────────────────
//
// Each sentence is synthesised on its own, so each clip's edges are heard:
// an engine's padding becomes a long gap between sentences, and a clip that
// starts or stops away from zero clicks. `forPlayback` evens both out.

/** Below this a sample is silence (about -46 dBFS). */
const SILENCE_LEVEL = 160;
const KEEP_LEAD_MS = 30;
const KEEP_TRAIL_MS = 220;
const FADE_MS = 5;

/** Trim a clip's leading/trailing silence to a fixed short pad and fade its edges. */
export function forPlayback(slin: Buffer): Buffer {
  const n = Math.floor(slin.length / 2);
  if (!n) return slin;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(slin.readInt16LE(i * 2)) > SILENCE_LEVEL) {
      first = i;
      break;
    }
  }
  if (first < 0) return slin; // all quiet: leave it as it is (a deliberate pause)
  for (let i = n - 1; i >= first; i--) {
    if (Math.abs(slin.readInt16LE(i * 2)) > SILENCE_LEVEL) {
      last = i;
      break;
    }
  }
  const lead = Math.round((SAMPLE_RATE * KEEP_LEAD_MS) / 1000);
  const trail = Math.round((SAMPLE_RATE * KEEP_TRAIL_MS) / 1000);
  const from = Math.max(0, first - lead);
  const to = Math.min(n, last + 1 + trail);
  const out = Buffer.from(slin.subarray(from * 2, to * 2));
  const m = to - from;
  const fade = Math.min(Math.round((SAMPLE_RATE * FADE_MS) / 1000), Math.floor(m / 2));
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * g), i * 2);
    const j = m - 1 - i;
    out.writeInt16LE(Math.round(out.readInt16LE(j * 2) * g), j * 2);
  }
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
        const pos = i * 2;
        out.writeInt16LE(l && pos + 2 <= l.length ? l.readInt16LE(pos) : 0, o);
        out.writeInt16LE(r && pos + 2 <= r.length ? r.readInt16LE(pos) : 0, o + 2);
      }
    }
    return wavFile(out, 2);
  }
}
