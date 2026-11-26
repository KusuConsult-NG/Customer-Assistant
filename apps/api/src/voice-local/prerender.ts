/**
 * Render every version of the Governor's opening in his cloned voice, and the
 * assistant's fixed sentences in each assistant voice, ahead of time onto the
 * server's disk, where the voice line plays them from. Run it again after any
 * change of voice or SPEED: both change every clip's key.
 *
 * The opening's Governor part varies by time of day (3) and by the assistant's
 * name (the Plateau roster), and his voice exists only at ElevenLabs. Without
 * this, a version is rendered the first time a caller needs it — and once the
 * ElevenLabs subscription ends, a version never heard before would be spoken
 * in the assistant's voice instead. Run it before cancelling, and again after
 * any change to the welcome message or the roster.
 *
 *   node apps/api/dist/voice-local/prerender.js <agency-slug>           report
 *   node apps/api/dist/voice-local/prerender.js <agency-slug> --apply   render what is missing
 *   ... --recheck   also HEAR every clip already on disk, and (with --apply) replace one that reads punctuation aloud
 *
 * Every clip rendered is heard by Deepgram before it is kept (speech-check.ts),
 * so DEEPGRAM_API_KEY is required.
 *
 * Needs DATABASE_URL, VOICE_CACHE_DIR (or STORAGE_DIR) and an ElevenLabs key
 * (the agency's own, else ELEVENLABS_API_KEY) — the same settings the API has.
 */
import * as path from 'path';
import { GOVERNOR_VOICE_ID, VOICE_MODEL_ID, VOICE_SETTINGS } from '../agent-tools/elevenlabs-contracts';
import {
  PLATEAU_FEMALE_NAMES,
  PLATEAU_MALE_NAMES,
  TEAM_PERSONAS,
  isPlateauStateOrg,
  openingForUnknownCaller,
  renderWelcome,
  resolvePersona,
  type AgentOrganization,
  type TeamPersona,
} from '../agent-tools/agent-tool-catalog';
import { assistantTtsFromEnv, CachedSpeech, ElevenLabsTts, SpitchTts, speedFromEnv, type SpeechEngine } from './tts';
import { TtsCache } from './tts-cache';
import { clipCheckFromEnv } from './speech-check';
import { WELCOME_DEFAULT } from '../agent-tools/caller-profile';
import { ACKS, HOLDING_LINE, openingSegments, openingSentences } from './voice-session';

/** A moment in each greeting period at the agency's clock (Lagos is UTC+1 with no DST). */
const SAMPLE_TIMES = ['2026-01-05T07:00:00Z', '2026-01-05T12:30:00Z', '2026-01-05T18:00:00Z'].map((t) => new Date(t));

/**
 * Every distinct Governor line a caller can hear, exactly as the voice line will speak it.
 *
 * With Spitch as the assistant's engine the voice line picks a FEMALE Plateau
 * name on half of all calls (LocalVoiceService.begin), and the Governor names
 * her. Rendering only the male roster left those 300 lines unrendered: each was
 * fetched live on the call, or — with no ElevenLabs key — spoken in the female
 * assistant's own voice in place of the Governor's.
 */
export function governorLines(org: AgentOrganization, includeFemale = assistantTtsFromEnv()?.name === 'spitch'): string[] {
  const named = (names: readonly string[], base: TeamPersona) =>
    names.map((name) => ({ ...base, id: name.toLowerCase(), name, greetingPhrase: `my name is ${name}` }));
  const personas: TeamPersona[] = isPlateauStateOrg(org)
    ? [
        ...named(PLATEAU_MALE_NAMES, TEAM_PERSONAS.nanpan),
        ...(includeFemale ? named(PLATEAU_FEMALE_NAMES, { ...TEAM_PERSONAS.sarah, gender: 'female' }) : []),
      ]
    : [resolvePersona(org.persona)];
  const lines = new Set<string>();
  for (const persona of personas) {
    for (const at of SAMPLE_TIMES) {
      for (const seg of openingSegments(renderWelcome(org, at, persona))) {
        if (seg.kind === 'governor') lines.add(seg.text);
      }
    }
  }
  return [...lines];
}

