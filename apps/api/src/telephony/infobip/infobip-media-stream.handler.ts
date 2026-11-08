/**
 * The audio of a call Infobip carries, bridged to this platform's AI.
 *
 * Infobip opens a WebSocket to us (the dialog's `WEBSOCKET` child). Per
 * Infobip's own media-stream showcase, the first message is JSON —
 * `{callId, sampleRate, packetizationTime}` — and everything after it is raw
 * little-endian 16-bit mono PCM at that rate. Audio we send back as binary is
 * played to the caller, and `{"action":"clear"}` flushes whatever is still
 * queued (Infobip's own tutorial sends it when the AI is interrupted).
 *
 *   Infobip PCM ─▶ Deepgram (linear16 at the stream's rate, no transcoding)
 *              ─▶ orchestrator (knowledge base, intake flow, callbacks)
 *              ─▶ ElevenLabs PCM at a rate that divides the stream's evenly
 *              ─▶ framed to the stream's packetization ─▶ Infobip
 *
 * ── Three decisions worth keeping ───────────────────────────────────────────
 *
 *  1. THE CALLER CAN INTERRUPT. When Deepgram reports speech starting while
 *     the AI is talking, playback stops and Infobip's queue is flushed. The
 *     Twilio path has no barge-in at all: a citizen who starts answering
 *     before the question finishes is talked over until it does.
 *  2. UTTERANCES ARE QUEUED, NOT DROPPED. The WhatsApp call bridge ignores a
 *     final transcript that arrives while it is still replying to the last
 *     one; somebody giving their name in two breaths lost the second half.
 *     Here each is handled in order.
 *  3. A STREAM THAT CANNOT BE PLACED IS REFUSED. If its `callId` matches no
 *     call that came through the authenticated event webhook — directly or as
 *     a recorded alias — it is closed, and the log says what arrived. Running
 *     the wrong agency's AI on a citizen's call, or attaching their words to
 *     another caller's record, is worse than a dropped call.
 *
 * NO REAL CALL HAS RUN THROUGH THIS. The framing, resampling, interruption and
 * queueing are tested against a fake Infobip; the first real call is the test.
 */
import { Injectable } from '@nestjs/common';
import WebSocket from 'ws';
import { prisma } from '@ace/database';
import { ChannelType, MessageSender } from '@ace/shared-types';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { AceLogger } from '../../config/logger';
import { VoiceAiService } from '../voice-ai.service';
import { CallBroadcastService } from '../call-broadcast.service';
import { welcomeMessageFor } from '../../common/welcome-message';
import { fileHandoffTicket, handoffApology } from '../handoff-ticket';
import { upsample2x } from '../../whatsapp/whatsapp-call-media.service';
import { InfobipVoiceService, InfobipCallContext } from './infobip-voice.service';

const log = new AceLogger('InfobipMediaStream');

/** How long to wait for the metadata message before giving up on a stream. */
const METADATA_TIMEOUT_MS = 5000;
/** Frames sent ahead of real time, so a scheduling hiccup is not heard as a gap. */
const LEAD_FRAMES = 3;
/**
 * Speech onset in the first moments of the AI talking is ignored for barge-in.
 * Without it, a cough or the caller's own "mm" as the reply starts cuts every
 * sentence off at its first word.
 */
const BARGE_IN_GRACE_MS = 600;

// ── Pure helpers, exported so they can be asserted exactly ───────────────────

/**
 * Which ElevenLabs rate to ask for, and how to reach the stream's rate from it.
 *
 * Only exact integer factors. ElevenLabs offers 16000, 22050, 24000 and 44100;
 * every rate below is reached from one of those by doubling, halving or
 * nothing. A fractional resample done wrong is heard as a robotic voice and
 * reported as nothing, so an unlisted rate is refused rather than attempted.
 */
export function ttsPlanFor(
  sampleRate: number
): { ttsRate: 16000 | 24000; resample: 'none' | 'up2' | 'down2' } | null {
  switch (sampleRate) {
    case 8000:
      return { ttsRate: 16000, resample: 'down2' };
    case 16000:
      return { ttsRate: 16000, resample: 'none' };
    case 24000:
      return { ttsRate: 24000, resample: 'none' };
    case 48000:
      return { ttsRate: 24000, resample: 'up2' };
    default:
      return null;
  }
}

/**
 * Halve the sample rate of mono PCM16 by averaging each pair.
 *
 * The average is a crude low-pass, which is the point: taking every other
 * sample instead folds everything above 4 kHz back into the band a listener
 * hears, as hiss on every sibilant.
 */
