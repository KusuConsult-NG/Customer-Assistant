import { Injectable } from '@nestjs/common';
import { ttsModelFor } from './tts-models';
import { AceLogger } from '../config/logger';
import { prisma } from '@ace/database';
import { chatCompletionsUrl, llmConfig } from '@ace/orchestrator';
import WebSocket from 'ws';

// ─── ElevenLabs model selection ──────────────────────────────────────────────
//
// The ids used to live here as `eleven_turbo_v2` / `eleven_turbo_v2_5`, with a
// comment calling the first "confirmed". Both are now DEPRECATED, and
// ElevenLabs has already REMOVED other models (Multilingual v1, Scribe v1, in
// July 2026). On a removal every call on both channels goes silent at once,
// because a rejected TTS request produces no audio for a caller who is already
// connected.
//
// So they come from `tts-models.ts`: supported Flash models by default (also
// lower latency), overridable by env, and verified against ElevenLabs'
// `/v1/models` by the provider health check.

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
  /**
   * @param audio The wire format being fed in. Defaults to Twilio's mulaw/8000
   *   so every existing caller is unchanged — WhatsApp calls pass
   *   linear16/48000 instead, because Opus is decoded to PCM before it gets
   *   here rather than passed through. Deepgram's `encoding` parameter is for
   *   RAW headerless audio, which is what both of those are.
   */
  async createDeepgramWsForOrg(
    organizationId: string,
    audio: { encoding: string; sampleRate: number; channels?: number } = {
      encoding: 'mulaw',
      sampleRate: 8000,
    }
  ): Promise<WebSocket | null> {
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
      encoding:     audio.encoding,
      sample_rate:  String(audio.sampleRate),
      channels:     String(audio.channels ?? 1),
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
  /**
   * TTS as raw PCM, for a channel that is not Twilio.
   *
   * `streamTTSToTwilio` asks ElevenLabs for `ulaw_8000` and writes it straight
   * onto a Twilio socket — correct there, useless for WhatsApp, whose media is
   * Opus at 48 kHz. This asks for `pcm_24000` instead and hands back the bytes,
   * leaving the caller to resample and encode.
   *
   * 24 kHz and not something closer to 48: ElevenLabs offers pcm_16000,
   * pcm_22050, pcm_24000 and pcm_44100 and NOT pcm_48000, so a resample is
   * unavoidable. 24 → 48 is an exact factor of two, which is a sample-doubling
   * loop with no filter design, no fractional accumulator and no drift. 44.1 →
   * 48 is 160/147, which needs a real resampler to avoid artefacts, and a
   * wrong one is heard as a robotic voice rather than as an error.
   *
   * Returns null rather than throwing, and says in the log that the caller
   * heard nothing — the same contract `streamTTSToTwilio` keeps, because a
   * silent caller must never read as success.
   */
  async fetchTtsPcm24k(text: string, language = 'en', signal?: AbortSignal): Promise<Buffer | null> {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

    if (!apiKey) {
      this.logger.error(
        'tts_unavailable',
        new Error('ELEVENLABS_API_KEY is not set — the caller will hear silence.')
      );
      return null;
    }
    if (signal?.aborted) return null;

    const modelId = ttsModelFor(language);

    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`,
        {
          method: 'POST',
          headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text,
            model_id: modelId,
            voice_settings: { stability: 0.4, similarity_boost: 0.8, speed: 1.05 },
          }),
          signal,
        }
      );

      if (!response.ok) {
        const errBody = await response.text().catch(() => response.statusText);
        this.logger.error(
          `tts_pcm_failed_http_${response.status}`,
          new Error(
            `ElevenLabs returned ${response.status}: ${errBody.slice(0, 300)}. The caller heard nothing.`
          )
        );
        return null;
      }

      const audio = Buffer.from(await response.arrayBuffer());
      if (audio.length === 0) {
        this.logger.error('tts_pcm_empty', new Error('ElevenLabs returned no audio; the caller heard nothing.'));
        return null;
      }
      return audio;
    } catch (err: any) {
      if (signal?.aborted) return null;
      this.logger.error('tts_pcm_unreachable', err instanceof Error ? err : new Error(String(err)));
      return null;
    }
  }

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

    const modelId = ttsModelFor(language);

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

    const modelId = ttsModelFor(language);

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
      const res = await fetch(chatCompletionsUrl(), {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model:           llmConfig().chatModel,
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
  /**
   * Hands a live call to a human, because the caller asked for one.
   *
   * Deliberately separate from recoverCallWithoutAI below. That one rescues a
   * call whose AI is broken and, with no forwarding number, apologises that
   * "our automated assistant is unavailable" — the wrong thing to tell someone
   * who simply asked for a person, and it would be spoken at the one moment
   * they are least willing to hear it.
   *
   * This method requires a forwarding number: without somewhere to send the
   * call there is no transfer to perform, and the caller must be told the
   * truth rather than left listening to a promise. The caller ID is the
   * business's own number so the colleague sees who is calling.
   */
  async transferCallToHuman(
    callSid: string,
    creds: { accountSid?: string | null; authToken?: string | null },
    forwardingNumber: string,
    businessNumber?: string
  ): Promise<'TRANSFERRED' | 'FAILED'> {
    const accountSid = creds.accountSid || process.env.TWILIO_ACCOUNT_SID;
    const authToken = creds.authToken || process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken || !forwardingNumber) {
      this.logger.warn('voice_handoff_impossible', {
        callSid,
        reason: !forwardingNumber ? 'no forwarding number configured' : 'no Twilio credentials',
      });
      return 'FAILED';
    }

    const escape = (t: string) =>
      t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // The <Say> bridges the seconds of silence while Twilio dials out, and it
    // is spoken only once the redirect has been accepted — so the caller never
    // hears "connecting you" for a connection that did not happen.
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?><Response>` +
      `<Say voice="Polly.Joanna">Connecting you to a member of our team now. One moment please.</Say>` +
      `<Dial${businessNumber ? ` callerId="${escape(businessNumber)}"` : ''}>${escape(forwardingNumber)}</Dial>` +
      `</Response>`;

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
        this.logger.error(
          'voice_handoff_failed',
          new Error(`Twilio redirect returned ${res.status}: ${body.slice(0, 200)}`)
        );
        return 'FAILED';
      }

      this.logger.warn('voice_handoff_transferred', { callSid, forwardingNumber: 'set' });
      return 'TRANSFERRED';
    } catch (e: any) {
      this.logger.error('voice_handoff_failed', e as Error);
      return 'FAILED';
    }
  }

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