/**
 * The assistant's sentences that are the SAME on every call: the parts of the
 * opening that name nobody (the recording notice, "How may I help you
 * today?"), the acknowledgements and the holding line. Changing the speed
 * changes every clip's key, so each must be made again, and the 155-character
 * notice made live overran Spitch's time limit and failed every call over
 * until one happened to succeed. Rendered here, a call finds them on disk.
 *
 * A sentence carrying the assistant's name differs per call and is left out:
 * two sample personas with different names are rendered and only sentences
 * both share are kept.
 */
export function assistantStaticLines(org: AgentOrganization): string[] {
  const sample = (name: string): TeamPersona => ({ ...TEAM_PERSONAS.nanpan, id: name.toLowerCase(), name, greetingPhrase: `my name is ${name}` });
  const sentences = (persona: TeamPersona) => {
    const out = new Set<string>();
    for (const at of SAMPLE_TIMES) {
      const opening = openingForUnknownCaller(renderWelcome(org, at, persona)).replace(/\{\{\s*sip_welcome\s*\}\}/g, WELCOME_DEFAULT);
      for (const seg of openingSentences(opening)) if (seg.kind === 'assistant') out.add(seg.text);
    }
    return out;
  };
  const a = sentences(sample('Gwaman'));
  const b = sentences(sample('Chundung'));
  const shared = [...a].filter((t) => b.has(t) && !/\{\{|\{[a-z]+\}/.test(t));
  return [...new Set([...shared, WELCOME_DEFAULT, ...ACKS, HOLDING_LINE])];
}

export async function prerender(
  lines: string[],
  speech: CachedSpeech,
  cache: TtsCache,
  apply: boolean,
  log: (m: string) => void = console.log,
  opts: { recheck?: boolean } = {},
): Promise<{ present: number; rendered: number; replaced: number; failed: string[] }> {
  let present = 0;
  let rendered = 0;
  let replaced = 0;
  const failed: string[] = [];
  for (const line of lines) {
    let bad = false;
    if (cache.get(speech.key(line))) {
      if (!opts.recheck) {
        present++;
        continue;
      }
      // A clip saved before clips were heard may read punctuation aloud, and
      // is played on every call: hear it again.
      try {
        const verdict = await speech.recheck(line);
        if (!verdict || verdict.ok) {
          present++;
          continue;
        }
        bad = true;
        log(`  on disk, says "${verdict.extras.join('", "')}": ${line}`);
      } catch (err: any) {
        failed.push(`${line} — could not be heard: ${err?.message ?? err}`);
        continue;
      }
    }
    if (!apply) {
      if (!bad) log(`  missing: ${line}`);
      continue;
    }
    try {
      const r = await speech.renderChecked(line);
      if (r.ok) {
        if (bad) replaced++;
        else rendered++;
      } else {
        failed.push(`${line} — said "${r.last?.extras.join('", "')}" in all ${r.attempts} renders (heard: "${r.last?.heard}")`);
      }
    } catch (err: any) {
      failed.push(`${line} — ${err?.message ?? err}`);
    }
  }
  await cache.flush();
  return { present, rendered, replaced, failed };
}

async function main() {
  const slug = process.argv[2];
  const apply = process.argv.includes('--apply');
  const recheck = process.argv.includes('--recheck');
  if (!slug || slug.startsWith('--')) {
    console.error('Usage: node apps/api/dist/voice-local/prerender.js <agency-slug> [--apply] [--recheck]');
    process.exit(2);
  }
  const { prisma, decryptSecret } = await import('@ace/database');
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
  });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const lines = governorLines(org);
  const dir = process.env.VOICE_CACHE_DIR?.trim() || path.join(process.env.STORAGE_DIR?.trim() || process.cwd(), 'tts-cache');
  const cache = new TtsCache(dir, Number(process.env.VOICE_CACHE_MAX_MB || 2048) * 1024 * 1024);

  // 1. The assistant's fixed sentences, in every assistant voice the line uses.
  const assistantLines = assistantStaticLines(org);
  // Every clip is HEARD before it is kept: Spitch sometimes reads punctuation
  // aloud, and a clip on disk is played on every call (speech-check.ts).
  const check = clipCheckFromEnv();
  if (!check) {
    console.error('DEEPGRAM_API_KEY is not set: clips cannot be heard before they are kept, so nothing is rendered.');
    process.exit(1);
  }
  let failedCount = 0;
  const genders: Array<'male' | 'female' | undefined> = assistantTtsFromEnv()?.name === 'spitch' ? ['male', 'female'] : [undefined];
  for (const gender of genders) {
    const engine = assistantTtsFromEnv(gender);
    if (!engine) {
      console.log('No assistant speech engine is configured: assistant lines skipped.');
      break;
    }
    const label = `${engine.name}${(engine as any).voice ? ` (voice ${(engine as any).voice}${(engine as any).speed ? `, speed ${(engine as any).speed}` : ''})` : ''}`;
    const r = await prerender(assistantLines, new CachedSpeech(engine as any, cache, check), cache, apply, console.log, { recheck });
    failedCount += r.failed.length;
    console.log(
      `Assistant ${label}: ${assistantLines.length} fixed lines, ${r.present} already on disk` +
        (apply
          ? `, ${r.rendered} rendered now${recheck ? `, ${r.replaced} replaced (read punctuation aloud)` : ''}, ${r.failed.length} failed.`
          : `, ${assistantLines.length - r.present} missing or bad.`),
    );
    for (const f of r.failed) console.log(`  FAILED ${f}`);
  }

  if (!lines.length) {
    console.log('This agency’s welcome message has no <governor> part: no Governor lines to render.');
    await cache.flush();
    await prisma.$disconnect();
    process.exit(failedCount ? 1 : 0);
  }
  const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: org.id }, select: { apiKey: true } });
  const key = config?.apiKey ? decryptSecret(config.apiKey, `HostedAgentConfig.apiKey org=${org.id}`) : process.env.ELEVENLABS_API_KEY ?? '';
  // 2. The Governor's lines. The SAME engine the voice line uses for the Governor (LocalVoiceService.governorVoice),
  // or the clips land under a key the call never looks up.
  const spitchKey = process.env.SPITCH_API_KEY?.trim();
  const spitchGovVoice = process.env.SPITCH_GOVERNOR_VOICE?.trim();
  const engine: SpeechEngine =
    spitchKey && spitchGovVoice
      ? new SpitchTts({
          key: spitchKey,
          voice: spitchGovVoice,
          language: process.env.SPITCH_LANGUAGE?.trim() || 'en',
          speed: speedFromEnv('SPITCH_GOVERNOR_SPEED', speedFromEnv('SPITCH_SPEED')),
        })
      : new ElevenLabsTts(key, GOVERNOR_VOICE_ID, VOICE_MODEL_ID, VOICE_SETTINGS);
  console.log(`Governor engine: ${engine.name}${spitchGovVoice && spitchKey ? ` (voice ${spitchGovVoice}, speed ${(engine as SpitchTts).speed})` : ''}`);
  const speech = new CachedSpeech(engine as any, cache, check);
  const r = await prerender(lines, speech, cache, apply, console.log, { recheck });
  await cache.flush(); // the clips are written in the background; the process exits below
  console.log(
    `\n${lines.length} Governor lines for ${org.name}: ${r.present} already on disk` +
      (apply
        ? `, ${r.rendered} rendered now${recheck ? `, ${r.replaced} replaced (read punctuation aloud)` : ''}, ${r.failed.length} failed.`
        : `, ${lines.length - r.present} missing or bad. Nothing was rendered; add --apply.`),
  );
  for (const f of r.failed) console.log(`  FAILED ${f}`);
  await prisma.$disconnect();
  process.exit(r.failed.length + failedCount ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
