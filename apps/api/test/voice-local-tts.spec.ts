import { downsample24kTo8k } from '../src/voice-local/pcm';
import { assistantTtsFromEnv, AzureTts, DeepgramTts, OpenAiTts } from '../src/voice-local/tts';

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

  it('selects TTS provider by LOCAL_VOICE_TTS_PROVIDER or falls back Azure -> OpenAI -> Deepgram', () => {
    delete process.env.LOCAL_VOICE_TTS_PROVIDER;
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
  });
});
