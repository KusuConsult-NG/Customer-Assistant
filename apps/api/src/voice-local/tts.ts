import { changeTempo, downsample24kTo8k, mulawBufferToSlin, wavToSlin8k } from './pcm';
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
  /**
   * Version of OUR processing of this engine's audio (resampling). Part of the
   * cache key, so a clip rendered through an older resampler is not replayed
   * from disk for ever after the resampler is fixed. Unset for engines that
   * deliver 8 kHz themselves, whose cached clips stay valid.
   */
  readonly dsp?: string;
  synthesize(text: string, signal?: AbortSignal): Promise<Buffer>;
}

/** Bumped whenever resampling changes what a resampled engine's clip sounds like. */
export const RESAMPLER_VERSION = 'kaiser-3400-v2';

/**
 * The turn's abort signal AND a deadline. A live call passes its own signal
 * (barge-in cancels synthesis); on its own that signal has no deadline, so a
 * provider that accepts the request and never answers left the caller in
 * silence for the rest of the call instead of failing over.
 */
export function deadline(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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
      signal: deadline(signal, 10_000),
    });
    if (!res.ok) throw new Error(`Azure TTS refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('Azure TTS returned no audio');
    return audio;
  }
}

export class OpenAiTts implements SpeechEngine {
  readonly name = 'openai';
  readonly dsp = RESAMPLER_VERSION;
  readonly voice: string;
  readonly model: string;
  readonly rate: string;
  readonly instructions: string;
  constructor(private readonly opts: { key: string; voice?: string; model?: string; speed?: number; instructions?: string }) {
    this.voice = opts.voice || 'ash';
    this.model = opts.model || 'gpt-4o-mini-tts';
    this.rate = String(opts.speed ?? 0.96);
    this.instructions =
      opts.instructions ||
      'Speak warmly, calmly, and clearly in a natural Nigerian English accent at a steady, easy-to-follow telephone pace.';
  }

  static fromEnv(): OpenAiTts | null {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) return null;
    const speedRaw = Number(process.env.OPENAI_TTS_SPEED);
    return new OpenAiTts({
      key,
      voice: process.env.OPENAI_TTS_VOICE?.trim() || undefined,
      model: process.env.OPENAI_TTS_MODEL?.trim() || undefined,
      speed: Number.isFinite(speedRaw) && speedRaw >= 0.5 && speedRaw <= 2 ? speedRaw : undefined,
      instructions: process.env.OPENAI_TTS_INSTRUCTIONS?.trim() || undefined,
    });
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const clean = text.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        voice: this.voice,
        input: clean,
        response_format: 'pcm',
        speed: Number(this.rate),
        ...(this.model.includes('gpt-4o-mini-tts') ? { instructions: this.instructions } : {}),
      }),
      signal: deadline(signal, 15_000),
    });
    if (!res.ok) throw new Error(`OpenAI TTS refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const pcm24k = Buffer.from(await res.arrayBuffer());
    if (!pcm24k.length) throw new Error('OpenAI TTS returned no audio');
    return downsample24kTo8k(pcm24k);
  }
}

export class DeepgramTts implements SpeechEngine {
  readonly name = 'deepgram';
  readonly voice: string;
  readonly rate = '1.0';
  constructor(private readonly opts: { key: string; model?: string }) {
    this.voice = opts.model || 'aura-2-orion-en';
  }

