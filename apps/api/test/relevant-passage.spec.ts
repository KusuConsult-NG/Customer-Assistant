import { relevantPassage } from '../src/agent-tools/relevant-passage';

// Shaped like the "Master Leadership Directory" a live call retrieved. The old
// tool returned its first 500 characters (Agriculture) for every question, and
// the model invented the rest.
const DIRECTORY = [
  'Plateau State Government — Master Leadership Directory & Executive Council',
  'Complete listing of current Commissioners, Directors-General, Chairmen, and executive heads of all 58 MDAs.',
  'MARD — Ministry of Agriculture and Natural Resources: Commissioner: Hon. A. Example',
  '  - Former Leadership: Commissioner: Dr. B. Example (2019 – 2023)',
  'MOH — Ministry of Health: Commissioner: Hon. C. Example',
  'PLHA — Plateau State House of Assembly: Speaker: Rt. Hon. D. Example',
  'MOE — Ministry of Education: Commissioner: Hon. E. Example',
].join('\n');

describe('search-knowledge returns the passage that answers the question', () => {
  it('finds the Speaker line, not the first entry of the document', () => {
    const p = relevantPassage([DIRECTORY], 'current Speaker of Plateau State House of Assembly')!;
    expect(p).toContain('Speaker: Rt. Hon. D. Example');
    expect(p).not.toContain('Agriculture');
  });

  it('finds a named ministry', () => {
    const p = relevantPassage([DIRECTORY], 'Who is the Commissioner for Health?')!;
    expect(p).toContain('Hon. C. Example');
  });

  it('returns NOTHING when no line answers, so the agent says it does not know', () => {
    expect(relevantPassage([DIRECTORY], 'tender for the Jos ring road')).toBeNull();
  });

  it('stays within its budget', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Ministry of Health annex ${i}: Commissioner office line`).join('\n');
    expect(relevantPassage([long], 'Ministry of Health commissioner', 400)!.length).toBeLessThanOrEqual(400);
  });
});
