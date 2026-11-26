/**
 * Choosing the Governor's opening BY EAR.
 *
 * Spitch makes every take of a line differently. On 26 Nov 2026 the clip the
 * calls played dragged "Plateau", while another take of the same voice, same
 * spelling, same speed was what the agency wanted — and nothing a machine can
 * measure tells the two apart (both held the word 0.48–0.50 s). The pre-render
 * keeps whichever take it happened to make. This lets a person listen to
 * several and install the one that sounds right, as the clip every call plays.
 *
 *   node apps/api/dist/voice-local/governor-takes.js <slug> --render [4]
 *       writes <STORAGE_DIR>/governor-takes/<period>-<n>.wav: take 0 is the
 *       clip calls play now, 1..n are new takes (each heard for spoken
 *       punctuation first, like every clip). Nothing a call plays changes.
 *   node apps/api/dist/voice-local/governor-takes.js <slug> --use evening=2 morning=1
 *       installs those takes. Refused if the line's wording, voice or speed has
 *       changed since they were made: they would be stored under a key no call
 *       looks up, or play a sentence that is no longer the greeting.
 */
import * as fs from 'fs';
import * as path from 'path';
import { wavFile } from './pcm';
import { CachedSpeech } from './tts';
import { TtsCache } from './tts-cache';
import { clipCheckFromEnv } from './speech-check';
import { governorEngineFor, governorLines } from './prerender';

export const PERIODS = ['morning', 'afternoon', 'evening'] as const;
export type Period = (typeof PERIODS)[number];
const MANIFEST = 'takes.json';

export function periodOf(line: string): Period | null {
  const m = /^Good (morning|afternoon|evening)\b/i.exec(line.trim());
  return m ? (m[1].toLowerCase() as Period) : null;
}

/** One Governor line per time of day, or a reason it cannot be chosen this way. */
export function linesByPeriod(lines: string[]): Map<Period, string> {
  const out = new Map<Period, string>();
  for (const line of lines) {
    const p = periodOf(line);
    if (!p) throw new Error(`A Governor line does not start with "Good morning/afternoon/evening": "${line}"`);
    if (out.has(p)) {
      throw new Error(
        `There is more than one Governor line for the ${p} (the welcome names the assistant in his part, so each name is its own line). Takes are chosen per time of day, so this agency's greeting cannot be chosen this way.`,
      );
    }
    out.set(p, line);
  }
  return out;
}

/** The 8 kHz 16-bit mono samples of a take file this tool wrote. Anything else is refused, not converted. */
export function readTakeWav(buf: Buffer): Buffer {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let p = 12;
  let fmt: { format: number; ch: number; rate: number; bits: number } | null = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const len = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(p + 8), ch: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.ch !== 1 || fmt.rate !== 8000 || fmt.bits !== 16) {
        throw new Error(`expected 8 kHz 16-bit mono PCM, got ${JSON.stringify(fmt)}`);
      }
      const data = buf.subarray(p + 8, Math.min(buf.length, p + 8 + len));
      if (!data.length) throw new Error('the WAV holds no audio');
      return Buffer.from(data);
    }
    p += 8 + len + (len & 1);
  }
  throw new Error('the WAV has no data chunk');
}

type Manifest = Record<string, { line: string; key: string; takes: number }>;

export async function renderTakes(
  lines: string[],
  speech: CachedSpeech,
  dir: string,
  count: number,
  log: (m: string) => void = console.log,
): Promise<string[]> {
  const byPeriod = linesByPeriod(lines);
  fs.mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  const manifest: Manifest = {};
  for (const [period, line] of byPeriod) {
    const current = speech.peek(line);
    if (current) {
      fs.writeFileSync(path.join(dir, `${period}-0.wav`), wavFile(current, 1, 8000));
      written.push(`${period}-0.wav`);
    }
    let n = 0;
    for (let attempt = 0; n < count && attempt < count * 3; attempt++) {
      const { audio, verdict } = await speech.take(line);
      if (verdict && !verdict.ok) {
        log(`  ${period}: a take said "${verdict.extras.join('", "')}" aloud and was thrown away`);
        continue;
      }
      n++;
      fs.writeFileSync(path.join(dir, `${period}-${n}.wav`), wavFile(audio, 1, 8000));
      written.push(`${period}-${n}.wav`);
    }
    manifest[period] = { line, key: speech.key(line), takes: n };
  }
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  return written;
}

