/**
 * Asterisk's AudioSocket protocol (app_audiosocket / res_audiosocket).
 *
 * A plain TCP stream of frames: 1 byte kind, 2 bytes big-endian length, then
 * the payload. Asterisk sends the call's UUID first, then audio. Audio both
 * ways is signed linear 16-bit, 8 kHz, mono, little-endian — 320 bytes per
 * 20 ms frame — which is exactly what Deepgram is told it receives and what
 * Azure is asked to produce, so no transcoding happens anywhere on the path.
 */
export const KIND = {
  HANGUP: 0x00,
  UUID: 0x01,
  DTMF: 0x03,
  AUDIO: 0x10,
  ERROR: 0xff,
} as const;

export const SAMPLE_RATE = 8000;
/** 20 ms of slin16 at 8 kHz. Asterisk sends this size, and expects it back. */
export const FRAME_BYTES = 320;
export const FRAME_MS = 20;
/** The protocol's own ceiling: a 16-bit length. */
const MAX_PAYLOAD = 0xffff;

export interface Frame {
  kind: number;
  payload: Buffer;
}

export function encodeFrame(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  if (payload.length > MAX_PAYLOAD) throw new Error(`AudioSocket payload too large: ${payload.length}`);
  const head = Buffer.alloc(3);
  head[0] = kind;
  head.writeUInt16BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

/** Reassembles frames from TCP chunks, which split and merge them freely. */
export class FrameReader {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Frame[] = [];
    while (this.pending.length >= 3) {
      const len = this.pending.readUInt16BE(1);
      if (this.pending.length < 3 + len) break;
      out.push({ kind: this.pending[0], payload: Buffer.from(this.pending.subarray(3, 3 + len)) });
      this.pending = this.pending.subarray(3 + len);
    }
    return out;
  }
}

/** The 16-byte UUID payload, in the dashed form the dialplan generated. */
export function uuidFromPayload(payload: Buffer): string {
  const h = payload.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function uuidToPayload(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}
