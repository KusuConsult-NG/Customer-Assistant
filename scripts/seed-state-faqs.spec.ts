/**
 * The State FAQs are generated from the verified records, and they lead the
 * right question to the right answer under the shared FAQ rule.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildStateFaqs, phoneForPeople } = require('./seed-state-faqs.js');
import { bestFaqMatch } from '../packages/database/src/faq-match';

const ROOT = join(__dirname, '..');
const agencies = JSON.parse(readFileSync(join(ROOT, 'data', 'plateau-mdas-knowledge-base.json'), 'utf8'));
const eventsMd = readFileSync(join(ROOT, 'data', 'mda-knowledge', 'December-Tourism-Month-2026-Events.md'), 'utf8');
const faqs: Array<{ question: string; answer: string }> = buildStateFaqs(agencies, eventsMd);
const ORG = 'Plateau State Government Citizen Contact Centre';

const answerFor = (q: string) => {
  const m = bestFaqMatch(faqs, q, ORG);
  return m ? faqs.find((f) => f.answer === m.answer)!.question : null;
};

describe('State FAQs', () => {
  it('lists EVERY event of the December lineup in one answer', () => {
    const events = faqs.find((f) => /December Tourism Month/.test(f.question))!;
    const count = (eventsMd.match(/^- \*\*/gm) ?? []).length;
    expect(events.answer.split('\n').filter((l) => /^\d+\. /.test(l))).toHaveLength(count);
    expect(events.answer).toContain('Urban Fest');
    expect(events.answer).toMatch(/to be announced|Dates and venues may change/);
  });

  it('says only what the record says — leadership, honours and all', () => {
    const moic = faqs.find((f) => /\(MOIC\)\?$/.test(f.question) && /head/.test(f.question))!;
    expect(moic.answer).toContain('Rt. Hon. Joyce Lohya Ramnap, mni');
    // The scraped `raw*` fields are never used: MARD's rawLeader is a college provost.
    expect(faqs.some((f) => /Provost/.test(f.answer) && /MARD/.test(f.question))).toBe(false);
  });

  it('reads phone numbers the way people dial them', () => {
    expect(phoneForPeople('+2348037042854')).toBe('0803 704 2854');
  });

  it.each([
    ['What events are happening in December in Plateau?', /December Tourism Month/],
    ['Who is the commissioner of health?', /head\) of the Ministry of Health/],
    ['What does the Ministry of Health do?', /^What does the Ministry of Health/],
    ['How can I contact the Water Board?', /office of the Plateau State Water Board/],
    ['What services does PLASCHEMA offer?', /services does the .*PLASCHEMA/],
  ])('"%s" reaches the right FAQ', (q, expected) => {
    expect(answerFor(q)).toMatch(expected);
  });

  it('leaves questions no FAQ asks to the knowledge base', () => {
    expect(answerFor('Tell me about Urban Fest')).toBeNull();
    expect(answerFor('How do I pay my taxes?')).toBeNull();
  });
});
