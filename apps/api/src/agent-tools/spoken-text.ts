/**
 * Knowledge text made fit to be SPOKEN.
 *
 * Whatever search-knowledge returns, the phone agent reads, and the model
 * copies the shape of what it reads: given "1. **Road Infrastructure**" and
 * "- Bisichi – Fan – Mangu Road", it answered a live caller with a numbered
 * list in bold markers, which a voice can only read out as a document. The
 * FAQ path was not cleaned at all. So markdown and list markers are removed
 * from everything the tool hands over, and the SPOKEN FORM guardrail tells the
 * agent to say items as speech ("First… Next… And third…").
 *
 * Only MARKERS go: headings, bold/italic, bullets, list numbering, links,
 * code and rules. The words, names, numbers and dates stay exactly as written
 * — "Utonkon Bridge (2025)", "₦2 Billion", "17 LGAs" are untouched, and a
 * number only goes when it starts a line followed by "." or ")" and a space.
 */
export function plainSpokenText(text: string): string {
  return (text ?? '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d{1,2}[.)]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
