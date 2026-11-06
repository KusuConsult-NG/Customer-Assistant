/**
 * The audio half of answering a WhatsApp call.
 *
 * `WhatsAppCallAnswerService` gets as far as Meta accepting an SDP answer. From
 * that moment there is a live WebRTC session carrying Opus at 48 kHz, and
 * nothing in this platform knew what to do with it. This is that: Opus in →
 * Deepgram → the orchestrator → ElevenLabs → Opus out, which is the same chain
 * `TwilioMediaStreamHandler` runs over a far simpler transport.
 *
 * ── Why Opus is DECODED rather than passed through ──────────────────────────
 *
 * Twilio hands us mulaw/8000 and Deepgram accepts mulaw/8000, so that path
 * transcodes nothing. The equivalent shortcut here would be to forward raw
 * Opus frames to Deepgram with `encoding=opus`. Deepgram documents raw opus
 * for its Flux model, and the general encoding list includes opus, but it is
 * NOT established for the `nova-2` streaming model this platform uses — and
 * the cost of being wrong is the single worst failure on this path: a caller
 * who is never transcribed, which is indistinguishable from a caller who said
 * nothing. So the frames are decoded to linear16 and Deepgram is told exactly
 * that. It costs CPU per call and removes a guess.
 *
 * `opusscript` is the decoder, deliberately over `@discordjs/opus`: it is pure
 * JavaScript with no node-gyp step, and the build on Render has no toolchain to
 * fall back on if a prebuilt binary is missing for the runtime.
 *
 * ── What is NOT proven ──────────────────────────────────────────────────────
 *
 * No real WhatsApp call has run through this. The codec round trip, the
 * resampling, the framing and the orchestration are unit-tested against real
 * libraries, but a sandbox cannot allocate a TURN relay or place a call, so the
 * transport has never carried a packet. Treat the first real call as the test.
 */
import { Injectable } from '@nestjs/common';
import { ChannelType, MessageSender } from '@ace/shared-types';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { VoiceAiService } from '../telephony/voice-ai.service';
import { AceLogger } from '../config/logger';

const log = new AceLogger('WhatsAppCallMedia');

/** WebRTC Opus: 48 kHz, 20 ms packets. 960 samples per channel per packet. */
const CLOCK_RATE = 48000;
const FRAME_SAMPLES = 960;
/** The RTP timestamp advances by one sample per sample, i.e. by a whole frame. */
const FRAME_TICKS = FRAME_SAMPLES;
/** ElevenLabs' nearest PCM rate below 48 kHz; see `fetchTtsPcm24k`. */
const TTS_RATE = 24000;

// ── Pure signal helpers, exported so they can be asserted exactly ───────────

/**
 * Interleaved stereo PCM16 → mono PCM16, by averaging the pair.
 *
 * Meta's offer advertises `opus/48000/2`, so frames decode to two channels,
 * and Deepgram is opened with `channels=1`. Sending it interleaved stereo while
 * claiming mono would make every word arrive at double speed and half pitch —
 * transcribed as nonsense rather than failing.
 */
export function downmixToMono(stereo: Buffer): Buffer {
  const frames = Math.floor(stereo.length / 4);
  const mono = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const l = stereo.readInt16LE(i * 4);
    const r = stereo.readInt16LE(i * 4 + 2);
    // >> 1 after the sum, so the average cannot overflow the sum itself.
    mono.writeInt16LE((l + r) >> 1, i * 2);
  }
  return mono;
}

/**
 * Double the sample rate of mono PCM16 by linear interpolation.
 *
 * 24 kHz from ElevenLabs to the 48 kHz the Opus encoder is opened at. The ratio
 * is exactly two, so this needs no fractional accumulator and cannot drift:
 * every input sample yields itself plus the midpoint to its neighbour. The last
 * sample has no neighbour and repeats, which is one sample of error per buffer.
 *
 * Sample DOUBLING (repeating each value) would be simpler and audibly worse —
 * it mirrors the spectrum around 12 kHz and sounds harsh on sibilants.
 */