  static fromEnv(): DeepgramTts | null {
    const key = process.env.DEEPGRAM_API_KEY?.trim();
    if (!key) return null;
    return new DeepgramTts({ key, model: process.env.DEEPGRAM_TTS_MODEL?.trim() || undefined });
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const clean = text.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
    const url =
      `https://api.deepgram.com/v1/speak?model=${encodeURIComponent(this.voice)}` +
      '&encoding=linear16&sample_rate=8000&container=none';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.opts.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: clean }),
      signal: deadline(signal, 10_000),
    });
    if (!res.ok) throw new Error(`Deepgram TTS refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    if (!audio.length) throw new Error('Deepgram TTS returned no audio');
    return audio;
  }
}

export class YarnGptTts implements SpeechEngine {
  readonly name = 'yarngpt';
  readonly dsp = RESAMPLER_VERSION;
  readonly voice: string;
  readonly rate = '1.0';
  private readonly baseUrl: string;
  constructor(private readonly opts: { key: string; voice?: string; url?: string }) {
    this.voice = opts.voice || 'umar';
    this.baseUrl = (opts.url || 'https://api.yarngpt.ai').replace(/\/+$/, '');
  }

  static fromEnv(): YarnGptTts | null {
    const key = process.env.YARNGPT_API_KEY?.trim();
    if (!key) return null;
    return new YarnGptTts({
      key,
      voice: process.env.YARNGPT_VOICE?.trim() || undefined,
      url: process.env.YARNGPT_API_URL?.trim() || undefined,
    });
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const clean = text.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
    const timeout = deadline(signal, 30_000);
    const prep = await fetch(`${this.baseUrl}/api/v1/tts/prepare`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.opts.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: clean,
        voice: this.voice,
        output_format: 'wav',
      }),
      signal: timeout,
    });
    if (!prep.ok) {
      throw new Error(`YarnGPT prepare refused (HTTP ${prep.status}) ${(await prep.text().catch(() => '')).slice(0, 200)}`);
    }
    const meta = (await prep.json()) as { stream_url?: string };
    if (!meta?.stream_url) throw new Error('YarnGPT prepare returned no stream_url');
    const streamUrl = meta.stream_url.startsWith('http') ? meta.stream_url : `${this.baseUrl}${meta.stream_url}`;
    const res = await fetch(streamUrl, { signal: timeout });
    if (!res.ok) {
      throw new Error(`YarnGPT stream refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    const wav = Buffer.from(await res.arrayBuffer());
    if (!wav.length) throw new Error('YarnGPT stream returned no audio');
    return wavToSlin8k(wav);
  }
}

// Shared in-process concurrency gate for Spitch API requests so parallel
// sentence pre-fetching (e.g. speakOpening) never trips Tier 1's 3-request cap.
let spitchInFlight = 0;
const spitchQueue: Array<() => void> = [];

function spitchMaxConcurrency(): number {
  const n = Number(process.env.SPITCH_MAX_CONCURRENCY || 2);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

async function withSpitchSlot<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (spitchInFlight >= spitchMaxConcurrency()) {
    // Wait for a slot to be HANDED over: the releasing request passes its slot
    // to the first waiter without giving it back, so a newcomer arriving in
    // between cannot take it too and make it three in flight (Tier 1's cap).
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const idx = spitchQueue.indexOf(wake);
        if (idx >= 0) spitchQueue.splice(idx, 1);
        reject(signal?.reason ?? new Error('Spitch request aborted'));
      };
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      spitchQueue.push(wake);
    });
  } else {
    spitchInFlight++;
  }
  try {
    return await fn();
  } finally {
    const next = spitchQueue.shift();
    if (next) next();
    else spitchInFlight--;
  }
}

/** For tests: how many Spitch requests hold a slot right now. */
export function spitchSlotsInUse(): number {
  return spitchInFlight;
}

/** A speaking-rate multiplier from the environment, 0.5–2; anything else is 1 (unchanged). */
export function speedFromEnv(name: string, fallback = 1): number {
  const v = Number(process.env[name]?.trim());
  return Number.isFinite(v) && v >= 0.5 && v <= 2 ? v : fallback;
}

export class SpitchTts implements SpeechEngine {
  readonly name = 'spitch';
  readonly dsp = RESAMPLER_VERSION;
  readonly voice: string;
  readonly language: string;
  /** Part of the cache key: a clip made at another speed is never replayed. '1.0' is the speed every existing clip was made at. */
  readonly rate: string;
  readonly speed: number;
  private readonly baseUrl: string;
  constructor(private readonly opts: { key: string; voice?: string; language?: string; url?: string; speed?: number }) {
    this.voice = opts.voice || 'jude';
    this.language = opts.language || 'en';
    this.baseUrl = (opts.url || 'https://api.spitch.app').replace(/\/+$/, '');
    this.speed = opts.speed && Number.isFinite(opts.speed) && opts.speed >= 0.5 && opts.speed <= 2 ? opts.speed : 1;
    this.rate = Math.abs(this.speed - 1) < 0.005 ? '1.0' : this.speed.toFixed(2);
  }

