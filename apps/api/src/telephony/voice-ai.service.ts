import { Injectable } from '@nestjs/common';
import { AceLogger } from '../config/logger';
import { prisma } from '@ace/database';
import WebSocket from 'ws';

// ─── ElevenLabs model constants ──────────────────────────────────────────────
// eleven_turbo_v2   — confirmed, lowest latency (~400ms TTFB), English-optimised
// eleven_turbo_v2_5 — released late 2024; supports more languages but ~50ms slower
// eleven_multilingual_v2 — highest quality, highest latency (~700ms TTFB)
//
// We use turbo_v2 as the primary. If the org's language config requires
// multilingual support, we upgrade to turbo_v2_5 automatically.
const MODEL_TURBO_V2          = 'eleven_turbo_v2';
const MODEL_TURBO_V2_5        = 'eleven_turbo_v2_5';
const MODEL_MULTILINGUAL_V2   = 'eleven_multilingual_v2';
const ENGLISH_ONLY_MODEL      = MODEL_TURBO_V2;
const MULTILINGUAL_MODEL      = MODEL_TURBO_V2_5;

@Injectable()
export class VoiceAiService {
  private logger = new AceLogger('VoiceAiService');

  // ─── Deepgram STT ─────────────────────────────────────────────────────────

  /**
   * Create a Deepgram streaming WebSocket configured for Twilio Media Streams.
   *
   * Key decisions:
   *   encoding=mulaw, sample_rate=8000 — exactly what Twilio outputs.
   *     Deepgram accepts this natively — zero transcoding needed.
   *   vad_events=true — Deepgram fires speech_final boundaries autonomously.
   *     We use these as utterance delimiters rather than implementing our own VAD.
   *   smart_format=true — adds punctuation and capitalisation to transcripts.
   *   language — read from org settings if available, fallback to 'en'.
   *     Deepgram nova-2 supports 30+ languages with the same mulaw encoding.
   */
  async createDeepgramWsForOrg(organizationId: string): Promise<WebSocket | null> {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      this.logger.warn('DEEPGRAM_API_KEY not set — STT unavailable', {});
      return null;
    }

    let language = 'en';
    try {
      const settings = await (prisma as any).organizationSettings?.findFirst?.({
        where: { organizationId },
        select: { voiceLanguage: true },
      });
      if (settings?.voiceLanguage) language = settings.voiceLanguage;
    } catch {
      /* model may not exist in this schema version — fine, default to 'en' */
    }

    const params = new URLSearchParams({
      model:        'nova-2',
      language,
      punctuate:    'true',
      smart_format: 'true',
      vad_events:   'true',
      encoding:     'mulaw',   // ← matches Twilio's mulaw output, zero transcode
      sample_rate:  '8000',
      channels:     '1',
    });

