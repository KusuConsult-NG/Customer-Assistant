/**
 * Render every version of the Governor's opening in his cloned voice ahead of
 * time, onto the server's disk, where the voice line plays it from.
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
  renderWelcome,
  resolvePersona,
  type AgentOrganization,
  type TeamPersona,
} from '../agent-tools/agent-tool-catalog';
import { assistantTtsFromEnv, CachedSpeech, ElevenLabsTts, SpitchTts, type SpeechEngine } from './tts';
import { TtsCache } from './tts-cache';
import { openingSegments } from './voice-session';

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

export async function prerender(
  lines: string[],
  speech: CachedSpeech,
  cache: TtsCache,
  apply: boolean,
  log: (m: string) => void = console.log,
): Promise<{ present: number; rendered: number; failed: string[] }> {
  let present = 0;
  let rendered = 0;
  const failed: string[] = [];
  for (const line of lines) {
    if (cache.get(speech.key(line))) {
      present++;
      continue;
    }
    if (!apply) {
      log(`  missing: ${line}`);
      continue;
    }
    try {
      await speech.speak(line, { alwaysCache: true });
      rendered++;
    } catch (err: any) {
      failed.push(`${line} — ${err?.message ?? err}`);
    }
  }
  return { present, rendered, failed };
}

async function main() {
  const slug = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!slug || slug.startsWith('--')) {
    console.error('Usage: node apps/api/dist/voice-local/prerender.js <agency-slug> [--apply]');
    process.exit(2);
  }
  const { prisma, decryptSecret } = await import('@ace/database');
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
  });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const lines = governorLines(org);
  if (!lines.length) {
    console.log('This agency’s welcome message has no <governor> part: nothing to render.');
    return;
  }
  const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: org.id }, select: { apiKey: true } });
  const key = config?.apiKey ? decryptSecret(config.apiKey, `HostedAgentConfig.apiKey org=${org.id}`) : process.env.ELEVENLABS_API_KEY ?? '';
  const dir = process.env.VOICE_CACHE_DIR?.trim() || path.join(process.env.STORAGE_DIR?.trim() || process.cwd(), 'tts-cache');
  const cache = new TtsCache(dir, Number(process.env.VOICE_CACHE_MAX_MB || 2048) * 1024 * 1024);
  // The SAME engine the voice line uses for the Governor (LocalVoiceService.governorVoice),
  // or the clips land under a key the call never looks up.
  const spitchKey = process.env.SPITCH_API_KEY?.trim();
  const spitchGovVoice = process.env.SPITCH_GOVERNOR_VOICE?.trim();
  const engine: SpeechEngine =
    spitchKey && spitchGovVoice
      ? new SpitchTts({ key: spitchKey, voice: spitchGovVoice, language: process.env.SPITCH_LANGUAGE?.trim() || 'en' })
      : new ElevenLabsTts(key, GOVERNOR_VOICE_ID, VOICE_MODEL_ID, VOICE_SETTINGS);
  console.log(`Governor engine: ${engine.name}${spitchGovVoice && spitchKey ? ` (voice ${spitchGovVoice})` : ''}`);
  const speech = new CachedSpeech(engine as any, cache);
  const r = await prerender(lines, speech, cache, apply);
  console.log(
    `\n${lines.length} Governor lines for ${org.name}: ${r.present} already on disk` +
      (apply ? `, ${r.rendered} rendered now, ${r.failed.length} failed.` : `, ${lines.length - r.present} missing. Nothing was rendered; add --apply.`),
  );
  for (const f of r.failed) console.log(`  FAILED ${f}`);
  await prisma.$disconnect();
  process.exit(r.failed.length ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