export function upsample2x(mono: Buffer): Buffer {
  const n = Math.floor(mono.length / 2);
  if (n === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(n * 2 * 2);
  for (let i = 0; i < n; i++) {
    const cur = mono.readInt16LE(i * 2);
    const next = i + 1 < n ? mono.readInt16LE((i + 1) * 2) : cur;
    out.writeInt16LE(cur, i * 4);
    out.writeInt16LE((cur + next) >> 1, i * 4 + 2);
  }
  return out;
}

/**
 * Split PCM16 into whole frames of `samples`, discarding any short tail.
 *
 * Opus encodes a fixed frame size; a partial frame is rejected, and padding one
 * with silence inserts a click between utterances. The tail is dropped instead
 * — at 20 ms frames that is under 20 ms of speech at the very end of a reply.
 */
export function frameMono(pcm: Buffer, samples = FRAME_SAMPLES): Buffer[] {
  const bytes = samples * 2;
  const frames: Buffer[] = [];
  for (let off = 0; off + bytes <= pcm.length; off += bytes) {
    frames.push(pcm.subarray(off, off + bytes));
  }
  return frames;
}

/** Mono PCM16 → interleaved stereo, duplicating the channel. */
export function monoToStereo(mono: Buffer): Buffer {
  const n = Math.floor(mono.length / 2);
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = mono.readInt16LE(i * 2);
    out.writeInt16LE(v, i * 4);
    out.writeInt16LE(v, i * 4 + 2);
  }
  return out;
}

/** What the caller can stop. */
export interface CallMediaSession {
  stop(): Promise<void>;
}

export interface AttachParams {
  /** The negotiated werift RTCPeerConnection. */
  pc: any;
  organizationId: string;
  callId: string;
  /** The citizen's number, for the orchestrator's context. */
  citizenNumber: string;
  correlationId: string;
}

@Injectable()
export class WhatsAppCallMediaService {
  private orchestrator = new ConversationOrchestrator();

  constructor(private readonly voiceAi: VoiceAiService) {}

