/**
 * One FAQ rule for both engines (faq-match.ts). The phone agent's own rule
 * took any FAQ sharing one word with the question, so callers asking about the
 * December events were read an unrelated FAQ and the knowledge base holding
 * the lineup was never searched.
 */
import { bestFaqMatch } from '../src/faq-match';

const FAQS = [
  { question: 'What is the PLASCHEMA premium in Plateau State?', answer: 'premium answer' },
  { question: 'What are the opening hours of the Contact Centre?', answer: 'hours answer' },
  { question: 'How do I register for health insurance?', answer: 'register answer' },
];

describe('bestFaqMatch', () => {
  it('lets a question an FAQ does not ask fall through to the knowledge base', () => {
    expect(bestFaqMatch(FAQS, 'What events are happening in Plateau State in December?')).toBeNull();
    expect(bestFaqMatch(FAQS, 'Tell me about Urban Fest')).toBeNull();
    expect(bestFaqMatch(FAQS, 'When is the New Year crossover in Jos?')).toBeNull();
  });

  it('answers the questions its FAQs do ask', () => {
    expect(bestFaqMatch(FAQS, 'How much is the PLASCHEMA premium?')?.answer).toBe('premium answer');
    expect(bestFaqMatch(FAQS, 'What are your opening hours?')?.answer).toBe('hours answer');
    expect(bestFaqMatch(FAQS, 'how do i register for health insurance')?.answer).toBe('register answer');
  });

  it('keeps the agency order on a tie', () => {
    const tie = [
      { question: 'What are the opening hours?', answer: 'first' },
      { question: 'What are the opening hours?', answer: 'second' },
    ];
    expect(bestFaqMatch(tie, 'What are the opening hours?')?.answer).toBe('first');
  });
});
