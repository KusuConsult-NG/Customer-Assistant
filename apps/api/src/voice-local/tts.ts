import * as fs from 'fs';
import * as path from 'path';
import { changeTempo, downsample24kTo8k, mulawBufferToSlin, wavToSlin8k } from './pcm';
import { TtsCache } from './tts-cache';
import type { ClipCheck, ClipVerdict } from './speech-check';

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
    // Strip XML tags and punctuation that Spitch occasionally reads aloud as
    // words ("full stop", "comma"), while preserving decimal numbers (e.g. 39.7)
    // and ? / ! intonation marks.
    const clean = text
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/:\s*$/g, '')
      .replace(/(?<!\d)\.(?=\s|$)/g, '')
      .replace(/,(?=\s|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[a-zA-Z0-9]/.test(clean)) return Buffer.alloc(0);
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
    // Strip XML tags and punctuation that Spitch occasionally reads aloud as
    // words ("full stop", "comma"), while preserving decimal numbers (e.g. 39.7)
    // and ? / ! intonation marks.
    const clean = text
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/:\s*$/g, '')
      .replace(/(?<!\d)\.(?=\s|$)/g, '')
      .replace(/,(?=\s|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[a-zA-Z0-9]/.test(clean)) return Buffer.alloc(0);
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
    // Strip XML tags and punctuation that Spitch occasionally reads aloud as
    // words ("full stop", "comma"), while preserving decimal numbers (e.g. 39.7)
    // and ? / ! intonation marks.
    const clean = text
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/:\s*$/g, '')
      .replace(/(?<!\d)\.(?=\s|$)/g, '')
      .replace(/,(?=\s|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[a-zA-Z0-9]/.test(clean)) return Buffer.alloc(0);
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

// Circuit breaker for Spitch TTS: after 3 consecutive provider failures (5xx,
// 429 exhaustion, timeouts, or network errors), fail fast for 30 s so Asterisk
// immediately routes new calls to ElevenLabs instead of hanging callers.
const SPITCH_CB_THRESHOLD = 3;
const SPITCH_CB_COOLDOWN_MS = 30_000;
let spitchConsecutiveFailures = 0;
let spitchOpenUntil = 0;

export function spitchCircuitState(now = Date.now()): { open: boolean; consecutiveFailures: number; retryAfterMs: number } {
  const retryAfterMs = Math.max(0, spitchOpenUntil - now);
  return { open: retryAfterMs > 0, consecutiveFailures: spitchConsecutiveFailures, retryAfterMs };
}

export function resetSpitchCircuit(): void {
  spitchConsecutiveFailures = 0;
  spitchOpenUntil = 0;
}

function recordSpitchSuccess(): void {
  spitchConsecutiveFailures = 0;
  spitchOpenUntil = 0;
}

function recordSpitchFailure(): void {
  spitchConsecutiveFailures++;
  if (spitchConsecutiveFailures >= SPITCH_CB_THRESHOLD) {
    spitchOpenUntil = Date.now() + SPITCH_CB_COOLDOWN_MS;
  }
}

/** A speaking-rate multiplier from the environment, 0.5–2; anything else is 1 (unchanged). */
export function speedFromEnv(name: string, fallback = 1): number {
  const v = Number(process.env[name]?.trim());
  return Number.isFinite(v) && v >= 0.5 && v <= 2 ? v : fallback;
}

/** How long one Spitch request may take: 15 s plus 100 ms a character, at most 45 s. */
export function spitchDeadlineMs(text: string): number {
  return Math.min(45_000, 15_000 + 100 * text.length);
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
    // Strip XML tags and punctuation that Spitch occasionally reads aloud as
    // words ("full stop", "comma"), while preserving decimal numbers (e.g. 39.7)
    // and ? / ! intonation marks.
    const clean = text
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/:\s*$/g, '')
      .replace(/(?<!\d)\.(?=\s|$)/g, '')
      .replace(/,(?=\s|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[a-zA-Z0-9]/.test(clean)) return Buffer.alloc(0);
    const cb = spitchCircuitState();
    if (cb.open) {
      throw new Error(`Spitch TTS circuit open (${Math.ceil(cb.retryAfterMs / 1000)}s remaining)`);
    }
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
          // Longer text takes Spitch longer: the 155-character recording notice
          // overran a flat 15 s on a real call, and the call failed over.
          signal: deadline(signal, spitchDeadlineMs(clean)),
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
    try {
      const audio = await withSpitchSlot(attempt, signal);
      recordSpitchSuccess();
      return audio;
    } catch (err) {
      if (!signal?.aborted) recordSpitchFailure();
      throw err;
    }
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
    // Strip XML tags and punctuation that Spitch occasionally reads aloud as
    // words ("full stop", "comma"), while preserving decimal numbers (e.g. 39.7)
    // and ? / ! intonation marks.
    const clean = text
      .replace(/<\/?[a-z][^>]*>/gi, ' ')
      .replace(/:\s*$/g, '')
      .replace(/(?<!\d)\.(?=\s|$)/g, '')
      .replace(/,(?=\s|$)/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[a-zA-Z0-9]/.test(clean)) return Buffer.alloc(0);
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
  /** Checks still running, so a short-lived process (the prerender, a test) can wait for them. */
  private readonly checking = new Set<Promise<void>>();

  /**
   * `check` HEARS a clip before it is stored (speech-check.ts): one that reads
   * punctuation aloud, or that could not be heard, is played to whoever asked
   * for it but never kept, so one bad render cannot be replayed on every call.
   */
  constructor(
    private readonly engine: SpeechEngine & { voice?: string; voiceId?: string; rate?: string },
    private readonly cache: TtsCache | null,
    private readonly check: ClipCheck | null = null,
    private readonly onRejected: (text: string, verdict: ClipVerdict | { error: string }) => void = () => undefined,
  ) {}

  /** Resolves when every check started so far has finished (and its clip, if clean, been handed to the cache). */
  async settle(): Promise<void> {
    while (this.checking.size) await Promise.all([...this.checking]);
  }

  /** Store a clip, once it is heard to be clean. Returns the verdict (null when there is no check). */
  private async keep(key: string, text: string, audio: Buffer): Promise<ClipVerdict | null> {
    if (!this.check) {
      this.cache!.put(key, audio);
      return null;
    }
    const verdict = await this.check(text, audio);
    if (verdict.ok) this.cache!.put(key, audio);
    else this.onRejected(text, verdict);
    return verdict;
  }

  /**
   * Synthesise `text` and store it only once it is heard clean, trying up to
   * `tries` times (the prerender: nobody is waiting, so a bad render is simply
   * made again). Throws when it cannot be heard at all.
   */
  async renderChecked(text: string, tries = 3): Promise<{ ok: boolean; attempts: number; last: ClipVerdict | null }> {
    const key = this.key(text);
    let last: ClipVerdict | null = null;
    for (let attempt = 1; attempt <= tries; attempt++) {
      const audio = await this.engine.synthesize(text);
      last = await this.keep(key, text, audio);
      if (!last || last.ok) return { ok: true, attempts: attempt, last };
    }
    return { ok: false, attempts: tries, last };
  }

  /** A new take of `text`, heard but NOT stored: for a person to listen to and choose (governor-takes.ts). */
  async take(text: string): Promise<{ audio: Buffer; verdict: ClipVerdict | null }> {
    const audio = await this.engine.synthesize(text);
    return { audio, verdict: this.check ? await this.check(text, audio) : null };
  }

  /** Store `audio` as the clip every call plays for `text`, replacing what is there. */
  install(text: string, audio: Buffer): void {
    if (!this.cache) throw new Error('no clip store to install into');
    if (!audio.length) throw new Error('empty clip');
    this.cache.put(this.key(text), audio);
  }

  /** Hear the clip already on disk for `text`. Null when there is none, or no check. */
  async recheck(text: string): Promise<ClipVerdict | null> {
    const clip = this.peek(text);
    return clip && this.check ? this.check(text, clip) : null;
  }

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
    if (cacheable) {
      // Heard in the background: the caller is not kept waiting for the check.
      const job: Promise<void> = this.keep(key, text, audio)
        .then(() => undefined)
        .catch((err: any) => this.onRejected(text, { error: String(err?.message ?? err) }))
        .finally(() => this.checking.delete(job));
      this.checking.add(job);
    }
    return { audio, cached: false };
  }
}