    try {
      const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
        headers: { Authorization: `Token ${apiKey}` },
      });
      return ws;
    } catch (e) {
      this.logger.error('Error creating Deepgram WS', e as Error);
      return null;
    }
  }

  /** Synchronous fallback (used by legacy Socket.IO path, no org context). */
  createDeepgramWs(): WebSocket | null {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) return null;
    try {
      return new WebSocket(
        'wss://api.deepgram.com/v1/listen?model=nova-2&language=en&punctuate=true&smart_format=true&vad_events=true&encoding=mulaw&sample_rate=8000&channels=1',
        { headers: { Authorization: `Token ${apiKey}` } }
      );
    } catch {
      return null;
    }
  }

  // ─── ElevenLabs TTS ───────────────────────────────────────────────────────

  /**
   * Stream TTS audio in 20ms chunks directly into a Twilio Media Stream WebSocket.
   *
   * Why ulaw_8000 output format:
   *   ElevenLabs supports output_format=ulaw_8000, which produces G.711 μ-law audio
   *   at 8 kHz — the exact binary format Twilio expects in media event payloads.
   *   This eliminates all transcoding: ElevenLabs → base64 → Twilio, zero conversion.
   *
   * Why 20ms chunks:
   *   Twilio's media stream accepts chunks of any size, but jitter and gaps sound
   *   worse with large infrequent chunks. 640 bytes = 20ms of 8kHz μ-law (1 byte/sample).
   *   Sending as ElevenLabs generates them (rather than buffering the full response)
   *   cuts perceived latency by ~60%.
   *
   * Barge-in support via AbortSignal:
   *   Caller interrupting the AI passes an AbortController signal. When aborted, we
   *   cancel the ElevenLabs ReadableStream reader and return immediately. The caller
   *   can then hear the TwilioMediaStreamHandler send a 'clear' event to flush
   *   any audio still buffered in Twilio's playout queue.
   *
   * Model selection:
   *   English → eleven_turbo_v2  (lowest latency, ~380ms TTFB)
   *   Other  → eleven_turbo_v2_5 (multilingual, ~430ms TTFB)
   */
  /**
   * Streams synthesised speech into a live Twilio media stream.
   *
   * Returns whether the caller actually heard anything. This used to return void, so
   * a failure was indistinguishable from success at the call site — and the specific
   * failure that matters here (an ElevenLabs key that does not authenticate) produced
   * a call where the caller sat in complete silence with nothing to recover it.
   */
  async streamTTSToTwilio(
    text:      string,
    streamSid: string,
    twilioWs:  WebSocket,
    signal?:   AbortSignal,
    language = 'en',
  ): Promise<boolean> {
    const apiKey  = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

    if (!apiKey) {
      this.logger.error(
        'tts_unavailable',
        new Error('ELEVENLABS_API_KEY is not set — the caller will hear silence unless the call is recovered'),
      );
      return false;
    }
    if (twilioWs.readyState !== WebSocket.OPEN) return false;
    if (signal?.aborted) return false;

    const modelId = language === 'en' ? ENGLISH_ONLY_MODEL : MULTILINGUAL_MODEL;

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=ulaw_8000`,
        {
          method:  'POST',
          headers: {
            'xi-api-key':   apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id:       modelId,
            voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.05 },
          }),
          signal,  // propagates abort to the fetch itself
        }
      );

      if (!response.ok) {
        const errBody = await response.text().catch(() => response.statusText);
        this.logger.error(
          `tts_failed_http_${response.status}`,
          new Error(
            `ElevenLabs returned ${response.status}: ${errBody.slice(0, 300)}. ` +
            `The caller heard nothing — the call must be recovered rather than left silent.`
          ),
        );
        return false;
      }

      if (!response.body) {
        this.logger.error('tts_failed_no_body', new Error('ElevenLabs returned no response body'));
        return false;
      }

      const CHUNK_BYTES = 640; // 20 ms of 8 kHz μ-law (1 byte/sample × 8000 Hz × 0.02 s)
      const reader      = response.body.getReader();
      let leftover      = Buffer.alloc(0);
      let spoke         = false;

      while (true) {
        // Honour barge-in abort between every chunk
        if (signal?.aborted) {
          await reader.cancel().catch(() => {});
          return spoke;
        }

        const { done, value } = await reader.read();

        if (done) {
          // Flush any remaining bytes (final partial chunk)
          if (leftover.length > 0 && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({
              event:     'media',
              streamSid,
              media:     { payload: leftover.toString('base64') },
            }));
            spoke = true;
          }
          break;
        }

        const combined = Buffer.concat([leftover, Buffer.from(value)]);
        let offset = 0;

        while (offset + CHUNK_BYTES <= combined.length) {
          if (twilioWs.readyState !== WebSocket.OPEN || signal?.aborted) {
            await reader.cancel().catch(() => {});
            return spoke;
          }
          twilioWs.send(JSON.stringify({
            event:     'media',
            streamSid,
            media:     { payload: combined.subarray(offset, offset + CHUNK_BYTES).toString('base64') },
          }));
          spoke = true;
          offset += CHUNK_BYTES;
        }

        leftover = combined.subarray(offset);
      }

      // Tell Twilio we're done with this TTS turn (used for mark-based sync)
      if (twilioWs.readyState === WebSocket.OPEN && !signal?.aborted) {
        twilioWs.send(JSON.stringify({
          event: 'mark',
          streamSid,
          mark:  { name: `tts_done_${Date.now()}` },
        }));
      }
      return spoke;
    } catch (e: any) {
      // AbortError is expected on barge-in — the caller interrupted, which means they
      // DID hear the start of the reply.
      if (e?.name === 'AbortError') return true;
      this.logger.error('tts_stream_failed', e as Error);
      return false;
    }
  }

  /**
   * Non-streaming TTS → base64 (used by the Socket.IO agent-console path).
   * Also uses ulaw_8000 for format consistency.
   */
  async generateTTS(text: string, language = 'en'): Promise<string | null> {
    const apiKey  = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
    if (!apiKey) return null;

    const modelId = language === 'en' ? ENGLISH_ONLY_MODEL : MULTILINGUAL_MODEL;

    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=ulaw_8000`,
        {
          method:  'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            text,
            model_id:       modelId,
            voice_settings: { stability: 0.4, similarity_boost: 0.8 },
          }),
        }
      );
      if (!res.ok) {
        this.logger.error(`ElevenLabs TTS returned ${res.status}`, new Error(res.statusText));
        return null;
      }
      return Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch (e) {
      this.logger.error('Error in ElevenLabs TTS', e as Error);
      return null;
    }
  }

  // ─── Post-call summary ────────────────────────────────────────────────────

  async generateSummary(transcript: string): Promise<{ summary: string; sentiment: string }> {
    const fallback = { summary: 'Call ended.', sentiment: 'NEUTRAL' };
    if (!process.env.OPENAI_API_KEY || !transcript.trim()) return fallback;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model:           'gpt-4o-mini',
          max_tokens:      200,
          response_format: { type: 'json_object' },
          messages: [
            {
              role:    'system',
              content: 'Summarise this phone call in one concise sentence and classify overall sentiment as POSITIVE, NEGATIVE, or NEUTRAL. Return JSON only: {"summary":"...","sentiment":"..."}',
            },
            { role: 'user', content: transcript },
          ],
        }),
      });

      if (!res.ok) return fallback;
      const data    = await res.json() as any;
      const content = data.choices?.[0]?.message?.content;
      return content ? JSON.parse(content) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Rescues a live call whose AI cannot speak.
   *
   * When TTS fails there is no way to say anything down the media stream — the stream
   * carries audio, and audio is exactly what we could not produce. The only route left
   * is Twilio's REST API, which can redirect a call that is already in progress to new
   * TwiML.
   *
   * Order of preference:
   *   1. Forward to the organization's `forwardingNumber` — a human answers.
   *   2. Failing that, apologise with Twilio's own built-in voice and hang up.
   *
   * Either beats the previous behaviour, which was to leave the caller listening to
   * silence until they gave up. Note that `forwardingNumber` has been in the schema
   * and the settings UI from the start and was referenced by no code at all.
   */
  async recoverCallWithoutAI(
    callSid: string,
    creds: { accountSid?: string | null; authToken?: string | null },
    forwardingNumber?: string | null,
    callerNumber?: string
  ): Promise<'FORWARDED' | 'APOLOGISED' | 'FAILED'> {
    const accountSid = creds.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const authToken  = creds.authToken  || process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      this.logger.error(
        'call_recovery_impossible',
        new Error(`No Twilio credentials to redirect ${callSid}; the caller is left in silence.`)
      );
      return 'FAILED';
    }

    const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const twiml = forwardingNumber
      ? `<?xml version="1.0" encoding="UTF-8"?><Response>` +
        `<Say voice="Polly.Joanna">One moment please, I am connecting you to a colleague.</Say>` +
        `<Dial${callerNumber ? ` callerId="${escape(callerNumber)}"` : ''}>${escape(forwardingNumber)}</Dial>` +
        `</Response>`
      : `<?xml version="1.0" encoding="UTF-8"?><Response>` +
        `<Say voice="Polly.Joanna">I am sorry, our automated assistant is unavailable right now. ` +
        `Please try again shortly, or send us a message on WhatsApp. Goodbye.</Say>` +
        `<Hangup/></Response>`;

    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls/${encodeURIComponent(callSid)}.json`,
        {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ Twiml: twiml }).toString(),
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        this.logger.error('call_recovery_failed', new Error(`Twilio redirect returned ${res.status}: ${body.slice(0, 200)}`));
        return 'FAILED';
      }

      const outcome = forwardingNumber ? 'FORWARDED' : 'APOLOGISED';
      this.logger.warn('call_recovered_without_ai', { callSid, outcome, forwardingNumber: forwardingNumber ? 'set' : 'none' });
      return outcome;
    } catch (e: any) {
      this.logger.error('call_recovery_failed', e as Error);
      return 'FAILED';
    }
  }
}