/** "evening=2" "morning=1" → choices. Take 0 means keep the clip calls play now. */
export function parseChoices(args: string[]): Map<Period, number> {
  const out = new Map<Period, number>();
  for (const a of args) {
    const m = /^(morning|afternoon|evening)=(\d+)$/.exec(a);
    if (!m) throw new Error(`"${a}" is not a choice: write it as evening=2`);
    out.set(m[1] as Period, Number(m[2]));
  }
  if (!out.size) throw new Error('No takes chosen: e.g. --use evening=2 morning=1 afternoon=3');
  return out;
}

export async function installTakes(
  choices: Map<Period, number>,
  lines: string[],
  speech: CachedSpeech,
  cache: TtsCache,
  dir: string,
): Promise<string[]> {
  const byPeriod = linesByPeriod(lines);
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    throw new Error(`No takes have been made yet (${path.join(dir, MANIFEST)} is missing): run with --render first.`);
  }
  // Check every choice before installing any, so a refusal changes nothing.
  const plan: Array<{ period: Period; take: number; line: string; audio: Buffer | null }> = [];
  for (const [period, take] of choices) {
    const line = byPeriod.get(period);
    const made = manifest[period];
    if (!line) throw new Error(`This agency has no ${period} Governor line.`);
    if (!made) throw new Error(`No ${period} takes were made: run --render again.`);
    if (made.line !== line || made.key !== speech.key(line)) {
      throw new Error(
        `The ${period} line's wording, voice or speed has changed since the takes were made, so take ${take} is not what calls would play. Run --render again and choose again.`,
      );
    }
    if (take === 0) {
      plan.push({ period, take, line, audio: null });
      continue;
    }
    if (take > made.takes) throw new Error(`There is no ${period} take ${take}: takes 1 to ${made.takes} were made.`);
    plan.push({ period, take, line, audio: readTakeWav(fs.readFileSync(path.join(dir, `${period}-${take}.wav`))) });
  }
  const done: string[] = [];
  for (const p of plan) {
    if (p.audio) speech.install(p.line, p.audio);
    done.push(p.audio ? `${p.period}: take ${p.take} installed` : `${p.period}: kept the clip calls play now`);
  }
  await cache.flush();
  return done;
}

export function takesDir(): string {
  return path.join(process.env.STORAGE_DIR?.trim() || process.cwd(), 'governor-takes');
}

async function main() {
  const [slug, mode, ...rest] = process.argv.slice(2);
  if (!slug || (mode !== '--render' && mode !== '--use')) {
    console.error('Usage: governor-takes.js <agency-slug> --render [count]   |   governor-takes.js <agency-slug> --use evening=2 morning=1');
    process.exit(2);
  }
  const { prisma } = await import('@ace/database');
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
  });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const cacheDir = process.env.VOICE_CACHE_DIR?.trim() || path.join(process.env.STORAGE_DIR?.trim() || process.cwd(), 'tts-cache');
  const cache = new TtsCache(cacheDir, Number(process.env.VOICE_CACHE_MAX_MB || 2048) * 1024 * 1024);
  const { engine, label } = await governorEngineFor(org.id);
  const speech = new CachedSpeech(engine as any, cache, clipCheckFromEnv());
  const lines = governorLines(org);
  const dir = takesDir();
  console.log(`Governor engine: ${label}`);
  if (mode === '--render') {
    const count = Math.min(8, Math.max(1, Number(rest[0]) || 4));
    const files = await renderTakes(lines, speech, dir, count);
    console.log(`\n${files.length} files in ${dir}:`);
    for (const f of files) console.log(`  ${f}${f.endsWith('-0.wav') ? '   (the clip calls play now)' : ''}`);
    console.log('\nListen, then install your choice, e.g.:  --use evening=2 morning=1 afternoon=3');
  } else {
    for (const d of await installTakes(parseChoices(rest), lines, speech, cache, dir)) console.log(`  ${d}`);
  }
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
