import { stitchChunks } from '../src/document-chunks';

/** The indexer's cut: 1,800 characters with a 10% overlap. */
function chunk(text: string, size = 1800): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size - Math.floor(size * 0.1)) out.push(text.slice(i, Math.min(i + size, text.length)).trim());
  return out.filter(Boolean);
}

describe('stitchChunks', () => {
  const doc = Array.from({ length: 60 }, (_, i) => `- **Event ${i + 1}** on day ${i + 1}. Venue: Hall ${i + 1}, Jos.`).join('\n');

  it('puts an indexed document back together exactly, with no line read twice', () => {
    const parts = chunk(doc);
    expect(parts.length).toBeGreaterThan(1);
    expect(stitchChunks(parts)).toBe(doc);
  });

  it('keeps every chunk when the overlap cannot be found, rather than guessing a cut', () => {
    expect(stitchChunks(['first part of the document', 'an unrelated second part'])).toBe('first part of the document\nan unrelated second part');
  });

  it('ignores empty chunks', () => {
    expect(stitchChunks(['', 'only this', '  '])).toBe('only this');
  });
});
