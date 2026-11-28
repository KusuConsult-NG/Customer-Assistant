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
import { ACKS, HOLDING_LINE, openingSegments, openingSentences, spokenParts } from './voice-session';
import { SentenceSplitter } from './llm';

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

/**
 * The call script's own words (agent-tool-catalog SYSTEM_PROMPT), quoted
 * exactly as the script gives them to the model. Each must stay a quote in the
 * script (a test checks it); a line the script no longer has is a wasted render.
 */
export const SCRIPT_QUOTES = [
  'Yes, I can hear you clearly.',
  'Thank you for sharing that — I am ready to assist you. To get started, may I kindly know your full name?',
  'That is perfectly fine. We can proceed with your report. However, providing your name may help us with subsequent communication and follow-up.',
  'Please, which Local Government Area of Plateau State are you calling from?',
  'Thank you. Could you also tell me your ward and community?',
  'Thank you for that information.',
  'Are you comfortable with us using the telephone number you are calling from for subsequent communication?',
  'Could you please give me a telephone number we can reach you on for subsequent communication?',
  'Thank you for providing those details. Now, how may the Plateau State Government assist you today? Please state the reason for your call.',
  'Thank you for sharing this information with us. I appreciate you taking the time to bring this matter to our attention. Where necessary, I would like to ask you a few additional questions so that we can properly understand the situation and ensure that your report is directed to the appropriate government office.',
  'Could you please identify the exact location of the affected road or infrastructure?',
  'When did you first notice this problem?',
  'Is the situation affecting movement, businesses or residents in the area?',
  'Has this matter previously been reported to any government office?',
  'Which hospital or health facility is involved?',
  'Could you explain the nature of the problem?',
  'When did this incident occur?',
  'Is anyone currently in need of urgent medical attention?',
  'Which school or educational institution is involved?',
  'Which community and LGA is the school located in?',
  'Could you explain the specific concern?',
  'When did the issue occur?',
  'Which government office or institution is involved?',
  'Could you explain what happened?',
  'Have you previously attempted to resolve this matter?',
  'Is there any additional information, evidence or detail you would like us to include in your report?',
  'Thank you very much for providing those details. Let me briefly summarise what you have reported to ensure that I have captured everything correctly. You are reporting [description]. The incident or problem is located at [community or location], in [ward], [LGA]. You indicated that [relevant additional details]. Is this an accurate summary of your complaint?',
  'Thank you. I have captured the information as you have explained it.',
  'Thank you for correcting that information. I will update the report accordingly.',
  'Thank you for your patience. Your report has now been registered in our system. Your unique complaint reference number is [REFERENCE NUMBER]. Please keep this number safe, as it will help you track the progress of your report and make subsequent enquiries.',
  "Once again, thank you, [Caller's Name], for contacting the Plateau State Government Citizen Contact Centre. Your report has been recorded under reference number [REFERENCE NUMBER]. We appreciate your contribution towards improving governance and public service delivery across Plateau State. Your voice matters, and we encourage you to continue using this platform to communicate your concerns, seek information and provide feedback on government services. Is there anything else I can assist you with today, or may I go ahead and end the call?",
  'Thank you for calling the Plateau State Government Citizen Contact Centre. We wish you a pleasant day. Goodbye.',
  'Thank you for that information!',
  'Thank you for confirming that.',
  'Okay, thank you.',
  "I'm sorry, I can only speak English on this line. I will speak slowly — please tell me in English if you can.",
];

/**
 * The script's fixed sentences exactly as a live reply sends them to the
 * voice: cut into sentences the way a reply is (SentenceSplitter), then
 * transformed as say() transforms them (spokenParts). A sentence with a
 * blank to fill ([REFERENCE NUMBER], a name) differs per call and is left out.
 * A clip helps only when the model says the sentence word for word; the
 * `cached` field of voice_local_turn shows how often that happens.
 */
export function scriptLines(quotes: readonly string[] = SCRIPT_QUOTES): string[] {
  const out = new Set<string>();
  for (const quote of quotes) {
    const splitter = new SentenceSplitter({ firstAtComma: false });
    const sentences = [...splitter.push(quote + ' ')];
    const rest = splitter.flush();
    if (rest) sentences.push(rest);
    for (const sentence of sentences) {
      if (/[[\]{}]|\d/.test(sentence)) continue;
      for (const part of spokenParts(sentence)) out.add(part);
    }
  }
  return [...out];
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

/**
 * The Governor's engine exactly as the voice line builds it
 * (LocalVoiceService.governorVoice): the clips land under the key a call looks up.
 */
export async function governorEngineFor(organizationId: string): Promise<{ engine: SpeechEngine; label: string }> {
  const spitchKey = process.env.SPITCH_API_KEY?.trim();
  const spitchGovVoice = process.env.SPITCH_GOVERNOR_VOICE?.trim();
  if (spitchKey && spitchGovVoice) {
    const engine = new SpitchTts({
      key: spitchKey,
      voice: spitchGovVoice,
      language: process.env.SPITCH_LANGUAGE?.trim() || 'en',
      speed: speedFromEnv('SPITCH_GOVERNOR_SPEED', speedFromEnv('SPITCH_SPEED')),
    });
    return { engine, label: `spitch (voice ${spitchGovVoice}, speed ${engine.speed})` };
  }
  const { prisma, decryptSecret } = await import('@ace/database');
  const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId }, select: { apiKey: true } });
  const key = config?.apiKey ? decryptSecret(config.apiKey, `HostedAgentConfig.apiKey org=${organizationId}`) : process.env.ELEVENLABS_API_KEY ?? '';
  return { engine: new ElevenLabsTts(key, GOVERNOR_VOICE_ID, VOICE_MODEL_ID, VOICE_SETTINGS), label: 'elevenlabs' };
}

async function main() {
  const slug = process.argv[2];
  const apply = process.argv.includes('--apply');
  const recheck = process.argv.includes('--recheck');
  if (!slug || slug.startsWith('--')) {
    console.error('Usage: node apps/api/dist/voice-local/prerender.js <agency-slug> [--apply] [--recheck]');
    process.exit(2);
  }
  const { prisma } = await import('@ace/database');
  const org = await prisma.organization.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
  });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const lines = governorLines(org);
  const dir = process.env.VOICE_CACHE_DIR?.trim() || path.join(process.env.STORAGE_DIR?.trim() || process.cwd(), 'tts-cache');
  const cache = new TtsCache(dir, Number(process.env.VOICE_CACHE_MAX_MB || 2048) * 1024 * 1024);

  // 1. The assistant's fixed sentences, in every assistant voice the line uses.
  // 2. The call script's fixed sentences, in the form a live reply sends them.
  const assistantLines = [...new Set([...assistantStaticLines(org), ...scriptLines()])];
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
  const { engine, label: govLabel } = await governorEngineFor(org.id);
  console.log(`Governor engine: ${govLabel}`);
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
