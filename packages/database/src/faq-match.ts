/**
 * Which of an agency's FAQs answers a question — ONE rule for both engines.
 *
 * The WhatsApp engine had this rule; the phone agent's search-knowledge tool
 * had its own, which accepted ANY FAQ sharing a single word of four letters or
 * more with the question ("what", "plateau", "state"). So callers asking
 * "What events are happening in Plateau State in December?" were read the
 * PLASCHEMA premium, and the knowledge base — which held the whole December
 * events lineup — was never searched. Both now call this.
 *
 * Deliberately conservative: an FAQ answers only when most (60%) of its own
 * content words appear in the question, or when every content word of the
 * question (two at least) appears in the FAQ. A weak match returns null and the
 * caller goes on to the knowledge base, which is the right outcome — a wrong
 * answer said with confidence is worse than a search.
 */
const STOPWORDS = new Set([
  'what', 'is', 'a', 'an', 'the', 'i', 'you', 'do', 'does', 'how', 'can',
  'where', 'who', 'to', 'for', 'of', 'in', 'on', 'my', 'your', 'it', 'and',
  'or', 'me', 'we', 'be', 'are', 'get', 'much', 'about', 'please',
]);

const singular = (t: string) =>
  t.length > 4 && t.endsWith('es') ? t.slice(0, -2)
  : t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1)
  : t;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(singular);
}

export interface FaqCandidate {
  question: string;
  answer: string;
}

/**
 * The best FAQ for `input`, or null. `faqs` must already be in the agency's
 * order (sortOrder asc): on a tie the earlier one wins, which is the lever the
 * agency is told it controls. An FAQ is never matched on words of
 * `agencyName` alone, so "What does the Plateau Contact Centre do?" does not
 * answer every message that names the agency.
 */
export function bestFaqMatch(
  faqs: FaqCandidate[],
  input: string,
  agencyName?: string | null
): { answer: string; score: number } | null {
  const queryTokens = new Set(tokenize(input));
  if (queryTokens.size === 0) return null;
  const brandTokens = new Set(tokenize(agencyName ?? ''));

  let best: { answer: string; score: number; overlap: number } | null = null;
  for (const faq of faqs) {
    // Each word once: "Who is the Commissioner for Health (head) of the
    // Ministry of Health?" counted "health" twice and outranked the FAQ that
    // actually answered "What does the Ministry of Health do?".
    const questionTokens = [...new Set(tokenize(faq.question))];
    if (questionTokens.length === 0) continue;
    const shared = questionTokens.filter((t) => queryTokens.has(t));
    // Words of the agency's own name still COUNT — "contact" is in "Citizen
    // Contact Centre", and dropping it sent "How can I contact the Water
    // Board?" to the Water Board's mandate — but an FAQ never matches on them
    // ALONE, which is what stripping them was for.
    if (!shared.some((t) => !brandTokens.has(t))) continue;
    const overlap = shared.length;
    const score = overlap / questionTokens.length;
    // Or the other way round: EVERY content word of the question is in this
    // FAQ (two at least). "How much is the PLASCHEMA premium?" is wholly inside
    // "What is the PLASCHEMA premium in Plateau State?" though it covers only
    // half of it; "What events are happening in Plateau State in December?"
    // is not — "events" and "December" are in no part of that FAQ.
    const questionInsideFaq =
      queryTokens.size >= 2 && [...queryTokens].every((t) => questionTokens.includes(t));
    if (score < 0.6 && !questionInsideFaq) continue;
    // A single-content-word question ("What is GateKipa?") would otherwise win
    // against EVERY message that mentions the word. It answers only when the
    // message adds nothing beyond it.
    if (questionTokens.length === 1 && ![...queryTokens].every((t) => questionTokens.includes(t))) {
      continue;
    }
    // More shared content words beats a higher coverage ratio.
    if (!best || overlap > best.overlap || (overlap === best.overlap && score > best.score)) {
      best = { answer: faq.answer, score, overlap };
    }
  }
  return best ? { answer: best.answer, score: best.score } : null;
}

/**
 * The FAQ's answer AND what the knowledge base adds, as one reply.
 *
 * An FAQ is the agency's own short answer; the knowledge base often holds the
 * detail behind it (venues, dates, offices). Answering from only one of them
 * left callers with either a one-liner or no approved wording. The FAQ comes
 * first because it is what the agency chose to say; knowledge lines that only
 * repeat it are dropped, and when nothing new remains the FAQ stands alone.
 */
export function combineFaqAndKnowledge(faqAnswer: string, passage: string | null | undefined): string {
  const faq = faqAnswer.trim();
  if (!passage?.trim()) return faq;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const faqNorm = norm(faq);
  const extra = passage
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && norm(l).length > 0 && !faqNorm.includes(norm(l)));
  if (extra.length === 0) return faq;
  return `${faq}\n\nFurther details from our records:\n${extra.join('\n')}`;
}