  /**
   * Bridge a negotiated call's audio to the conversation engine.
   *
   * NEVER THROWS. The call is already accepted by the time this runs, so an
   * exception here would leave a connected call with no handler and no record
   * of why. Every failure is logged and the session returned still stops
   * cleanly.
   */
  async attach(params: AttachParams): Promise<CallMediaSession> {
    const { pc, organizationId, callId, citizenNumber, correlationId } = params;
    const history: Array<{ sender: MessageSender; content: string; timestamp: Date }> = [];

    let encoder: any = null;
    let decoder: any = null;
    let deepgram: any = null;
    let outboundTrack: any = null;
    let sequence = Math.floor(Math.random() * 30000);
    let timestamp = Math.floor(Math.random() * 100000);
    const ssrc = Math.floor(Math.random() * 0xffffffff);
    let payloadType = 111;
    let speaking = false;
    let stopped = false;

    const stop = async () => {
      stopped = true;
      try {
        deepgram?.close?.();
      } catch {
        /* a socket that is already gone is not a failure */
      }
      try {
        encoder?.delete?.();
        decoder?.delete?.();
      } catch {
        /* freeing a codec twice is not a failure */
      }
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const OpusScript = require('opusscript');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MediaStreamTrack, RtpPacket, RtpHeader } = require('werift');

      // Two channels, matching the `opus/48000/2` Meta advertises. A decoder
      // opened mono against a stereo stream does not error — it misreads the
      // frame, which is heard as noise rather than reported as a fault.
      decoder = new OpusScript(CLOCK_RATE, 2, OpusScript.Application.VOIP);
      encoder = new OpusScript(CLOCK_RATE, 2, OpusScript.Application.VOIP);

      const transceiver = pc.getTransceivers?.()?.find((t: any) => t.kind === 'audio');
      if (!transceiver) {
        log.error(
          'whatsapp_call_media_no_transceiver',
          new Error('The negotiated connection had no audio transceiver, so there is nothing to bridge.'),
          { correlationId, callId }
        );
        return { stop };
      }

      // The payload type Meta actually negotiated, not the 111 everyone
      // assumes. Sending on the wrong PT is discarded silently at the far end.
      const negotiated = transceiver.sender?.getParameters?.()?.codecs?.[0]?.payloadType;
      if (typeof negotiated === 'number') payloadType = negotiated;

      // ── Outbound: our voice ───────────────────────────────────────────────
      outboundTrack = new MediaStreamTrack({ kind: 'audio' });
      await transceiver.sender?.replaceTrack?.(outboundTrack);

      const sendPcm = async (mono24k: Buffer) => {
        // 24 kHz mono from TTS → 48 kHz mono → whole 20 ms frames → stereo for
        // the encoder, which was opened with two channels to match the SDP.
        const frames = frameMono(upsample2x(mono24k));
        for (const frame of frames) {
          if (stopped) return;
          const packet = encoder.encode(monoToStereo(frame), FRAME_SAMPLES);
          const rtp = new RtpPacket(
            new RtpHeader({
              version: 2,
              payloadType,
              sequenceNumber: sequence++ & 0xffff,
              timestamp: timestamp >>> 0,
              ssrc,
              marker: false,
            }),
            Buffer.from(packet)
          );
          timestamp = (timestamp + FRAME_TICKS) >>> 0;
          outboundTrack.writeRtp(rtp);
          // Paced at real time. Writing a whole reply at once would be
          // delivered as a burst and played back clipped or dropped.
          await new Promise((r) => setTimeout(r, 20));
        }
      };

      const say = async (text: string) => {
        if (!text?.trim() || stopped) return;
        const pcm = await this.voiceAi.fetchTtsPcm24k(text, 'en');
        if (!pcm) {
          // Honest, and the only thing we can do: the caller is on a live call
          // and TTS is the only voice we have.
          log.error(
            'whatsapp_call_tts_unavailable',
            new Error('TTS produced nothing, so the caller heard silence on an answered call.'),
            { correlationId, callId }
          );
          return;
        }
        history.push({ sender: MessageSender.AI, content: text, timestamp: new Date() });
        await sendPcm(pcm);
      };

      // ── Inbound: their voice ──────────────────────────────────────────────
      deepgram = await this.voiceAi.createDeepgramWsForOrg(organizationId, {
        encoding: 'linear16',
        sampleRate: CLOCK_RATE,
        channels: 1,
      });

      if (!deepgram) {
        log.error(
          'whatsapp_call_stt_unavailable',
          new Error('DEEPGRAM_API_KEY is unset, so an answered WhatsApp call can hear nothing.'),
          { correlationId, callId }
        );
      } else {
        deepgram.on('message', (raw: any) => {
          if (stopped) return;
          let parsed: any;
          try {
            parsed = JSON.parse(String(raw));
          } catch {
            return;
          }
          const alt = parsed?.channel?.alternatives?.[0];
          const text = String(alt?.transcript ?? '').trim();
          // Only finals. Acting on interim text answers half a sentence.
          if (!parsed?.is_final || !text) return;

          history.push({ sender: MessageSender.CUSTOMER, content: text, timestamp: new Date() });

          if (speaking) return;
          speaking = true;
          this.orchestrator
            .processIncomingMessage(
              {
                conversationId: callId,
                organizationId,
                customerPhoneNumber: citizenNumber,
                channel: ChannelType.VOICE,
                history: [...history],
                slots: {},
                isHumanHandoffActive: false,
              },
              text
            )
            .then((result) => say(result.replyText))
            .catch((err) =>
              log.error('whatsapp_call_orchestration_failed', err as Error, { correlationId, callId })
            )
            .finally(() => {
              speaking = false;
            });
        });
        deepgram.on('error', (err: any) =>
          log.warn('whatsapp_call_stt_error', { correlationId, callId, error: String(err?.message ?? err) })
        );
      }

      transceiver.onTrack?.subscribe?.((track: any) => {
        track.onReceiveRtp?.subscribe?.((rtp: any) => {
          if (stopped || !deepgram) return;
          try {
            const stereo = Buffer.from(decoder.decode(rtp.payload));
            const mono = downmixToMono(stereo);
            if (deepgram.readyState === 1) deepgram.send(mono);
          } catch (err: any) {
            // One bad frame is a lost 20 ms, not a lost call.
            log.debug('whatsapp_call_opus_decode_failed', {
              correlationId,
              callId,
              error: String(err?.message ?? err),
            });
          }
        });
      });

      log.info('whatsapp_call_media_attached', {
        correlationId,
        callId,
        organizationId,
        payloadType,
        stt: deepgram ? 'deepgram' : 'unavailable',
        note: 'No real call has carried audio through this path yet.',
      });

      return { stop };
    } catch (err: any) {
      log.error('whatsapp_call_media_attach_failed', err instanceof Error ? err : new Error(String(err)), {
        correlationId,
        callId,
      });
      await stop();
      return { stop };
    }
  }
}