export function downsample2x(mono: Buffer): Buffer {
  const pairs = Math.floor(mono.length / 4);
  const out = Buffer.alloc(pairs * 2);
  for (let i = 0; i < pairs; i++) {
    const a = mono.readInt16LE(i * 4);
    const b = mono.readInt16LE(i * 4 + 2);
    out.writeInt16LE((a + b) >> 1, i * 2);
  }
  return out;
}

/** Bytes in one packet: samples per packet × 2 bytes. */
export function frameBytesFor(sampleRate: number, packetizationMs: number): number {
  return Math.round((sampleRate * packetizationMs) / 1000) * 2;
}

/**
 * Split PCM into whole packets, padding the last with silence.
 *
 * Padded rather than dropped, unlike the Opus path: raw PCM has no frame
 * header to reject, and dropping the tail would clip the last word of every
 * sentence — the one the caller most needs to hear, the reference number.
 */
export function packetise(pcm: Buffer, frameBytes: number): Buffer[] {
  if (frameBytes <= 0) return [];
  const frames: Buffer[] = [];
  for (let off = 0; off < pcm.length; off += frameBytes) {
    const slice = pcm.subarray(off, off + frameBytes);
    frames.push(slice.length === frameBytes ? slice : Buffer.concat([slice, Buffer.alloc(frameBytes - slice.length)]));
  }
  return frames;
}

interface Session {
  ctx: InfobipCallContext;
  sampleRate: number;
  packetizationMs: number;
  frameBytes: number;
  plan: { ttsRate: 16000 | 24000; resample: 'none' | 'up2' | 'down2' };
  language: string;
  deepgram: WebSocket | null;
  history: Array<{ sender: MessageSender; content: string; timestamp: Date }>;
  /** Incremented to stop whatever is playing. */
  epoch: number;
  speakingSince: number | null;
  queue: Promise<void>;
  handoffAttempted: boolean;
  startedAt: number;
  closed: boolean;
}

@Injectable()
export class InfobipMediaStreamHandler {
  private orchestrator = new ConversationOrchestrator();

  constructor(
    private readonly voiceAi: VoiceAiService,
    private readonly infobip: InfobipVoiceService,
    private readonly broadcast: CallBroadcastService
  ) {}

