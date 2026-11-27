import { changeTempo, downsample24kTo8k, forPlayback, rms, wavFile, wavToSlin8k } from '../src/voice-local/pcm';
import { SENTENCE_GAP_MS, VoiceSession } from '../src/voice-local/voice-session';
import {
  assistantTtsFromEnv,
  AzureTts,
  CachedSpeech,
  DeepgramTts,
  ElevenLabsTts,
  isCacheable,
  OpenAiTts,
  resetSpitchCircuit,
  spitchCircuitState,
  SpitchTts,
  StaticGovernorAudio,
  YarnGptTts,
  spitchDeadlineMs,
  spitchSlotsInUse,
} from '../src/voice-local/tts';
import { PLATEAU_FEMALE_NAMES, PLATEAU_MALE_NAMES, SYSTEM_PROMPT, pickPlateauPersona } from '../src/agent-tools/agent-tool-catalog';

describe('voice-local TTS providers & PCM downsampling', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  /** RMS gain in dB of a pure tone at `hz` through the 24 kHz → 8 kHz path. */
  const toneGainDb = (hz: number, rate = 24000, decode: (pcm: Buffer) => Buffer = (pcm) => wavToSlin8k(wavFile(pcm, 1, rate))) => {
    const n = Math.round(rate / 4); // a quarter second
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(10000 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2);
    const out = decode(pcm);
    let sum = 0;
    const m = out.length / 2;
    for (let i = 200; i < m - 200; i++) sum += out.readInt16LE(i * 2) ** 2;
    return 20 * Math.log10(Math.sqrt(sum / (m - 400)) / (10000 / Math.SQRT2));
  };

  it('keeps the whole telephone band and removes what would alias, for every resampled engine', () => {
    // Speech clarity lives at 2–3.4 kHz ("s", "f", "t"). The triangular filter
    // this replaced was -5.6 dB at 3 kHz and -7.4 dB at 3.4 kHz (muffled), and
    // let a 9 kHz sibilant fold onto 1 kHz at only -25 dB (metallic).
    for (const decode of [undefined, downsample24kTo8k]) {
      for (const hz of [300, 1000, 2000, 3000, 3400]) expect(Math.abs(toneGainDb(hz, 24000, decode))).toBeLessThan(0.5);
      for (const hz of [4500, 6000, 9000, 10000, 11000]) expect(toneGainDb(hz, 24000, decode)).toBeLessThan(-60);
    }
    for (const rate of [16000, 22050, 44100, 48000]) {
      expect(Math.abs(toneGainDb(3000, rate))).toBeLessThan(0.5);
      expect(toneGainDb(5000, rate)).toBeLessThan(-60);
    }
  });

  it('downsamples 24 kHz 16-bit mono PCM to 8 kHz at exactly a third of the length', () => {
    const pcm24k = Buffer.alloc(24000 * 2);
    for (let i = 0; i < 24000; i++) pcm24k.writeInt16LE(700, i * 2);
    const pcm8k = downsample24kTo8k(pcm24k);
    expect(pcm8k.length).toBe(8000 * 2);
    // DC is exact everywhere, edges included.
    for (const i of [0, 1, 4000, 7999]) expect(pcm8k.readInt16LE(i * 2)).toBe(700);
  });

  it('decodes and resamples 24 kHz WAV (YarnGPT output) to 8 kHz slin16', () => {
    const pcm24k = Buffer.alloc(12);
    for (let i = 0; i < 6; i++) pcm24k.writeInt16LE(1000, i * 2);
    const wav = wavFile(pcm24k, 1, 24000);
    const slin = wavToSlin8k(wav);
    expect(slin.length).toBe(4);
    expect(slin.readInt16LE(0)).toBe(1000);
    expect(slin.readInt16LE(2)).toBe(1000);
  });

  it('reads a streamed WAV whose header does not know its length (data size 0 or 0xFFFFFFFF)', () => {
    // Read as "no audio" this used to throw, and the call failed over to ElevenLabs.
    const pcm = Buffer.alloc(2400 * 2);
    for (let i = 0; i < 2400; i++) pcm.writeInt16LE(1200, i * 2);
    for (const size of [0, 0xffffffff]) {
      const wav = wavFile(pcm, 1, 24000);
      wav.writeUInt32LE(size, 40);
      wav.writeUInt32LE(size, 4);
      const out = wavToSlin8k(wav);
      expect(out.length).toBe(800 * 2);
      expect(out.readInt16LE(400 * 2)).toBe(1200);
    }
  });

  it('reads 32-bit float and 24-bit WAV, and names what it cannot read', () => {
    const float = Buffer.alloc(44 + 2400 * 4);
    wavFile(Buffer.alloc(0), 1, 24000).copy(float);
    float.writeUInt16LE(3, 20); // IEEE float
    float.writeUInt16LE(32, 34);
    float.writeUInt32LE(2400 * 4, 40);
    for (let i = 0; i < 2400; i++) float.writeFloatLE(0.25, 44 + i * 4);
    expect(wavToSlin8k(float).readInt16LE(400 * 2)).toBe(Math.round(0.25 * 32767));

    const i24 = Buffer.alloc(44 + 2400 * 3);
    wavFile(Buffer.alloc(0), 1, 24000).copy(i24);
    i24.writeUInt16LE(24, 34);
    i24.writeUInt32LE(2400 * 3, 40);
    for (let i = 0; i < 2400; i++) i24.writeIntLE(1000 * 256, 44 + i * 3, 3);
    expect(wavToSlin8k(i24).readInt16LE(400 * 2)).toBe(1000);

    expect(() => wavToSlin8k(Buffer.from('ID3\x04 this is an mp3, not a wav file at all, padded out....'))).toThrow(/Invalid WAV buffer.*ID3/);
  });

  it('trims an engine\'s padding to a fixed short pause and fades the edges, so sentences neither gap nor click', () => {
    const speech = Buffer.alloc(8000 * 2); // 1 s: 400 ms silence, 200 ms speech at full level, 400 ms silence
    for (let i = 3200; i < 4800; i++) speech.writeInt16LE(i % 2 ? 9000 : -9000, i * 2);
    const out = forPlayback(speech);
    // 30 ms lead + 200 ms speech + 130 ms trail.
    expect(out.length / 2).toBe(240 + 1600 + 1040);
    expect(out.readInt16LE(0)).toBe(0);
    expect(out.readInt16LE(out.length - 2)).toBe(0);
    // A clip that starts at full level is faded in, not clicked in.
    const hot = Buffer.alloc(800 * 2, 0);
    for (let i = 0; i < 800; i++) hot.writeInt16LE(12000, i * 2);
    const faded = forPlayback(hot);
    expect(faded.readInt16LE(0)).toBe(0);
    expect(Math.abs(faded.readInt16LE(2))).toBeLessThan(12000 / 10);
    // Pure silence (a deliberate pause) is left alone.
    expect(forPlayback(Buffer.alloc(1600)).length).toBe(1600);
  });

  it('re-renders cached clips from resampled engines after a resampler change, never the Governor\'s ElevenLabs clips', () => {
    const spitch = new CachedSpeech(new SpitchTts({ key: 'k', voice: 'jude' }), null);
    const legacySpitchKey = require('../src/voice-local/tts-cache').TtsCache.keyOf(
      { engine: 'spitch', voice: 'jude', rate: '1.0', format: 'slin8k' },
      'Hello.',
    );
    expect(spitch.key('Hello.')).not.toBe(legacySpitchKey);
    const gov = new CachedSpeech(new ElevenLabsTts('k', 'gov', 'm', { stability: 0.5, similarityBoost: 0.5, speed: 0.9 }) as any, null);
    const legacyGovKey = require('../src/voice-local/tts-cache').TtsCache.keyOf(
      { engine: 'elevenlabs', voice: 'gov', rate: '', format: 'slin8k' },
      'Good morning.',
    );
    expect(gov.key('Good morning.')).toBe(legacyGovKey);
  });

  it('never lets more Spitch requests run at once than the limit, even as slots are handed over', async () => {
    process.env.SPITCH_MAX_CONCURRENCY = '2';
    const realFetch = global.fetch;
    let inFlight = 0;
    let peak = 0;
    const wav = wavFile(Buffer.alloc(480), 1, 24000);
    (global as any).fetch = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return new Response(new Uint8Array(wav), { status: 200 });
    };
    try {
      const tts = new SpitchTts({ key: 'k' });
      const all: Promise<Buffer>[] = [];
      for (let i = 0; i < 8; i++) {
        all.push(tts.synthesize(`sentence ${i}`));
        // Newcomers arrive while slots are being released.
        if (i % 3 === 2) await new Promise((r) => setTimeout(r, 16));
      }
      await Promise.all(all);
      expect(peak).toBeLessThanOrEqual(2);
      expect(spitchSlotsInUse()).toBe(0);
    } finally {
      (global as any).fetch = realFetch;
    }
  });

  it('gives up on a speech provider that never answers, even when the call passes its own signal', async () => {
    const realFetch = global.fetch;
    (global as any).fetch = (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
    const realTimeout = AbortSignal.timeout;
    (AbortSignal as any).timeout = () => realTimeout.call(AbortSignal, 30);
    try {
      const turn = new AbortController(); // a live call's barge-in signal, never aborted here
      await expect(new SpitchTts({ key: 'k' }).synthesize('Hello', turn.signal)).rejects.toBeTruthy();
    } finally {
      (global as any).fetch = realFetch;
      (AbortSignal as any).timeout = realTimeout;
    }
  });

  describe('speaking faster without changing the voice (changeTempo)', () => {
    /** A voice-like test signal: 140 Hz fundamental with harmonics, a slow vibrato and syllable-rate loudness. */
    const voiceLike = (secs: number) => {
      const n = Math.round(8000 * secs);
      const b = Buffer.alloc(n * 2);
      let phase = 0;
      for (let i = 0; i < n; i++) {
        const t = i / 8000;
        phase += (2 * Math.PI * (140 + 6 * Math.sin(2 * Math.PI * 5 * t))) / 8000;
        const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
        const v = Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);
        b.writeInt16LE(Math.round(6000 * syllable * v), i * 2);
      }
      return b;
    };
    /** Fundamental by autocorrelation over 60-400 Hz. */
    const pitchHz = (b: Buffer) => {
      const n = Math.min(4000, b.length / 2);
      const x = Array.from({ length: n }, (_, i) => b.readInt16LE(i * 2));
      let bestLag = 0;
      let best = -Infinity;
      for (let lag = 20; lag <= 133; lag++) {
        let s = 0;
        for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
        if (s > best) ((best = s), (bestLag = lag));
      }
      return 8000 / bestLag;
    };
    const maxJump = (b: Buffer) => {
      let m = 0;
      for (let i = 2; i < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i) - b.readInt16LE(i - 2)));
      return m;
    };

    it.each([1.1, 1.15, 1.25])('at %s x: shorter by exactly that factor, same pitch, no clicks', (speed) => {
      const input = voiceLike(4);
      const out = changeTempo(input, speed);
      const ratio = input.length / out.length;
      expect(Math.abs(ratio - speed) / speed).toBeLessThan(0.01);
      expect(Math.abs(pitchHz(out.subarray(4000, 12000)) - pitchHz(input.subarray(4000, 12000)))).toBeLessThan(6); // Hz
      // A splice that misaligned would show as a jump far larger than the signal's own steepest slope.
      expect(maxJump(out)).toBeLessThan(maxJump(input) * 1.6);
    });

    it('speed 1 is the input untouched, and the speed is part of the cache key only when it changes the sound', () => {
      const input = voiceLike(1);
      expect(changeTempo(input, 1)).toBe(input);
      expect(new SpitchTts({ key: 'k' }).rate).toBe('1.0'); // every clip already on disk keeps its key
      expect(new SpitchTts({ key: 'k', speed: 1.15 }).rate).toBe('1.15');
      expect(new CachedSpeech(new SpitchTts({ key: 'k', speed: 1.15 }), null).key('Hi.')).not.toBe(new CachedSpeech(new SpitchTts({ key: 'k' }), null).key('Hi.'));
      process.env.SPITCH_API_KEY = 'k';
      process.env.SPITCH_SPEED = '1.15';
      expect((SpitchTts.fromEnv() as SpitchTts).speed).toBe(1.15);
      process.env.SPITCH_SPEED = '7';
      expect((SpitchTts.fromEnv() as SpitchTts).speed).toBe(1); // out of range is ignored, not obeyed
    });
  });

  it('gives Spitch longer for longer text, within a ceiling', () => {
    expect(spitchDeadlineMs('Okay, let me check.')).toBe(15_000 + 100 * 19);
    // The 155-character recording notice that overran a flat 15 s on a real call.
    expect(spitchDeadlineMs('x'.repeat(155))).toBe(30_500);
    expect(spitchDeadlineMs('x'.repeat(1000))).toBe(45_000);
  });

  it('selects TTS provider by LOCAL_VOICE_TTS_PROVIDER or falls back Spitch -> YarnGPT -> Azure -> OpenAI -> Deepgram', () => {
    delete process.env.LOCAL_VOICE_TTS_PROVIDER;
    delete process.env.SPITCH_API_KEY;
    delete process.env.YARNGPT_API_KEY;
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.DEEPGRAM_API_KEY = 'dg-test';

    expect(assistantTtsFromEnv()).toBeInstanceOf(OpenAiTts);

    process.env.LOCAL_VOICE_TTS_PROVIDER = 'deepgram';
    expect(assistantTtsFromEnv()).toBeInstanceOf(DeepgramTts);

    process.env.LOCAL_VOICE_TTS_PROVIDER = 'openai';
    expect(assistantTtsFromEnv()).toBeInstanceOf(OpenAiTts);

    delete process.env.LOCAL_VOICE_TTS_PROVIDER;
    process.env.AZURE_SPEECH_KEY = 'az-key';
    process.env.AZURE_SPEECH_REGION = 'westeurope';
    expect(assistantTtsFromEnv()).toBeInstanceOf(AzureTts);

    process.env.YARNGPT_API_KEY = 'yg-test';
    expect(assistantTtsFromEnv()).toBeInstanceOf(YarnGptTts);

    process.env.SPITCH_API_KEY = 'sp-test';
    expect(assistantTtsFromEnv()).toBeInstanceOf(SpitchTts);
  });

  it('matches Plateau male and female personas to Nigerian male (jude) and female (lucy) Spitch voices', () => {
    process.env.SPITCH_API_KEY = 'sp-test';
    delete process.env.SPITCH_VOICE;
    delete process.env.SPITCH_FEMALE_VOICE;
    delete process.env.LOCAL_VOICE_TTS_PROVIDER;

    const femalePersona = pickPlateauPersona('female');
    expect(PLATEAU_FEMALE_NAMES).toHaveLength(100);
    expect(new Set(PLATEAU_FEMALE_NAMES).size).toBe(100);
    expect(femalePersona.gender).toBe('female');
    expect(PLATEAU_FEMALE_NAMES).toContain(femalePersona.name);
    const femaleEngine = assistantTtsFromEnv(femalePersona.gender) as SpitchTts;
    expect(femaleEngine).toBeInstanceOf(SpitchTts);
    expect(femaleEngine.voice).toBe('lucy');

    const malePersona = pickPlateauPersona('male');
    expect(malePersona.gender).toBe('male');
    expect(PLATEAU_MALE_NAMES).toContain(malePersona.name);
    const maleEngine = assistantTtsFromEnv(malePersona.gender) as SpitchTts;
    expect(maleEngine).toBeInstanceOf(SpitchTts);
    expect(maleEngine.voice).toBe('jude');
  });

  it('opens the Spitch circuit breaker after 3 consecutive failures and fails fast without calling fetch', async () => {
    resetSpitchCircuit();
    const realFetch = global.fetch;
    let calls = 0;
    global.fetch = (async () => {
      calls++;
      return new Response('upstream error', { status: 503 });
    }) as any;
    try {
      const spitch = new SpitchTts({ key: 'sp-test', voice: 'jude' });
      for (let i = 0; i < 3; i++) {
        await expect(spitch.synthesize('Hello Plateau State')).rejects.toThrow(/HTTP 503/);
      }
      expect(calls).toBe(3);
      expect(spitchCircuitState().open).toBe(true);
      await expect(spitch.synthesize('Hello again')).rejects.toThrow(/circuit open/);
      expect(calls).toBe(3); // failed fast — no extra network call
    } finally {
      global.fetch = realFetch;
      resetSpitchCircuit();
    }
  });

  it('never caches citizen personal names, phone numbers, or reference numbers in shared tts-cache', () => {
    expect(isCacheable('Welcome back, Steven.', ['Steven'])).toBe(false);
    expect(isCacheable('Your reference number is PS-2026-0042.', [])).toBe(false);
    expect(isCacheable('We will call you on 08031234567.', [])).toBe(false);
    expect(isCacheable('To help us resolve your issue, this call is being recorded.', ['Steven'])).toBe(true);
  });

  it('plays ONLY the 3 approved studio Governor WAV recordings with zero network TTS calls', async () => {
    const gov = StaticGovernorAudio.fromDisk();
    expect(gov).not.toBeNull();
    const realFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = (async () => {
      fetchCalls++;
      throw new Error('must never call network TTS for approved Governor greetings');
    }) as any;
    try {
      const morning = await gov!.synthesize('Good morning, and welcome to the Plateau State Government Citizen Contact Centre.');
      const afternoon = await gov!.synthesize('Good afternoon, and welcome to the Plateau State Government Citizen Contact Centre.');
      const evening = await gov!.synthesize('Good evening, and welcome to the Plateau State Government Citizen Contact Centre.');
      // All 3 approved clips are ~8.7–8.9s at 8 kHz 16-bit mono (~139 KB each) and distinct.
      expect(morning.length).toBeGreaterThan(100_000);
      expect(afternoon.length).toBeGreaterThan(100_000);
      expect(evening.length).toBeGreaterThan(100_000);
      expect(morning.equals(afternoon)).toBe(false);
      expect(afternoon.equals(evening)).toBe(false);
      expect(morning.equals(evening)).toBe(false);
      expect(fetchCalls).toBe(0);
    } finally {
      global.fetch = realFetch;
    }
  });

  it('pre-buffers multi-sentence replies so a slower second sentence never causes a mid-speech silence gap', async () => {
    const tone = (ms: number) => {
      const buf = Buffer.alloc(ms * 16);
      for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(Math.round(5000 * Math.sin(i / 3)), i * 2);
      return buf;
    };
    const logs: Array<{ event: string; detail?: Record<string, unknown> }> = [];
    const sentFrames: Buffer[] = [];
    let sttEvents: any = null;
    const engine = {
      name: 'spitch',
      voice: 'jude',
      async synthesize(text: string): Promise<Buffer> {
        // Sentence 1 returns fast (15 ms, short 120 ms clip); Sentence 2 takes 260 ms
        // (longer than Sentence 1's duration). Without pre-buffering, playQueue would
        // underrun and emit dead silence between the two sentences.
        if (text.includes('water project')) {
          await new Promise((r) => setTimeout(r, 260));
          return tone(160);
        }
        await new Promise((r) => setTimeout(r, 15));
        return tone(120);
      },
    };
    const session = new VoiceSession(
      {
        sendAudio: (frame) => sentFrames.push(frame),
        close: () => undefined,
        stt: async (events) => {
          sttEvents = events;
          return { send: () => undefined, close: () => undefined };
        },
        assistantVoice: new CachedSpeech(engine as any, null),
        governorVoice: null,
        llm: async function* () {
          yield { type: 'text', delta: 'Sure, I can help you with that. ' };
          yield { type: 'text', delta: 'The water project in Jos North is currently active.' };
        },
        tools: [],
        runTool: async () => ({ ok: true }),
        log: (event, detail) => logs.push({ event, detail }),
      },
      { systemPrompt: 'test', opening: 'Hello.', personal: [] },
    );

    await session.start();
    // Wait for opening to drain, then clear captured frames before the caller's turn.
    await new Promise((r) => setTimeout(r, 220));
    sentFrames.length = 0;

    sttEvents.onFinal('Tell me about the water project', true);
    const deadlineAt = Date.now() + 3_000;
    while (Date.now() < deadlineAt && (session.busy || !logs.some((l) => l.event === 'voice_local_turn'))) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await session.finish('completed');

    expect(logs.some((l) => l.event === 'voice_local_turn')).toBe(true);
    expect(logs.some((l) => l.event === 'voice_local_playback_underrun')).toBe(false);

    // Measure the longest silent run strictly between the first audible frame and last audible frame.
    const audibleIndices = sentFrames.map((f, idx) => (rms(f) > 200 ? idx : -1)).filter((i) => i >= 0);
    expect(audibleIndices.length).toBeGreaterThanOrEqual(10);
    const firstAudible = audibleIndices[0];
    const lastAudible = audibleIndices[audibleIndices.length - 1];
    let maxSilentRun = 0;
    let curSilentRun = 0;
    for (let i = firstAudible; i <= lastAudible; i++) {
      if (rms(sentFrames[i]) <= 200) {
        curSilentRun++;
        maxSilentRun = Math.max(maxSilentRun, curSilentRun);
      } else {
        curSilentRun = 0;
      }
    }
    // Only the deliberate pause between sentences (SENTENCE_GAP_MS, plus the
    // clips' own trim pads) — never a slow second sentence's mid-speech gap.
    expect(maxSilentRun).toBeLessThanOrEqual(Math.ceil((SENTENCE_GAP_MS + 160) / 20) + 1);
  });

  it('guards SYSTEM_PROMPT against filler names, personal cash handout tickets, and Bukuru/Gyel ASR mishears', () => {
    expect(SYSTEM_PROMPT).toContain('NEVER ACCEPT FILLERS OR NON-ANSWERS AS A NAME OR LOCATION');
    expect(SYSTEM_PROMPT).toContain('Out-of-scope, personal cash handouts, or unrealistic/prank requests (DO NOT LOG A TICKET)');
    expect(SYSTEM_PROMPT).toContain('Bukuru Lowcost');
    expect(SYSTEM_PROMPT).toContain('Gyel D');
  });
});
