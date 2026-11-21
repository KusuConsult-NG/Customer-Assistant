import { plainSpokenText } from '../src/agent-tools/spoken-text';
import { agentPromptFor, SPOKEN_FORM_INSTRUCTION } from '../src/agent-tools/agent-tool-catalog';

/**
 * On a live call (conv_8201m7sda99sez38z1wmxqten70j) the agent answered a
 * caller with "1. **Road Infrastructure and Urban Renewal**: …" — a written
 * list in bold markers, copied from the shape of the knowledge text it read.
 */
describe('what the phone agent reads is speakable, and it is told to speak', () => {
  const doc = [
    '## Road Infrastructure',
    '1. **Major Roads** (2025–2026):',
    '- Bisichi – Fan – Mangu Halle Road (41 km), flagged off October 2026.',
    '* Utonkon Bridge, commissioned *June 12, 2025*.',
    '2) Approved ₦2 Billion for RAAMP across 17 LGAs — see [the portal](https://example.gov.ng).',
    '---',
  ].join('\n');

  it('removes headings, bold, italics, bullets, list numbering and links', () => {
    const out = plainSpokenText(doc);
    expect(out).not.toMatch(/\*|^#|^\s*[-•]\s|^\s*\d{1,2}[.)]\s|\]\(|^---/m);
  });

  it('keeps every word, name, figure and date', () => {
    const out = plainSpokenText(doc);
    for (const kept of ['Road Infrastructure', 'Major Roads (2025–2026):', 'Bisichi – Fan – Mangu Halle Road (41 km)', 'June 12, 2025', '₦2 Billion', '17 LGAs', 'the portal']) {
      expect(out).toContain(kept);
    }
  });

  it('leaves numbers inside a sentence alone', () => {
    expect(plainSpokenText('There are 13 events. 2025 was a record year.')).toBe('There are 13 events. 2025 was a record year.');
  });

  it('puts the SPOKEN FORM rule in the guardrails, after the persona', () => {
    const prompt = agentPromptFor({
      name: 'Plateau State Government Citizen Contact Centre', slug: 'plateau-state', timezone: 'Africa/Lagos',
      welcomeMessage: null, aiPersonaPrompt: 'Use numbered lists for clarity.',
    } as any);
    expect(prompt).toContain(`SPOKEN FORM: ${SPOKEN_FORM_INSTRUCTION}`);
    // After the agency's own text, so a persona asking for lists cannot override it.
    expect(prompt.indexOf('SPOKEN FORM')).toBeGreaterThan(prompt.indexOf('Use numbered lists for clarity.'));
  });
});
