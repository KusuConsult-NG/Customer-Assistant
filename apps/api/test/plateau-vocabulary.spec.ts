/**
 * Both phone lines are told the SAME Plateau places. They were two lists, and
 * on 26 Nov 2026 a caller on the local line said "Gyel B": the ElevenLabs
 * agent's list had "Gyel", the local line's did not, and it was heard as
 * "Galby" and saved as the caller's community.
 */
import { PLATEAU_LGAS } from '@ace/database';
import { agentDefinition } from '../src/agent-tools/elevenlabs-contracts';
import { plateauPlaceWords } from '../src/agent-tools/plateau-vocabulary';
import { deepgramUrl } from '../src/voice-local/stt';

const localWords = () =>
  new URL(deepgramUrl())
    .searchParams.getAll(new URL(deepgramUrl()).searchParams.has('keyterm') ? 'keyterm' : 'keywords')
    .map((w) => w.replace(/:\d+$/, ''));
const agentWords = (): string[] =>
  (agentDefinition({ name: 'a', firstMessage: 'Hello', systemPrompt: 'p', toolIds: ['t'], timezone: 'Africa/Lagos' }) as any).conversationConfig.asr.keywords;

describe('Plateau vocabulary', () => {
  it('the local line and the ElevenLabs agent are told every place, the same places', () => {
    const places = plateauPlaceWords();
    for (const words of [localWords(), agentWords()]) {
      for (const p of places) expect(words).toContain(p);
    }
  });

  it('includes every LGA and the ward a caller was misheard on', () => {
    for (const lga of PLATEAU_LGAS) expect(localWords()).toContain(lga);
    expect(localWords()).toContain('Gyel');
    expect(agentWords()).toContain('Gyel');
  });

  it('lists each word once', () => {
    for (const words of [localWords(), agentWords()]) expect(new Set(words).size).toBe(words.length);
  });
});
