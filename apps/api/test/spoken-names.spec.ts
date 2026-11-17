/**
 * Every title on an official's name must reach the caller.
 *
 * Callers heard "Joyce Lohya Ramnap" for the Commissioner for Information,
 * whose name carries "mni", and the directory has the same shape elsewhere
 * ("Edward Pwajok SAN", "Gyang Buba, CFR", "Olivia Dazyem Esq"). The agent
 * paraphrased the lookup and dropped the letters, and a lower-case "mni" is
 * read as a syllable if it is read at all. These pin both halves: the text is
 * made speakable, and the prompt forbids shortening a name.
 */
import { speakableHonours } from '../src/agent-tools/spoken-names';
import { agentPromptFor } from '../src/agent-tools/agent-tool-catalog';

describe('Honours after an official\'s name', () => {
  it.each([
    ['Commissioner for Information and Communication: Rt. Hon. Joyce Lohya Ramnap, mni',
     'Commissioner for Information and Communication: Rt. Hon. Joyce Lohya Ramnap, M N I'],
    ['Rt. Hon. Joyce Lohya Ramnap, mni.', 'Rt. Hon. Joyce Lohya Ramnap, M N I.'],
    ['Attorney-General: Edward Pwajok SAN (2015).', 'Attorney-General: Edward Pwajok S A N (2015).'],
    ['Former Governor: Gyang Buba, CFR, served', 'Former Governor: Gyang Buba, C F R, served'],
    ['Mrs. Olivia Dazyem Esq (2014 – 2015)', 'Mrs. Olivia Dazyem Esquire (2014 – 2015)'],
    ['Dr. Ade Bello, PhD, mni, FCA.', 'Dr. Ade Bello, P H D, M N I, F C A.'],
    ['Chief Musa Danjuma, GCON', 'Chief Musa Danjuma, G C O N'],
  ])('spells out %s', (input, expected) => {
    expect(speakableHonours(input)).toBe(expected);
  });

  it('leaves the same letters alone where they are not an honour', () => {
    for (const text of [
      'Please CONTACT the office.',
      'the mni course at NIPSS Kuru',
      'Call 0803 for the SAN office hours',
      'Plateau State Gender and Equal Opportunities Commission',
    ]) {
      expect(speakableHonours(text)).toBe(text);
    }
  });

  it('changes nothing else in a directory passage', () => {
    const passage = 'Current Leadership\nCommissioner: Rt. Hon. Joyce Lohya Ramnap, mni\nRole Overview: Former Deputy Speaker.';
    const out = speakableHonours(passage);
    expect(out.replace('M N I', 'mni')).toBe(passage);
  });

  it('tells the agent to say every name in full, titles and honours included', () => {
    const prompt = agentPromptFor({
      name: 'Plateau State Government Citizen Contact Centre',
      slug: 'plateau-state',
      timezone: 'Africa/Lagos',
      welcomeMessage: null,
      aiPersonaPrompt: null,
    });
    expect(prompt).toMatch(/NAMES AND TITLES/);
    expect(prompt).toMatch(/Rt\. Hon\. Joyce Lohya Ramnap, M N I/);
    expect(prompt).toMatch(/never shorten|Never shorten/);
  });
});
