/**
 * Print the rules of the ElevenLabs pronunciation dictionary the old line
 * used, so the words it said right can be carried into pronounce.ts. Run on
 * the server, where the ElevenLabs key is:
 *
 *   node apps/api/dist/voice-local/pronunciations-export.js <agency-slug> [dictionary-id version-id]
 *
 * Read-only: one GET of the dictionary file. Prints each word and the
 * spelling (alias) or phonetic rule (IPA) it was given. Never prints a key.
 */
import { pronunciationDictionaryLocatorsFromEnv } from '../agent-tools/agent-tool-catalog';

/** The State dictionary's latest version, as agent-tool-catalog resolves the legacy ids. */
const PLATEAU_DICTIONARY = { pronunciationDictionaryId: '6Q0cOBoB6nXMLg2GHMEc', versionId: '9M5dKT0qPOVE0fGUie3h' };

export interface DictionaryRule {
  words: string[];
  alias?: string;
  phoneme?: string;
  alphabet?: string;
}

const unxml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();

/** The lexemes of a PLS (W3C Pronunciation Lexicon) file. */
export function parsePls(pls: string): DictionaryRule[] {
  const alphabet = pls.match(/<lexicon[^>]*\balphabet="([^"]+)"/)?.[1];
  const rules: DictionaryRule[] = [];
  for (const m of pls.matchAll(/<lexeme\b[^>]*>([\s\S]*?)<\/lexeme>/g)) {
    const body = m[1];
    const words = [...body.matchAll(/<grapheme\b[^>]*>([\s\S]*?)<\/grapheme>/g)].map((g) => unxml(g[1]));
    const alias = body.match(/<alias\b[^>]*>([\s\S]*?)<\/alias>/)?.[1];
    const phoneme = body.match(/<phoneme\b[^>]*>([\s\S]*?)<\/phoneme>/)?.[1];
    if (!words.length) continue;
    rules.push({ words, ...(alias !== undefined ? { alias: unxml(alias) } : {}), ...(phoneme !== undefined ? { phoneme: unxml(phoneme), alphabet } : {}) });
  }
  return rules;
}

async function main() {
  const [slug, dictArg, verArg] = process.argv.slice(2);
  if (!slug) {
    console.error('Usage: node apps/api/dist/voice-local/pronunciations-export.js <agency-slug> [dictionary-id version-id]');
    process.exit(2);
  }
  const { prisma, decryptSecret } = await import('@ace/database');
  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
  if (!org) throw new Error(`No agency with slug "${slug}".`);
  const config = await prisma.hostedAgentConfig.findUnique({ where: { organizationId: org.id }, select: { apiKey: true } });
  const key = config?.apiKey ? decryptSecret(config.apiKey, `HostedAgentConfig.apiKey org=${org.id}`) : process.env.ELEVENLABS_API_KEY?.trim() ?? '';
  await prisma.$disconnect();
  if (!key) throw new Error('No ElevenLabs key: neither this agency nor ELEVENLABS_API_KEY has one.');

  const dict =
    dictArg && verArg
      ? { pronunciationDictionaryId: dictArg, versionId: verArg }
      : pronunciationDictionaryLocatorsFromEnv()[0] ?? PLATEAU_DICTIONARY;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/pronunciation-dictionaries/${encodeURIComponent(dict.pronunciationDictionaryId)}/${encodeURIComponent(dict.versionId)}/download`,
    { headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`ElevenLabs refused the dictionary (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const rules = parsePls(await res.text());
  console.log(`Dictionary ${dict.pronunciationDictionaryId} version ${dict.versionId}: ${rules.length} rules`);
  for (const r of rules) {
    console.log(`  ${r.words.join(' / ')}  ->  ${r.alias !== undefined ? `says "${r.alias}"` : `${r.alphabet ?? 'phoneme'} ${r.phoneme}`}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