  /**
   * Take a stream Infobip opened. Listeners are registered SYNCHRONOUSLY,
   * before anything is awaited — the Twilio handler learned that a message
   * arriving during an await is a message lost, and here the very first one
   * is the only thing that says which call this is.
   */
  handleConnection(ws: WebSocket): void {
    let session: Session | null = null;
    let starting = false;

    const metadataTimer = setTimeout(() => {
      if (!session) {
        log.warn('infobip_stream_no_metadata', { waitedMs: METADATA_TIMEOUT_MS });
        ws.close(1008, 'no metadata');
      }
    }, METADATA_TIMEOUT_MS);

    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) {
        if (session || starting) return; // later JSON events: nothing to do yet
        starting = true;
        clearTimeout(metadataTimer);
        this.start(ws, String(data))
          .then((s) => {
            session = s;
            if (!s) ws.close(1008, 'unknown call');
          })
          .catch((err) => {
            log.error('infobip_stream_start_failed', err instanceof Error ? err : new Error(String(err)));
            ws.close(1011, 'start failed');
          });
        return;
      }
      const s = session as Session | null;
      if (s?.deepgram && s.deepgram.readyState === WebSocket.OPEN) {
        s.deepgram.send(data as Buffer);
      }
    });

    ws.on('close', () => {
      clearTimeout(metadataTimer);
      const s = session as Session | null;
      if (s) void this.teardown(s);
    });
    ws.on('error', (err) => log.warn('infobip_stream_socket_error', { error: String(err?.message ?? err) }));
  }

  /** Parse the metadata, find the call, and bring the AI up. Null = refuse. */
  private async start(ws: WebSocket, raw: string): Promise<Session | null> {
    let meta: any;
    try {
      meta = JSON.parse(raw);
    } catch {
      log.warn('infobip_stream_bad_metadata', { sample: raw.slice(0, 120) });
      return null;
    }

    const callId = String(meta?.callId ?? '').trim();
    const sampleRate = Number(meta?.sampleRate);
    const packetizationMs = Number(meta?.packetizationTime) || 20;

    const ctx = await this.infobip.resolve(callId);
    if (!ctx) {
      // Refused, and said exactly why. This is the first thing a real call
      // will test: whether the stream names the citizen's call or the AI
      // leg's, and whether either was recorded.
      log.error('infobip_stream_unknown_call', new Error('The media stream named a call nobody recorded.'), {
        callId: callId || '(none)',
        sampleRate,
        packetizationMs,
        metadataKeys: Object.keys(meta ?? {}).join(','),
        hint:
          'No CALL_RECEIVED for this call id arrived through the event webhook, and no alias for it was ' +
          'recorded. Check the Infobip subscription delivers CALL_RECEIVED here, with Basic auth matching ' +
          'INFOBIP_WEBHOOK_USERNAME/PASSWORD.',
      });
      return null;
    }

    const plan = ttsPlanFor(sampleRate);
    if (!plan) {
      log.error(
        'infobip_stream_unsupported_rate',
        new Error(`Infobip streamed at ${sampleRate} Hz, which this bridge cannot reach exactly.`),
        { callId, hint: 'Create the media stream config with sampleRate 8000, 16000, 24000 or 48000.' }
      );
      return null;
    }

    const language = await this.languageFor(ctx.organizationId);
    const deepgram = await this.voiceAi.createDeepgramWsForOrg(ctx.organizationId, {
      encoding: 'linear16',
      sampleRate,
      channels: 1,
    });

    const session: Session = {
      ctx,
      sampleRate,
      packetizationMs,
      frameBytes: frameBytesFor(sampleRate, packetizationMs),
      plan,
      language,
      deepgram,
      history: [],
      epoch: 0,
      speakingSince: null,
      queue: Promise.resolve(),
      handoffAttempted: false,
      startedAt: Date.now(),
      closed: false,
    };

    if (!deepgram) {
      log.error(
        'infobip_stream_stt_unavailable',
        new Error('DEEPGRAM_API_KEY is unset, so the caller can be greeted but never heard.'),
        { callId: ctx.parentCallId }
      );
    } else {
      deepgram.on('message', (msg: WebSocket.RawData) => this.onDeepgram(session, ws, msg));
      deepgram.on('error', (err: any) =>
        log.warn('infobip_stream_stt_error', { callId: ctx.parentCallId, error: String(err?.message ?? err) })
      );
    }

    log.info('infobip_stream_started', {
      callId: ctx.parentCallId,
      streamCallId: callId,
      organizationId: ctx.organizationId,
      sampleRate,
      packetizationMs,
      stt: deepgram ? 'deepgram' : 'unavailable',
    });

    // Speak first. A connected call with nothing said is dead air.
    session.queue = session.queue.then(async () => {
      const greeting = await welcomeMessageFor(ctx.organizationId);
      session.history.push({ sender: MessageSender.AI, content: greeting, timestamp: new Date() });
      await this.say(session, ws, greeting);
    });
    return session;
  }

  private onDeepgram(session: Session, ws: WebSocket, raw: WebSocket.RawData): void {
    if (session.closed) return;
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // ── Barge-in ─────────────────────────────────────────────────────────
    if (msg?.type === 'SpeechStarted') {
      const since = session.speakingSince;
      if (since !== null && Date.now() - since > BARGE_IN_GRACE_MS) {
        session.epoch += 1; // stops the playback loop at its next frame
        session.speakingSince = null;
        try {
          ws.send(JSON.stringify({ action: 'clear' }));
        } catch {
          /* the socket is going away; the playback loop will notice */
        }
        log.debug('infobip_stream_barge_in', { callId: session.ctx.parentCallId });
      }
      return;
    }

    const text = String(msg?.channel?.alternatives?.[0]?.transcript ?? '').trim();
    if (!text) return;
    this.broadcast.emit(session.ctx.parentCallId, 'transcript_update', {
      callSid: session.ctx.parentCallId,
      text,
      isFinal: msg?.is_final === true,
    });
    // Only finals. Acting on interim text answers half a sentence.
    if (msg?.is_final !== true) return;

    // Queued, never dropped — see decision 2 above.
    session.queue = session.queue.then(() => this.answer(session, ws, text)).catch((err) =>
      log.error('infobip_stream_answer_failed', err instanceof Error ? err : new Error(String(err)), {
        callId: session.ctx.parentCallId,
      })
    );
  }

  private async answer(session: Session, ws: WebSocket, text: string): Promise<void> {
    if (session.closed) return;
    session.history.push({ sender: MessageSender.CUSTOMER, content: text, timestamp: new Date() });
    this.broadcast.emit(session.ctx.parentCallId, 'ai_thinking', { callSid: session.ctx.parentCallId });

    const result = await this.orchestrator.processIncomingMessage(
      {
        // The carrier's call id, as the Twilio path passes its callSid: VOICE
        // has no Conversation row until a flow needs one, and the
        // orchestrator creates that itself.
        conversationId: session.ctx.parentCallId,
        organizationId: session.ctx.organizationId,
        customerPhoneNumber: session.ctx.fromNumber,
        channel: ChannelType.VOICE,
        history: [...session.history],
        slots: {},
        isHumanHandoffActive: false,
      },
      text
    );

    // ACT, THEN ANNOUNCE. A live transfer to an officer is not built for this
    // carrier yet, so a request for a person is never answered with
    // "connecting you" — the orchestrator's own reply might say that, so it
    // is not spoken. A HIGH-priority ticket is filed and its reference read
    // back, exactly as the Twilio path does when it cannot transfer.
    if (result.shouldHandoff && !session.handoffAttempted) {
      session.handoffAttempted = true;
      const ticket = await fileHandoffTicket({
        organizationId: session.ctx.organizationId,
        fromNumber: session.ctx.fromNumber,
        whyNotTransferred: 'live transfer to an officer is not yet available on the Infobip line',
        lastUtterance: text,
        onError: (err) =>
          log.error('infobip_handoff_ticket_failed', err as Error, { callId: session.ctx.parentCallId }),
      });
      this.broadcast.emit(session.ctx.parentCallId, 'human_handoff', {
        callSid: session.ctx.parentCallId,
        transferred: false,
        reason: 'live transfer is not available on the Infobip line',
      });
      const spoken = handoffApology(ticket);
      session.history.push({ sender: MessageSender.AI, content: spoken, timestamp: new Date() });
      await this.say(session, ws, spoken);
      return;
    }

    if (!result.replyText) return;
    session.history.push({ sender: MessageSender.AI, content: result.replyText, timestamp: new Date() });
    this.broadcast.emit(session.ctx.parentCallId, 'ai_audio_response', {
      callSid: session.ctx.parentCallId,
      text: result.replyText,
    });
    await this.say(session, ws, result.replyText);
  }

  /**
   * Speak `text`, paced to the stream's packetization, until it finishes or is
   * superseded. Never throws.
   */
  async say(session: Session, ws: WebSocket, text: string): Promise<void> {
    if (!text?.trim() || session.closed) return;
    const myEpoch = ++session.epoch;

    const pcm = await this.voiceAi.fetchTtsPcm(text, session.language, session.plan.ttsRate);
    if (!pcm) {
      log.error('infobip_stream_tts_unavailable', new Error('TTS produced nothing; the caller heard silence.'), {
        callId: session.ctx.parentCallId,
      });
      return;
    }
    if (myEpoch !== session.epoch || session.closed) return;

    const atRate =
      session.plan.resample === 'up2' ? upsample2x(pcm) : session.plan.resample === 'down2' ? downsample2x(pcm) : pcm;
    const frames = packetise(atRate, session.frameBytes);

    session.speakingSince = Date.now();
    const start = Date.now();
    for (let i = 0; i < frames.length; i++) {
      if (myEpoch !== session.epoch || session.closed || ws.readyState !== WebSocket.OPEN) break;
      ws.send(frames[i], { binary: true });
      // Deadline-based, not a fixed sleep per frame: a fixed sleep adds the
      // send time to every packet, so a long reply drifts behind real time
      // and the caller hears it slow down.
      const due = start + (i + 1 - LEAD_FRAMES) * session.packetizationMs;
      const wait = due - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    if (myEpoch === session.epoch) session.speakingSince = null;
  }

  private async languageFor(organizationId: string): Promise<string> {
    try {
      const settings = await (prisma as any).organizationSettings?.findFirst?.({
        where: { organizationId },
        select: { voiceLanguage: true },
      });
      return settings?.voiceLanguage || 'en';
    } catch {
      return 'en';
    }
  }

  private async teardown(session: Session): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    session.epoch += 1;
    try {
      session.deepgram?.close();
    } catch {
      /* already gone */
    }

    const transcript = session.history
      .map((h) => `${h.sender === MessageSender.AI ? 'AI' : 'Caller'}: ${h.content}`)
      .join('\n');
    const duration = Math.round((Date.now() - session.startedAt) / 1000);

    await prisma.callLog
      .update({
        where: { callSid: session.ctx.parentCallId },
        data: { transcript: transcript || null },
      })
      .catch((err) =>
        log.warn('infobip_stream_transcript_save_failed', {
          callId: session.ctx.parentCallId,
          error: String((err as any)?.message ?? err),
        })
      );

    this.broadcast.emit(session.ctx.parentCallId, 'stream_ended', {
      callSid: session.ctx.parentCallId,
      duration,
      summary: '',
      reason: 'stream closed',
    });
    log.info('infobip_stream_ended', { callId: session.ctx.parentCallId, durationSeconds: duration });
  }
}
