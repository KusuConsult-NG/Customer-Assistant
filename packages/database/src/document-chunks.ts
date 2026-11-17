/**
 * Put a document's chunks back together as the document.
 *
 * Indexing cuts every ~1,800 characters with a 10% overlap, so chunk N+1
 * begins with the last ~180 characters of chunk N. Given back to a reader one
 * chunk at a time, a short document reads as three fragments — the December
 * events lineup was three chunks, and the phone agent was handed only the
 * first, so callers heard the November events and none of December's.
 * Concatenated naively, the overlap repeats a line, and a repeated event line
 * is read out as two events.
 *
 * So each chunk after the first is joined where its opening reappears in the
 * tail of what came before; when it cannot be found (a chunk trimmed
 * differently, a document re-cut), the chunks are joined with a newline
 * rather than guessing at a cut — a repeated line is better than a lost one.
 */
const PROBE_CHARS = 80;
const OVERLAP_SEARCH_CHARS = 600;

export function stitchChunks(chunks: string[]): string {
  let out = '';
  for (const raw of chunks) {
    const next = String(raw ?? '').trim();
    if (!next) continue;
    if (!out) {
      out = next;
      continue;
    }
    const probe = next.slice(0, Math.min(PROBE_CHARS, next.length));
    const tailStart = Math.max(0, out.length - OVERLAP_SEARCH_CHARS);
    const at = probe.length >= 20 ? out.indexOf(probe, tailStart) : -1;
    out = at >= 0 ? out.slice(0, at) + next : `${out}\n${next}`;
  }
  return out;
}