export type GovernorGreetingSlot = 'morning' | 'afternoon' | 'evening';

const GOVERNOR_SLOT_FILES: Record<GovernorGreetingSlot, string> = {
  morning: 'good-morning.wav',
  afternoon: 'good-afternoon.wav',
  evening: 'good-evening.wav',
};

/**
 * Serves ONLY the 3 official, studio-recorded, approved Governor greetings
 * bundled in `data/voice-assets/governor/` (`good-morning.wav`,
 * `good-afternoon.wav`, `good-evening.wav`). Never synthesises the Governor's
 * voice via AI TTS.
 */
export class StaticGovernorAudio implements SpeechEngine {
  readonly name = 'governor-approved-wav';
  readonly voice = 'approved-studio';
  private readonly pcmBySlot: Record<GovernorGreetingSlot, Buffer>;

  constructor(dir: string) {
    this.pcmBySlot = {
      morning: wavToSlin8k(fs.readFileSync(path.join(dir, GOVERNOR_SLOT_FILES.morning))),
      afternoon: wavToSlin8k(fs.readFileSync(path.join(dir, GOVERNOR_SLOT_FILES.afternoon))),
      evening: wavToSlin8k(fs.readFileSync(path.join(dir, GOVERNOR_SLOT_FILES.evening))),
    };
  }

  /** Locate `data/voice-assets/governor` across dev (`apps/api`), tests, and Docker (`/app`). */
  static resolveDir(): string | null {
    const candidates = [
      process.env.GOVERNOR_AUDIO_DIR?.trim(),
      path.resolve(process.cwd(), 'data/voice-assets/governor'),
      path.resolve(process.cwd(), '../../data/voice-assets/governor'),
      path.resolve(__dirname, '../../../../data/voice-assets/governor'),
      path.resolve(__dirname, '../../../../../data/voice-assets/governor'),
    ].filter(Boolean) as string[];
    for (const dir of candidates) {
      if (
        fs.existsSync(path.join(dir, GOVERNOR_SLOT_FILES.morning)) &&
        fs.existsSync(path.join(dir, GOVERNOR_SLOT_FILES.afternoon)) &&
        fs.existsSync(path.join(dir, GOVERNOR_SLOT_FILES.evening))
      ) {
        return dir;
      }
    }
    return null;
  }

  static fromDisk(): StaticGovernorAudio | null {
    const dir = StaticGovernorAudio.resolveDir();
    return dir ? new StaticGovernorAudio(dir) : null;
  }

  static slotForText(text: string, now = new Date()): GovernorGreetingSlot {
    const lower = text.toLowerCase();
    if (lower.includes('good morning')) return 'morning';
    if (lower.includes('good afternoon')) return 'afternoon';
    if (lower.includes('good evening')) return 'evening';
    // Fallback strictly to Africa/Lagos clock so only one of the 3 approved clips ever plays.
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hour12: false }).format(now));
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
  }

  async synthesize(text: string): Promise<Buffer> {
    return this.pcmBySlot[StaticGovernorAudio.slotForText(text)];
  }
}