  static fromEnv(gender?: 'male' | 'female'): SpitchTts | null {
    const key = process.env.SPITCH_API_KEY?.trim();
    if (!key) return null;
    const defaultVoice =
      gender === 'female'
        ? process.env.SPITCH_FEMALE_VOICE?.trim() || 'lucy'
        : process.env.SPITCH_VOICE?.trim() || 'jude';
    return new SpitchTts({
      key,
      voice: defaultVoice,
      language: process.env.SPITCH_LANGUAGE?.trim() || undefined,
      url: process.env.SPITCH_API_URL?.trim() || undefined,
      speed: speedFromEnv('SPITCH_SPEED'),
    });
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
    const clean = text.replace(/<\/?[a-z][^>]*>/gi, ' ').replace(/\s+/g, ' ').trim();
    const attempt = async (): Promise<Buffer> => {
      let lastErr = '';
      for (let tries = 0; tries < 3; tries++) {
        const res = await fetch(`${this.baseUrl}/v1/speech`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.opts.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: clean,
            language: this.language,
            voice: this.voice,
            format: 'wav',
          }),
          signal: deadline(signal, 15_000),
        });
        if (res.status === 429 && tries < 2) {
          lastErr = (await res.text().catch(() => '')).slice(0, 200);
          const after = Number(res.headers.get('retry-after'));
          const waitMs = Number.isFinite(after) && after > 0 ? Math.min(2_000, after * 1000) : 350 * (tries + 1);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (!res.ok) {
          throw new Error(`Spitch TTS refused (HTTP ${res.status}) ${(await res.text().catch(() => '')).slice(0, 200)}`);
        }
        const wav = Buffer.from(await res.arrayBuffer());
        if (!wav.length) throw new Error('Spitch TTS returned no audio');
        return changeTempo(wavToSlin8k(wav), this.speed);
      }
      throw new Error(`Spitch TTS refused (HTTP 429) ${lastErr}`);
    };
    return withSpitchSlot(attempt, signal);
  }
}

/**
 * Resolve the assistant's TTS engine from environment variables.
 * Honours `LOCAL_VOICE_TTS_PROVIDER` (`spitch` | `yarngpt` | `azure` | `openai` | `deepgram`) when set;
 * otherwise prefers Spitch (Nigerian English/languages), then YarnGPT, then Azure, then OpenAI, then Deepgram.
 */
export function assistantTtsFromEnv(gender?: 'male' | 'female'): SpeechEngine | null {
  const preferred = process.env.LOCAL_VOICE_TTS_PROVIDER?.trim().toLowerCase();
  if (preferred === 'spitch') return SpitchTts.fromEnv(gender);
  if (preferred === 'yarngpt') return YarnGptTts.fromEnv();
  if (preferred === 'azure') return AzureTts.fromEnv();
  if (preferred === 'openai') return OpenAiTts.fromEnv();
  if (preferred === 'deepgram') return DeepgramTts.fromEnv();
  return SpitchTts.fromEnv(gender) ?? YarnGptTts.fromEnv() ?? AzureTts.fromEnv() ?? OpenAiTts.fromEnv() ?? DeepgramTts.fromEnv();
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
        signal: deadline(signal, 15_000),
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
      {
        engine: this.engine.name,
        voice: this.engine.voice ?? this.engine.voiceId ?? '',
        rate: this.engine.rate ?? '',
        format: 'slin8k',
        // Only for resampled engines, so the Governor's ElevenLabs clips (8 kHz
        // µ-law, never resampled) keep their keys and stay playable without a key.
        ...(this.engine.dsp ? { dsp: this.engine.dsp } : {}),
      },
      text,
    );
  }

  /** The clip if it is already on disk, without synthesising: for words that are only worth saying at once. */
  peek(text: string): Buffer | null {
    return this.cache ? this.cache.get(this.key(text)) : null;
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
