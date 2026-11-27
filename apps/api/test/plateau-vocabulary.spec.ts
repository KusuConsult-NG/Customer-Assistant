/**
 * What each phone line's speech recognition is told to expect.
 *
 * 26 Nov 2026, the caller's side of four real calls streamed through five
 * settings: boosting the community and ward names on the server's own line put
 * them into ordinary speech ("I'm calling" heard as "I'm Kabong", "What
 * project" as "What Rock", "Gyel" in a call where nobody said it), and the
 * assistant told a caller on a clear line that it could not hear him. nova-3
 * with only the LGAs, the Governor's name and the agencies got every question
 * right and inserted nothing. These tests hold the line to that setting.
 */
import { PLATEAU_LGAS } from '@ace/database';
import { agentDefinition } from '../src/agent-tools/elevenlabs-contracts';
import { PLATEAU_PLACES, localLineRecognitionTerms, plateauPlaceWords } from '../src/agent-tools/plateau-vocabulary';
import { deepgramUrl, localSttModel } from '../src/voice-local/stt';

const local = () => new URL(deepgramUrl()).searchParams;
const agentWords = (): string[] =>
  (agentDefinition({ name: 'a', firstMessage: 'Hello', systemPrompt: 'p', toolIds: ['t'], timezone: 'Africa/Lagos' }) as any).conversationConfig.asr.keywords;

describe('the local line (Deepgram)', () => {
  const saved = process.env.LOCAL_VOICE_STT_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOCAL_VOICE_STT_MODEL;
    else process.env.LOCAL_VOICE_STT_MODEL = saved;
  });

  it('listens with nova-3, and boosts with keyterms (nova-3 has no keywords)', () => {
    delete process.env.LOCAL_VOICE_STT_MODEL;
    expect(localSttModel()).toBe('nova-3');
    expect(local().get('model')).toBe('nova-3');
    expect(local().getAll('keywords')).toEqual([]);
    expect(local().getAll('keyterm')).toEqual(localLineRecognitionTerms());
  });

  it('is told every LGA and the Governor\'s full name as one phrase', () => {
    for (const lga of PLATEAU_LGAS) expect(local().getAll('keyterm')).toContain(lga);
    expect(local().getAll('keyterm')).toContain('Caleb Mutfwang');
  });

  it('is NOT told the community and ward names: boosted, they were heard in ordinary speech', () => {
    const terms = local().getAll('keyterm');
    for (const place of PLATEAU_PLACES) expect(terms).not.toContain(place);
  });

  it('an override picks another model, and a nova-2 model boosts with keywords', () => {
    process.env.LOCAL_VOICE_STT_MODEL = 'nova-2';
    expect(local().get('model')).toBe('nova-2');
    expect(local().getAll('keyterm')).toEqual([]);
    expect(local().getAll('keywords')).toContain('Jos South:2');
    process.env.LOCAL_VOICE_STT_MODEL = 'nova-2; rm -rf /';
    expect(localSttModel()).toBe('nova-3');
  });
});

describe('the ElevenLabs agent', () => {
  it('is still told every place, the LGAs and the communities, once each', () => {
    const words = agentWords();
    for (const p of plateauPlaceWords()) expect(words).toContain(p);
    expect(words).toContain('Gyel');
    expect(new Set(words).size).toBe(words.length);
  });
});
