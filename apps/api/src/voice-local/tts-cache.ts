import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Synthesised speech kept on the server's SSD, so a phrase said before is
 * played from disk (a few milliseconds) instead of synthesised again (hundreds
 * of milliseconds, and a provider charge).
 *
 * Keyed by everything that changes the sound — engine, voice, style, format and
 * the exact text — so a voice or speed change can never replay stale audio.
 * Written to a temp file and renamed, so a crash or two calls racing for the
 * same phrase can never leave a half-written clip that plays as a truncated
 * sentence. Bounded: past `maxBytes` the least recently used clips go.
 *
 * WHAT IS NOT CACHED is decided by the caller (`isCacheable` in tts.ts): a
 * sentence carrying a number or the caller's name is personal data, and audio
 * of it does not belong on disk past the call.
 */
export class TtsCache {
  private writesSinceSweep = 0;

  constructor(
    private readonly dir: string,
    private readonly maxBytes = 2 * 1024 * 1024 * 1024,
  ) {}

  static keyOf(parts: Record<string, string | number>, text: string): string {
    return createHash('sha256').update(JSON.stringify({ ...parts, text })).digest('hex');
  }

  private fileFor(key: string): string {
    return path.join(this.dir, key.slice(0, 2), `${key}.pcm`);
  }

  get(key: string): Buffer | null {
    const file = this.fileFor(key);
    try {
      const bytes = fs.readFileSync(file);
      // Touch, so eviction keeps what is actually being played.
      const now = new Date();
      fs.utimesSync(file, now, now);
      return bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  put(key: string, audio: Buffer): void {
    if (!audio.length) return;
    const file = this.fileFor(key);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, audio);
      fs.renameSync(tmp, file);
    } catch {
      return; // a full or read-only disk costs speed, never the call
    }
    if (++this.writesSinceSweep >= 200) {
      this.writesSinceSweep = 0;
      this.sweep();
    }
  }

  /** Evict least-recently-used clips until under the limit. Returns bytes freed. */
  sweep(): number {
    const entries: Array<{ file: string; size: number; at: number }> = [];
    let total = 0;
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(this.dir);
    } catch {
      return 0;
    }
    for (const d of dirs) {
      const sub = path.join(this.dir, d);
      let files: string[] = [];
      try {
        files = fs.readdirSync(sub);
      } catch {
        continue;
      }
      for (const f of files) {
        const file = path.join(sub, f);
        try {
          const st = fs.statSync(file);
          if (f.endsWith('.tmp') && Date.now() - st.mtimeMs > 60_000) {
            fs.unlinkSync(file);
            continue;
          }
          entries.push({ file, size: st.size, at: st.mtimeMs });
          total += st.size;
        } catch {
          /* gone already */
        }
      }
    }
    let freed = 0;
    entries.sort((a, b) => a.at - b.at);
    for (const e of entries) {
      if (total - freed <= this.maxBytes) break;
      try {
        fs.unlinkSync(e.file);
        freed += e.size;
      } catch {
        /* ignore */
      }
    }
    return freed;
  }
}
