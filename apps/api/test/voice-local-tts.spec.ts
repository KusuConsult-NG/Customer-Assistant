import { downsample24kTo8k, wavFile, wavToSlin8k } from '../src/voice-local/pcm';
import { assistantTtsFromEnv, AzureTts, DeepgramTts, OpenAiTts, SpitchTts, YarnGptTts } from '../src/voice-local/tts';
import { PLATEAU_FEMALE_NAMES, PLATEAU_MALE_NAMES, pickPlateauPersona } from '../src/agent-tools/agent-tool-catalog';

describe('voice-local TTS providers & PCM downsampling', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('downsamples 24 kHz 16-bit mono PCM to 8 kHz exact length with 3-tap averaging', () => {
    // 6 samples at 24 kHz -> 2 samples at 8 kHz
    const pcm24k = Buffer.alloc(12);
    pcm24k.writeInt16LE(300, 0);
    pcm24k.writeInt16LE(600, 2);
    pcm24k.writeInt16LE(900, 4);
    pcm24k.writeInt16LE(-300, 6);
    pcm24k.writeInt16LE(-600, 8);
    pcm24k.writeInt16LE(-900, 10);

    const pcm8k = downsample24kTo8k(pcm24k);
    expect(pcm8k.length).toBe(4);
    expect(pcm8k.readInt16LE(0)).toBe(600);
    expect(pcm8k.readInt16LE(2)).toBe(-600);
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
});
