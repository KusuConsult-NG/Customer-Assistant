/**
 * The State Contact Centre's sector follow-up questions, in the document's
 * own words.
 *
 * Phase 3 of the State's standard operating script lists the questions the
 * assistant asks for each kind of complaint. On 15 November three of the four
 * infrastructure questions were reworded in the prompt ("…exact location or
 * landmark of the affected road, water supply, or infrastructure?", "How long
 * has this problem been going on?") and one was dropped, and nothing noticed:
 * no test held the wording, so a reword reads the same as no change at all.
 *
 * The document's own rule — "The AI should ask only relevant questions,
 * avoiding unnecessary repetition" — is kept: the assistant skips a question
 * the caller has already answered. What it does not do is ask a different
 * question in its place. So each question must appear in the prompt as one to
 * ASK, never only inside an example of what to leave out (which is how
 * "When did you first notice this problem?" survived the reword: quoted in a
 * "DO NOT ask" example, it still matched a plain text search).
 */
import { SYSTEM_PROMPT, agentPromptFor } from '../src/agent-tools/agent-tool-catalog';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const state = require('../../../scripts/update-state-info-center.js');

/** Phase 3 of the document, question by question. */
const SECTOR_QUESTIONS: Record<string, string[]> = {
  Infrastructure: [
    'Could you please identify the exact location of the affected road or infrastructure?',
    'When did you first notice this problem?',
    'Is the situation affecting movement, businesses or residents in the area?',
    'Has this matter previously been reported to any government office?',
  ],
  Healthcare: [
    'Which hospital or health facility is involved?',
    'Could you explain the nature of the problem?',
    'When did this incident occur?',
    'Is anyone currently in need of urgent medical attention?',
  ],
  Education: [
    'Which school or educational institution is involved?',
    'Which community and LGA is the school located in?',
    'Could you explain the specific concern?',
    'When did the issue occur?',
  ],
  'Public Administration': [
    'Which government office or institution is involved?',
    'Could you explain what happened?',
    'When did this incident occur?',
    'Have you previously attempted to resolve this matter?',
  ],
};
const GENERAL_FOLLOW_UP =
  'Is there any additional information, evidence or detail you would like us to include in your report?';

/** The Plateau agency's prompt as the live agent receives it: script, persona, guardrails. */
const plateauPrompt = agentPromptFor({
  name: 'Plateau State Government Citizen Contact Centre',
  slug: 'plateau-state',
  timezone: 'Africa/Lagos',
  welcomeMessage: state.STATE_WELCOME_MESSAGE,
  aiPersonaPrompt: state.STATE_PERSONA_PROMPT,
} as any);

const quoted = (q: string) => `"${q}"`;

describe('Phase 3 sector questions are the State document’s wording', () => {
  for (const [sector, questions] of Object.entries(SECTOR_QUESTIONS)) {
    it(`${sector}: the document's questions, in its order, as one list`, () => {
      // The whole line, so a reword, a dropped question or a substituted one fails.
      expect(SYSTEM_PROMPT).toContain(`  - ${sector}: ${questions.map(quoted).join(' / ')}`);
    });
  }

  it('the general follow-up question', () => {
    expect(SYSTEM_PROMPT).toContain(quoted(GENERAL_FOLLOW_UP));
  });

  it('no document question is quoted as something NOT to ask', () => {
    const all = [...Object.values(SECTOR_QUESTIONS).flat(), GENERAL_FOLLOW_UP];
    for (const q of all) {
      const forbidden = new RegExp(`(do not|don't|never)\\s+ask\\s+${quoted(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      expect(plateauPrompt).not.toMatch(forbidden);
    }
  });

  it('keeps the document’s own rule: skip what the caller has already said', () => {
    expect(SYSTEM_PROMPT).toMatch(/skipping anything the caller already told you/);
  });

  it('nothing the agency layers on top (persona, guardrails) replaces them', () => {
    // The persona and guardrails are appended after the script; a reworded
    // copy there would be the one the model follows.
    for (const reword of ['landmark of the affected road', 'How long has this problem been going on?']) {
      expect(plateauPrompt).not.toContain(reword);
    }
    for (const q of SECTOR_QUESTIONS.Infrastructure) expect(plateauPrompt).toContain(quoted(q));
  });
});
