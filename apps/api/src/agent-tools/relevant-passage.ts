/**
 * The part of the retrieved knowledge that answers THIS question.
 *
 * search-knowledge used to return the first 500 characters of the single top
 * result. For a long document that is its title and first entry, whatever was
 * asked: a live call asked for the Speaker of the House of Assembly and three
 * commissioners, the tool returned the same Agriculture paragraph three
 * times, and the model filled in every other name itself — on a State
 * Government line, which is the fabrication invariant 1 forbids.
 *
 * So: score every line of the top results by how many query words it holds,
 * keep the matching lines (with the line before each, which is usually the
 * heading that says what the line is about), in document order, up to a
 * budget. When nothing matches, say so by returning null — the caller then
 * tells the citizen it does not have the detail, rather than reading out an
 * unrelated paragraph that the model will treat as an answer.
 */
const STOP = new Set([
  'what', 'who', 'whom', 'which', 'when', 'where', 'how', 'the', 'and', 'for', 'are', 'was', 'were', 'is',
  'current', 'currently', 'please', 'tell', 'about', 'with', 'from', 'that', 'this', 'state', 'plateau',
  'name', 'names', 'there', 'their', 'have', 'does', 'want', 'know',
]);

export function queryTerms(query: string): string[] {
  return [...new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  )];
}

export function relevantPassage(contents: string[], query: string, budget = 1200): string | null {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;

  const hitsIn = (line: string) => {
    const lower = line.toLowerCase();
    return terms.filter((t) => lower.includes(t)).length;
  };
  // A line must carry most of the question's words, not one common one — and
  // when some line carries EVERY one, only such lines answer. Otherwise a word
  // shared by many lines fills the budget in document order first: "Tell me
  // about Urban Fest" returned lines about ONE PLATEAU FEST and never reached
  // the one Urban Fest line.
  const threshold = contents.some((c) => c.split('\n').some((l) => hitsIn(l) === terms.length))
    ? terms.length
    : Math.max(1, Math.ceil(terms.length / 2));

  const picked: string[] = [];
  let used = 0;
  for (const content of contents) {
    const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
    const keep = new Set<number>();
    lines.forEach((line, i) => {
      if (hitsIn(line) >= threshold) {
        if (i > 0) keep.add(i - 1);
        keep.add(i);
      }
    });
    for (const i of [...keep].sort((a, b) => a - b)) {
      if (used + lines[i].length + 1 > budget) return picked.length ? picked.join('\n') : null;
      picked.push(lines[i]);
      used += lines[i].length + 1;
    }
  }
  return picked.length ? picked.join('\n') : null;
}
