import { mulawBufferToSlin } from './pcm';
import { TtsCache } from './tts-cache';

/**
 * Text → slin16/8000, the format AudioSocket plays. Two engines:
 *
 *   - Azure Neural TTS, Nigerian English (`en-NG-AbeoNeural` by default) — the
 *     assistant's voice for every sentence of the conversation. Asked for
 *     `raw-8khz-16bit-mono-pcm`, which is AudioSocket's format exactly, so
 *     nothing is resampled on a live call.
 *   - ElevenLabs, ONLY for the Governor's recorded-voice opening (his cloned
 *     voice exists nowhere else). Rendered once per wording and kept on disk
 *     for good, so after the first call of each greeting nothing is fetched.
 *     `npm run voice:prerender` fills them all in advance, which is what lets
 *     the ElevenLabs subscription end without the Governor going silent.
 */
export interface SpeechEngine {
  readonly name: string;
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>;
}

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface AzureOptions {
  key: string;
  region: string;
  voice?: string;
  /** SSML prosody rate, e.g. "-8%". The agency found speed 1.0 too fast on ElevenLabs. */
  rate?: string;
}

export class AzureTts implements SpeechEngine {
  readonly name = 'azure';
  readonly voice: string;
  readonly rate: string;
  constructor(private readonly opts: AzureOptions) {
    this.voice = opts.voice || 'en-NG-AbeoNeural';
    this.rate = opts.rate || '-5%';
  }

  static fromEnv(): AzureTts | null {
    const key = process.env.AZURE_SPEECH_KEY?.trim();
    const region = process.env.AZURE_SPEECH_REGION?.trim();
    if (!key || !region) return null;
    return new AzureTts({ key, region, voice: process.env.AZURE_TTS_VOICE?.trim(), rate: process.env.AZURE_TTS_RATE?.trim() });
  }

  ssml(text: string): string {
    // A `<break time="1.0s" />` written in a stored greeting is honoured; any
    // other markup is the agent's, not the speaker's, and is dropped.
    const parts = text.split(/(<break\s+time="[\d.]+s"\s*\/>)/g).map((p) => {
      const b = p.match(/^<break\s+time="([\d.]+)s"\s*\/>$/);
      return b ? `<break time="${Math.min(5, Number(b[1]))}s"/>` : xml(p.replace(/<\/?[a-z][^>]*>/gi, ' '));
    });
    return (
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-NG">` +
      `<voice name="${xml(this.voice)}"><prosody rate="${xml(this.rate)}">${parts.join('')}</prosody></voice></speak>`
    );
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const res = await fetch(`https://${this.opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.opts.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'raw-8khz-16bit-mono-pcm',
        'User-Agent': 'citizen-contact-centre',
      },
      body: this.ssml(text),
      signal: signal ?? AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Azure TTS refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('Azure TTS returned no audio');
    return audio;
  }
}

export class ElevenLabsTts implements SpeechEngine {
  readonly name = 'elevenlabs';
  constructor(
    private readonly key: string,
    readonly voiceId: string,
    readonly modelId: string,
    private readonly settings: { stability: number; similarityBoost: number; speed: number },
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const clean = text.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.voiceId)}?output_format=ulaw_8000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.key, 'Content-Type': 'application/json', Accept: 'audio/basic' },
        body: JSON.stringify({
          text: clean,
          model_id: this.modelId,
          voice_settings: {
            stability: this.settings.stability,
            similarity_boost: this.settings.similarityBoost,
            speed: this.settings.speed,
          },
        }),
        signal: signal ?? AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) throw new Error(`ElevenLabs TTS refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const ulaw = Buffer.from(await res.arrayBuffer());
    if (!ulaw.length) throw new Error('ElevenLabs TTS returned no audio');
    return mulawBufferToSlin(ulaw);
  }
}

/**
 * Whether a sentence may be kept on disk. A digit (a phone number, a
 * reference, a date) or any of the caller's own words-of-identity makes it
 * personal; those are synthesised fresh and never written.
 */
export function isCacheable(text: string, personal: string[] = []): boolean {
  if (/\d/.test(text) || text.length > 400) return false;
  const lower = text.toLowerCase();
  return !personal.some((p) => p && p.length >= 3 && lower.includes(p.toLowerCase()));
}

/** An engine in front of the SSD cache. */
export class CachedSpeech {
  constructor(
    private readonly engine: SpeechEngine & { voice?: string; voiceId?: string; rate?: string },
    private readonly cache: TtsCache | null,
  ) {}

  get engineName(): string {
    return this.engine.name;
  }

  key(text: string): string {
    return TtsCache.keyOf(
      { engine: this.engine.name, voice: this.engine.voice ?? this.engine.voiceId ?? '', rate: this.engine.rate ?? '', format: 'slin8k' },
      text,
    );
  }

  async speak(text: string, opts: { personal?: string[]; signal?: AbortSignal; alwaysCache?: boolean } = {}): Promise<{ audio: Buffer; cached: boolean }> {
    const cacheable = !!this.cache && (opts.alwaysCache || isCacheable(text, opts.personal));
    const key = cacheable ? this.key(text) : '';
    if (cacheable) {
      const hit = this.cache!.get(key);
      if (hit) return { audio: hit, cached: true };
    }
    const audio = await this.engine.synthesize(text, opts.signal);
    if (cacheable) this.cache!.put(key, audio);
    return { audio, cached: false };
  }
}
