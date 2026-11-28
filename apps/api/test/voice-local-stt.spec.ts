import { deepgramUrl, dispatchDeepgram, silenceAfterLastWord, utteranceEndMs, type SttEvents } from '../src/voice-local/stt';

const recorder = () => {
  const calls: any[] = [];
  const events: SttEvents = {
    onInterim: (t) => calls.push(['interim', t]),
    onFinal: (t, end, silence) => calls.push(['final', t, end, silence]),
    onUtteranceEnd: (silence) => calls.push(['utterance_end', silence]),
    onError: () => undefined,
  };
  return { calls, events };
};

describe('speech recognition: how a turn ends', () => {
  const saved = process.env.LOCAL_VOICE_UTTERANCE_END_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.LOCAL_VOICE_UTTERANCE_END_MS;
    else process.env.LOCAL_VOICE_UTTERANCE_END_MS = saved;
  });

  it('ends a turn 1.0 s after the last word when line noise keeps the silence detector from firing (was 1.2 s)', () => {
    delete process.env.LOCAL_VOICE_UTTERANCE_END_MS;
    expect(utteranceEndMs()).toBe(1_000);
    expect(deepgramUrl()).toContain('utterance_end_ms=1000');
    process.env.LOCAL_VOICE_UTTERANCE_END_MS = '1500';
    expect(utteranceEndMs()).toBe(1_500);
    for (const [v, want] of [['500', 1_000], ['9000', 3_000], ['soon', 1_000]] as const) {
      process.env.LOCAL_VOICE_UTTERANCE_END_MS = v;
      expect(utteranceEndMs()).toBe(want); // Deepgram refuses less than 1000
    }
  });

  it("reports the silence Deepgram heard after the caller's last word, from its own audio clock", () => {
    const { calls, events } = recorder();
    dispatchDeepgram(
      {
        type: 'Results',
        is_final: true,
        speech_final: true,
        start: 3.0,
        duration: 2.0,
        channel: { alternatives: [{ transcript: 'I am in Jos South', words: [{ word: 'south', end: 4.55 }] }] },
      },
      events,
    );
    expect(calls).toEqual([['final', 'I am in Jos South', true, 450]]);
  });

  it('a final piece within the turn carries no silence; interim words are passed on; the word-gap fallback says its gap', () => {
    const { calls, events } = recorder();
    dispatchDeepgram({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'I am' }] } }, events);
    dispatchDeepgram({ type: 'Results', is_final: true, speech_final: false, start: 0, duration: 1, channel: { alternatives: [{ transcript: 'I am', words: [{ end: 0.8 }] }] } }, events);
    dispatchDeepgram({ type: 'UtteranceEnd', last_word_end: 0.8 }, events);
    dispatchDeepgram({ type: 'Metadata' }, events);
    expect(calls).toEqual([
      ['interim', 'I am'],
      ['final', 'I am', false, undefined],
      ['utterance_end', 1_000],
    ]);
  });

  it('never invents a silence from missing or backwards timestamps', () => {
    expect(silenceAfterLastWord(undefined, 1)).toBeUndefined();
    expect(silenceAfterLastWord(1, 2)).toBeUndefined();
    expect(silenceAfterLastWord(2.5, 2.1)).toBe(400);
  });
});
