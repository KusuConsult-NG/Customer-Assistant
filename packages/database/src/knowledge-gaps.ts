/**
 * Unanswered questions, collected so someone can answer them (PRD §12).
 *
 * The key is deliberately crude — lowercase words, punctuation and filler
 * dropped, order kept — so "How do I get a certificate of origin?" and "how do
 * i get certificate of origin" are one gap counted twice, while two different
 * questions never collapse into one. Over-splitting costs an officer a second
 * row; over-merging would hide a question nobody saw.
 */
const FILLER = new Set(['please', 'pls', 'abeg', 'kindly', 'hello', 'hi', 'sir', 'madam', 'ma', 'the', 'a', 'an', 'um', 'ok']);

export function knowledgeGapKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w))
    .join(' ')
    .slice(0, 200);
}

/** Worth recording? A greeting or "ok thanks" is not a gap in the knowledge. */
export function isGapWorthy(text: string): boolean {
  const key = knowledgeGapKey(text);
  if (key.split(' ').length < 3) return false;
  return /\?|\b(how|what|where|when|who|which|why|can i|do i|is there|are there|requirements?|cost|fee|price|apply|register|office|get)\b/i.test(text);
}

type Client = { knowledgeGap: { upsert: (args: any) => Promise<unknown> } };

/** Count one more ask. Never throws: recording a gap must not cost the citizen a reply. */
export async function recordKnowledgeGap(client: Client, organizationId: string, text: string, channel?: string): Promise<void> {
  if (!isGapWorthy(text)) return;
  const questionKey = knowledgeGapKey(text);
  try {
    await client.knowledgeGap.upsert({
      where: { organizationId_questionKey: { organizationId, questionKey } },
      create: { organizationId, questionKey, sampleText: text.slice(0, 1000), channel: channel ?? null },
      update: { count: { increment: 1 }, lastAskedAt: new Date(), sampleText: text.slice(0, 1000) },
    });
  } catch {
    /* best effort */
  }
}
