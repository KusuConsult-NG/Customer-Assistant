/**
 * TwilioMediaStreamHandler — Complete implementation
 *
 * Handles the RAW WebSocket connection that Twilio opens for Media Streams.
 * This file consolidates every fix applied after the initial audit:
 *
 * ── Fix 1: Correct Twilio Media Streams protocol ───────────────────────────
 *   Uses a plain `ws` WebSocket (not Socket.IO). Speaks Twilio's binary-framed
 *   JSON protocol: {event, streamSid, media:{payload}} for audio,
 *   {event:"clear"} to flush Twilio's playout buffer during barge-in.
 *
 * ── Fix 2: No audio dropped during Deepgram startup ───────────────────────
 *   Deepgram takes ~50–150 ms to open its WS. Twilio starts sending audio
 *   immediately. We buffer all frames in earlyAudioBuffer and flush them the
 *   moment Deepgram fires its 'open' event. The buffer is capped at 5 s to
 *   prevent memory growth on very slow connections.
 *
 * ── Fix 3: Correct ITU-T G.711 μ-law decode ──────────────────────────────
 *   Previous version had an incorrect algorithm. Fixed to the standard:
 *     magnitude = ((mantissa | 0x10) << (exponent + 3)) - 132
 *   Used only for RMS amplitude waveform display — not in the audio path.
 *
 * ── Fix 4: ElevenLabs welcome message (no Polly) ──────────────────────────
 *   TwiML no longer includes <Say>. The handler plays the welcome via
 *   ElevenLabs on the 'start' event so the entire call uses one consistent
 *   voice and the AI pipeline is already active when the greeting plays.
 *
 * ── Fix 5: Barge-in (interruption) detection ─────────────────────────────
 *   If the caller speaks while ElevenLabs is streaming:
 *     1. AbortController cancels the ElevenLabs fetch and reader.
 *     2. {event:"clear"} flushes Twilio's outbound audio buffer instantly.
 *     3. Caller's interruption is queued and processed normally.
 *   Result: caller feels heard immediately, no awkward wait.
 *
 * ── Fix 6: Empty organizationId fallback ─────────────────────────────────
 *   If the stream URL is missing query params (non-standard path or old URL),
 *   we look up the CallLog by callSid to recover organizationId and fromNumber
 *   before the session is created.
 *
 * ── Fix 7: Utterance queue (never drops) ─────────────────────────────────
 *   Queue processes items one-at-a-time in arrival order. If the LLM is busy,
 *   new utterances are queued rather than silently dropped.
 *
 * ── Fix 8: 20-second silence watchdog ────────────────────────────────────
 *   First expiry → AI prompts caller. Second expiry → graceful teardown.
 *   Timer resets on every speech_final event.
 *
 * ── Fix 9: Real call duration ────────────────────────────────────────────
 *   Computed as Math.floor((Date.now() - startedAt) / 1000) on teardown.
 *   Stored in callLog.durationSeconds (matching the Prisma schema field name).
 *
 * ── Fix 10: Real RMS amplitude ───────────────────────────────────────────
 *   Each inbound media frame is decoded with the corrected G.711 algorithm
 *   and the per-frame RMS is computed for the agent-console waveform display.
 *
 * ── Not fixed here: Africa's Talking / Plivo ─────────────────────────────
 *   These providers use different streaming protocols. Africa's Talking has no
 *   persistent stream at all. Plivo's AudioSocket uses linear16 PCM, not mulaw.
 *   See telephony-sdk for documentation. This handler is Twilio-only.
 */

import { Injectable } from '@nestjs/common';
import WebSocket from 'ws';
import { AceLogger, generateCorrelationId } from '../config/logger';
import { VoiceAiService } from './voice-ai.service';
import { CallBroadcastService } from './call-broadcast.service';
import { ConversationOrchestrator } from '@ace/orchestrator';
import { ChannelType, MessageSender } from '@ace/shared-types';
import { prisma, withTelephonyCredentials } from '@ace/database';

// Early-audio buffer cap: 250 frames × 20 ms = 5 seconds maximum
const MAX_EARLY_BUFFER_FRAMES = 250;

interface QueuedUtterance {
  text:        string;
  enqueuedAt:  Date;
}

interface CallSession {
  twilioWs: WebSocket;   // kept so teardown can actually hang up the call
  callSid:      string;
  streamSid:    string;
  organizationId: string;
  fromNumber:   string;
  toNumber:     string;
  welcomeMessage: string;
  language:     string;
  startedAt:    Date;

  /** Needed to redirect a live call if the AI turns out to be unable to speak. */
  carrier: { accountSid?: string | null; authToken?: string | null; forwardingNumber?: string | null };

  // Deepgram
  deepgramWs:       WebSocket | null;
  deepgramReady:    boolean;
  earlyAudioBuffer: Buffer[];   // FIX 2: buffer frames before Deepgram opens

  // STT state
  transcriptBuffer: string;

  // Utterance queue (FIX 7)
  utteranceQueue:  QueuedUtterance[];
  isProcessing:    boolean;

  // Conversation
  conversationHistory: Array<{ sender: MessageSender; content: string; timestamp: Date }>;

  // Timers (FIX 8)
  silenceTimer:  ReturnType<typeof setTimeout> | null;
  hardStopTimer: ReturnType<typeof setTimeout> | null;
  isEnded:       boolean;

  // Barge-in (FIX 5)
  isTtsSpeaking:      boolean;
  ttsAbortController: AbortController | null;
  /** Set once a handoff has been acted on, so a later utterance cannot re-trigger it. */
  handoffAttempted:   boolean;
}

@Injectable()
export class TwilioMediaStreamHandler {
  private logger       = new AceLogger('TwilioMediaStreamHandler');
  private orchestrator = new ConversationOrchestrator();
  private sessions     = new Map<string, CallSession>();

  constructor(
    private readonly voiceAiService: VoiceAiService,
    private readonly broadcast:      CallBroadcastService,
  ) {}

  // ─── Public entry point ─────────────────────────────────────────────────

  /**
   * Called from main.ts on every Twilio Media Stream WebSocket upgrade.
   * This method is async — the caller in main.ts MUST .catch() it.
   */
  async handleConnection(
    twilioWs:       WebSocket,
    callSid:        string,
    organizationId: string,
    fromNumber:     string,
    toNumber:       string,
  ): Promise<void> {
    const correlationId = generateCorrelationId();
    this.logger.info('twilio_media_stream_connected', { callSid, correlationId });

    // ── Capture the protocol stream BEFORE the first await ────────────────
    //
    // Twilio sends `connected` and then `start` immediately on connection — the
    // `start` frame carries the streamSid, and without it no audio can ever be sent
    // back, because every outbound media frame must reference it.
    //
    // The message listener used to be attached at the END of this method, after
    // organization lookups, settings lookups and the Deepgram handshake. Every frame
    // that arrived during that window was emitted to an EventEmitter with no listener
    // and silently dropped. Against a database ~1s away that is not a race that might
    // occasionally bite — the `start` frame is gone on every single call, so the
    // greeting never plays and the caller hears silence from beginning to end.
    //
    // So: attach first, queue what arrives, drain once the session exists.
    const pending: any[] = [];
    let session: CallSession | null = null;

    twilioWs.on('message', (raw: WebSocket.Data) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // Non-JSON binary control frames — safe to ignore
      }
      if (session) this.onTwilioMessage(msg, session, twilioWs);
      else pending.push(msg);
    });

    twilioWs.on('error', (err) => {
      this.logger.error('Twilio WS error', err as Error, { callSid });
      if (session) this.teardown(session, 'WEBSOCKET_ERROR');
    });
    twilioWs.on('close', () => {
      if (session) this.teardown(session, 'WEBSOCKET_CLOSED');
    });

    // ── FIX 6: Resolve organizationId from DB if missing ──────────────────
    let resolvedOrgId = organizationId;
    let resolvedFrom  = fromNumber;

    if (!resolvedOrgId) {
      try {
        const callLog = await prisma.callLog.findFirst({
          where:  { callSid },
          select: { organizationId: true, fromNumber: true, toNumber: true },
        });
        if (callLog) {
          resolvedOrgId = callLog.organizationId;
          resolvedFrom  = callLog.fromNumber || fromNumber;
          toNumber      = callLog.toNumber   || toNumber;
        }
      } catch (err) {
        this.logger.error('Failed to resolve org from callSid — call continues with empty org', err as Error, { callSid });
      }
    }

    // ── FIX 4: Fetch org welcome message and language ─────────────────────
    let welcomeMessage = 'Hello! Thank you for calling. How can I help you today?';
    let language       = 'en';
    let carrier: CallSession['carrier'] = {};

    if (resolvedOrgId) {
      try {
        const org = await (prisma as any).organization?.findUnique?.({
          where:  { id: resolvedOrgId },
          select: { welcomeMessage: true },
        });
        if (org?.welcomeMessage) welcomeMessage = org.welcomeMessage;
      } catch { /* welcomeMessage stays default */ }

      try {
        const settings = await (prisma as any).organizationSettings?.findFirst?.({
          where:  { organizationId: resolvedOrgId },
          select: { voiceLanguage: true },
        });
        if (settings?.voiceLanguage) language = settings.voiceLanguage;
      } catch { /* language stays 'en' */ }

      try {
        // Decrypted: authToken is what a mid-call transfer authenticates with,
        // and a ciphertext would fail the redirect at exactly the moment a
        // caller is asking for a person.
        const cfg = withTelephonyCredentials(
          await prisma.telephonyConfig.findFirst({
            where: { organizationId: resolvedOrgId, phoneNumber: toNumber },
            select: { accountSid: true, authToken: true, forwardingNumber: true },
          })
        );
        if (cfg) carrier = cfg;
      } catch { /* recovery falls back to the process-level Twilio credentials */ }
    }

    const built: CallSession = {
      twilioWs,
      callSid,
      streamSid:           '',
      organizationId:      resolvedOrgId,
      fromNumber:          resolvedFrom,
      toNumber,
      welcomeMessage,
      carrier,
      language,
      startedAt:           new Date(),
      deepgramWs:          null,
      deepgramReady:       false,
      earlyAudioBuffer:    [],
      transcriptBuffer:    '',
      utteranceQueue:      [],
      isProcessing:        false,
      conversationHistory: [],
      silenceTimer:        null,
      hardStopTimer:       null,
      isEnded:             false,
      isTtsSpeaking:       false,
      ttsAbortController:  null,
      handoffAttempted:    false,
    };
    this.sessions.set(callSid, built);

    // Start Deepgram — frames that arrive before it opens are buffered
    built.deepgramWs = await this.voiceAiService.createDeepgramWsForOrg(resolvedOrgId);
    this.wireDeepgramHandlers(built, twilioWs);

    // The session now exists: adopt it, then replay everything the carrier sent while
    // we were still setting up, in the order it arrived.
    session = built;
    if (pending.length) {
      this.logger.info('twilio_replaying_buffered_frames', { callSid, frames: pending.length });
      for (const msg of pending) this.onTwilioMessage(msg, built, twilioWs);
      pending.length = 0;
    }
  }

  // ─── Twilio protocol message router ─────────────────────────────────────

  private onTwilioMessage(msg: any, session: CallSession, twilioWs: WebSocket): void {
    switch (msg.event) {
      case 'connected':
        this.logger.info('twilio_stream_protocol_connected', { callSid: session.callSid });
        break;

      case 'start': {
        session.streamSid = msg.streamSid ?? '';
        this.logger.info('twilio_stream_started', {
          callSid:   session.callSid,
          streamSid: session.streamSid,
        });

        // Start silence watchdog
        this.resetSilenceWatchdog(session, twilioWs);

        // ── 2.0-Second Initial Delay before AI Agent welcomes caller ──
        setTimeout(() => {
          if (session.isEnded || twilioWs.readyState !== WebSocket.OPEN) return;

          if (session.welcomeMessage && session.streamSid) {
            const ctrl = new AbortController();
            session.ttsAbortController = ctrl;
            session.isTtsSpeaking      = true;
            this.voiceAiService
              .streamTTSToTwilio(session.welcomeMessage, session.streamSid, twilioWs, ctrl.signal, session.language)
              .then(async (spoke) => {
                // The greeting is the first thing that happens on every call, so it is
                // where a broken TTS configuration reveals itself. If the caller heard
                // nothing, do NOT leave them listening to silence for the rest of the
                // call — hand them to a human, or apologise and hang up.
                if (spoke || session.isEnded) return;
                this.logger.error(
                  'voice_ai_mute',
                  new Error('The AI produced no audio for the welcome message; recovering the call.'),
                  { callSid: session.callSid, organizationId: session.organizationId }
                );
                const outcome = await this.voiceAiService.recoverCallWithoutAI(
                  session.callSid, session.carrier, session.carrier.forwardingNumber, session.toNumber
                );
                session.isEnded = true;
                this.broadcast?.emit?.(session.callSid, 'ai_unavailable', { outcome, organizationId: session.organizationId });
              })
              .catch((err) =>
                this.logger.error('welcome_message_failed', err as Error, { callSid: session.callSid })
              )
              .finally(() => {
                session.isTtsSpeaking      = false;
                session.ttsAbortController = null;
              });
          }
        }, 2000);
        break;
      }

      case 'media': {
        const track   = msg.media?.track;
        const payload = msg.media?.payload;

        // Only process inbound audio (what the caller says)
        if (track !== 'inbound' || !payload) break;

        const audioBuffer = Buffer.from(payload, 'base64');

        // ── FIX 2: Buffer early frames while Deepgram is still connecting ──
        if (!session.deepgramReady) {
          session.earlyAudioBuffer.push(audioBuffer);
          if (session.earlyAudioBuffer.length > MAX_EARLY_BUFFER_FRAMES) {
            session.earlyAudioBuffer.shift(); // drop oldest to cap at 5 s
          }
        } else if (session.deepgramWs?.readyState === WebSocket.OPEN) {
          session.deepgramWs.send(audioBuffer);
        }

        // ── FIX 10: Real RMS amplitude for waveform display ────────────────
        const amplitude = computeRmsAmplitude(payload);
        this.broadcast.emit(session.callSid, 'audio_waveform_data', {
          callSid:   session.callSid,
          amplitude,
        });
        break;
      }

      case 'dtmf':
        if (msg.dtmf?.digit) {
          this.enqueue(session, msg.dtmf.digit, twilioWs);
        }
        break;

      case 'stop':
        this.teardown(session, 'CALLER_DISCONNECTED');
        break;

      case 'mark':
        // Twilio echoes our mark events back for sync. No action needed.
        break;
    }
  }

  // ─── Deepgram event wiring ───────────────────────────────────────────────

  private wireDeepgramHandlers(session: CallSession, twilioWs: WebSocket): void {
    const dg = session.deepgramWs;
    if (!dg) return;

    dg.on('open', () => {
      session.deepgramReady = true;
      this.logger.info('deepgram_ws_open', { callSid: session.callSid });

      // ── FIX 2: Flush buffered early frames ───────────────────────────────
      if (session.earlyAudioBuffer.length > 0) {
        this.logger.info('flushing_early_audio_buffer', {
          callSid: session.callSid,
          frames:  session.earlyAudioBuffer.length,
        });
        for (const frame of session.earlyAudioBuffer) {
          if (dg.readyState === WebSocket.OPEN) dg.send(frame);
        }
        session.earlyAudioBuffer = [];
      }
    });

    dg.on('message', (raw: WebSocket.Data) => {
      let result: any;
      try { result = JSON.parse(raw.toString()); } catch { return; }

      if (result.type !== 'Results') return;

      const transcript: string = result.channel?.alternatives?.[0]?.transcript ?? '';
      const isFinal            = result.is_final   === true;
      const speechFinal        = result.speech_final === true;

      if (!transcript) return;

      this.broadcast.emit(session.callSid, 'transcript_update', {
        callSid: session.callSid,
        text:    transcript,
        isFinal,
      });

      if (isFinal) {
        session.transcriptBuffer += transcript + ' ';

        if (speechFinal && session.transcriptBuffer.trim()) {
          const utterance = session.transcriptBuffer.trim();
          session.transcriptBuffer = '';

          // ── FIX 5: Barge-in — caller spoke while AI was speaking ─────────
          if (session.isTtsSpeaking && session.ttsAbortController) {
            this.logger.info('barge_in_detected', { callSid: session.callSid, utterance });
            session.ttsAbortController.abort();
            // Flush Twilio's outbound audio buffer immediately so the caller
            // doesn't hear the AI finish its sentence after they interrupted
            if (twilioWs.readyState === WebSocket.OPEN && session.streamSid) {
              twilioWs.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }));
            }
          }

          this.resetSilenceWatchdog(session, twilioWs);
          this.enqueue(session, utterance, twilioWs);
        }
      }
    });

    dg.on('error', (err) =>
      this.logger.error('deepgram_ws_error', err, { callSid: session.callSid })
    );

    dg.on('close', () =>
      this.logger.info('deepgram_ws_closed', { callSid: session.callSid })
    );
  }

  // ─── Utterance queue (FIX 7) ─────────────────────────────────────────────

  private enqueue(session: CallSession, text: string, twilioWs: WebSocket): void {
    session.utteranceQueue.push({ text, enqueuedAt: new Date() });
    this.drainQueue(session, twilioWs).catch((err) =>
      this.logger.error('Unexpected error in drainQueue', err as Error, { callSid: session.callSid })
    );
  }

  private async drainQueue(session: CallSession, twilioWs: WebSocket): Promise<void> {
    if (session.isProcessing) return;
    session.isProcessing = true;
    this.broadcast.emit(session.callSid, 'ai_thinking', { callSid: session.callSid });

    try {
      while (session.utteranceQueue.length > 0) {
        const item = session.utteranceQueue.shift()!;
        await this.processUtterance(session, item.text, twilioWs);
      }
    } finally {
      session.isProcessing = false;
    }
  }

  private async processUtterance(
    session:  CallSession,
    text:     string,
    twilioWs: WebSocket,
  ): Promise<void> {
    try {
      session.conversationHistory.push({
        sender:    MessageSender.CUSTOMER,
        content:   text,
        timestamp: new Date(),
      });

      const result = await this.orchestrator.processIncomingMessage(
        {
          conversationId:       session.callSid,
          organizationId:       session.organizationId,
          customerPhoneNumber:  session.fromNumber,
          channel:              ChannelType.VOICE,
          history:              session.conversationHistory,
          slots:                {},
          isHumanHandoffActive: false,
        },
        text,
      );

      // ── Human handoff on a live call ────────────────────────────────────
      //
      // The orchestrator's handoff reply says "Connecting you to a live human
      // agent right away." On chat and WhatsApp that is true: the conversation
      // is flagged and an agent takes over in the console. On a phone call
      // nothing used to happen at all — the sentence was spoken and the AI
      // carried on talking to a caller who had just asked for a person. The
      // one promise this product must never break, broken on the one channel
      // where the customer is waiting in real time.
      //
      // Act first, announce second. The transfer is attempted before anything
      // is said, and what the caller hears depends on whether it worked, so a
      // failed redirect can never leave them holding a promise.
      if (result.shouldHandoff && !session.handoffAttempted) {
        session.handoffAttempted = true;
        await this.handOffCallToHuman(session, twilioWs, text);
        return;
      }

      if (!result.replyText) return;

      session.conversationHistory.push({
        sender:    MessageSender.AI,
        content:   result.replyText,
        timestamp: new Date(),
      });

      // Create a new abort controller for this TTS turn
      const ctrl = new AbortController();
      session.ttsAbortController = ctrl;
      session.isTtsSpeaking      = true;

      try {
        await this.voiceAiService.streamTTSToTwilio(
          result.replyText,
          session.streamSid,
          twilioWs,
          ctrl.signal,
          session.language,
        );
      } finally {
        session.isTtsSpeaking      = false;
        session.ttsAbortController = null;
      }

      // Mirror text reply to agent console (browser doesn't need the audio)
      this.broadcast.emit(session.callSid, 'ai_audio_response', {
        callSid: session.callSid,
        text:    result.replyText,
      });
    } catch (err) {
      this.logger.error('Error processing utterance', err as Error, { callSid: session.callSid });
    }
  }

  // ─── Silence watchdog (FIX 8) ────────────────────────────────────────────

  /**
   * Puts a caller through to a person, or tells them honestly why it could not
   * happen. Never both, and never neither.
   *
   * Three outcomes, all of them true when spoken:
   *   TRANSFERRED — Twilio redirected the live call to the organization's
   *     forwarding number. Twilio's own TwiML speaks the "connecting you"
   *     line, so it is only ever heard after the redirect was accepted.
   *   logged     — no forwarding number, or the redirect was refused. A ticket
   *     is filed so the request reaches a human who can call back, and the
   *     caller is told that is what happened.
   *   neither    — even the ticket failed. The caller is told that too. An
   *     apology the customer can act on beats a reassurance that is false.
   */
  private async handOffCallToHuman(
    session: CallSession,
    twilioWs: WebSocket,
    lastUtterance: string
  ): Promise<void> {
    const forwardingNumber = session.carrier.forwardingNumber;

    const outcome = forwardingNumber
      ? await this.voiceAiService.transferCallToHuman(
          session.callSid,
          session.carrier,
          forwardingNumber,
          session.toNumber
        )
      : 'FAILED';

    this.broadcast.emit(session.callSid, 'human_handoff', {
      callSid: session.callSid,
      transferred: outcome === 'TRANSFERRED',
      reason: forwardingNumber ? undefined : 'no forwarding number configured',
    });

    if (outcome === 'TRANSFERRED') {
      this.logger.info('voice_handoff_transferred', { callSid: session.callSid });
      session.conversationHistory.push({
        sender: MessageSender.AI,
        content: '[Call transferred to a human agent]',
        timestamp: new Date(),
      });
      // The call now belongs to Twilio's <Dial>. Stop speaking over it and let
      // teardown record the transcript; Twilio closes the media stream itself.
      if (session.ttsAbortController) session.ttsAbortController.abort();
      return;
    }

    // Could not transfer. Leave a record a human will actually see, then say
    // precisely what did happen.
    let ticketNumber: string | null = null;
    try {
      const contact = await prisma.contact.upsert({
        where: {
          organizationId_phoneNumber: {
            organizationId: session.organizationId,
            phoneNumber: session.fromNumber,
          },
        },
        update: {},
        create: {
          organizationId: session.organizationId,
          phoneNumber: session.fromNumber,
          fullName: `Caller ${session.fromNumber.slice(-4)}`,
        },
      });

      const ticket = await prisma.ticket.create({
        data: {
          organizationId: session.organizationId,
          contactId: contact.id,
          ticketNumber: `TCK-${Date.now().toString().slice(-6)}`,
          subject: 'Caller asked to speak to a human',
          description:
            `A caller on ${session.fromNumber} asked to be put through to a person, but the call ` +
            `could not be transferred (${forwardingNumber ? 'the redirect was refused' : 'no forwarding number is configured'}). ` +
            `They were told someone would call back.\n\nWhat they said: "${lastUtterance}"`,
          status: 'OPEN',
          priority: 'HIGH',
        },
      });
      ticketNumber = ticket.ticketNumber;
    } catch (err) {
      this.logger.error('voice_handoff_ticket_failed', err as Error, { callSid: session.callSid });
    }

    const spoken = ticketNumber
      ? `I'm sorry — I can't put you through to a colleague on this call. I've logged your request as ` +
        `reference ${ticketNumber}, and someone will call you back on this number.`
      : `I'm sorry — I can't put you through to a colleague on this call, and I wasn't able to log your ` +
        `request either. Please call us back shortly and a member of the team will help you.`;

    this.logger.warn('voice_handoff_not_transferred', {
      callSid: session.callSid,
      reason: forwardingNumber ? 'twilio_redirect_failed' : 'no_forwarding_number',
      ticketNumber: ticketNumber ?? 'none',
    });

    session.conversationHistory.push({
      sender: MessageSender.AI,
      content: spoken,
      timestamp: new Date(),
    });

    const ctrl = new AbortController();
    session.ttsAbortController = ctrl;
    session.isTtsSpeaking = true;
    try {
      await this.voiceAiService.streamTTSToTwilio(
        spoken,
        session.streamSid,
        twilioWs,
        ctrl.signal,
        session.language
      );
    } finally {
      session.isTtsSpeaking = false;
      session.ttsAbortController = null;
    }

    this.broadcast.emit(session.callSid, 'ai_audio_response', {
      callSid: session.callSid,
      text: spoken,
    });
  }

  private resetSilenceWatchdog(session: CallSession, twilioWs: WebSocket): void {
    if (session.silenceTimer)  clearTimeout(session.silenceTimer);
    if (session.hardStopTimer) clearTimeout(session.hardStopTimer);

    session.silenceTimer = setTimeout(async () => {
      if (session.isEnded) return;
      this.logger.info('silence_watchdog_prompt', { callSid: session.callSid });

      const prompt = "I'm still here — are you still with me? Feel free to ask me anything.";
      const ctrl   = new AbortController();
      session.ttsAbortController = ctrl;
      session.isTtsSpeaking      = true;
      await this.voiceAiService
        .streamTTSToTwilio(prompt, session.streamSid, twilioWs, ctrl.signal, session.language)
        .catch(() => {})
        .finally(() => {
          session.isTtsSpeaking      = false;
          session.ttsAbortController = null;
        });

      // Hard-stop after a further 20 s of continued silence
      session.hardStopTimer = setTimeout(() => {
        if (!session.isEnded) {
          this.logger.info('silence_watchdog_hard_stop', { callSid: session.callSid });
          this.teardown(session, 'SILENCE_TIMEOUT');
        }
      }, 20_000);
    }, 20_000);
  }

  // ─── Call teardown ────────────────────────────────────────────────────────

  private async teardown(session: CallSession, reason: string): Promise<void> {
    if (session.isEnded) return;
    session.isEnded = true;

    const { callSid } = session;
    this.logger.info('twilio_call_teardown', { callSid, reason });

    if (session.silenceTimer)  clearTimeout(session.silenceTimer);
    if (session.hardStopTimer) clearTimeout(session.hardStopTimer);
    if (session.ttsAbortController) session.ttsAbortController.abort();

    try { session.deepgramWs?.close(); } catch {}
    // Actually hang up: without this, a silence hard-stop left the caller in
    // dead air on a still-billing call until THEY hung up.
    try {
      if (session.twilioWs.readyState === WebSocket.OPEN) session.twilioWs.close();
    } catch {}
    this.sessions.delete(callSid);

    // ── FIX 9: Real call duration ─────────────────────────────────────────
    const duration = Math.floor((Date.now() - session.startedAt.getTime()) / 1000);

    const fullTranscript = session.conversationHistory
      .map((m) => `${m.sender}: ${m.content}`)
      .join('\n');

    // Run summary generation asynchronously — don't block teardown
    this.voiceAiService.generateSummary(fullTranscript)
      .then(({ summary, sentiment }) => {
        prisma.callLog.updateMany({
          where: { callSid },
          data:  {
            status:          'COMPLETED',
            summary,
            sentiment,
            durationSeconds: duration,          // FIX 9: correct schema field name
            transcript:      fullTranscript || null,
            endedAt:         new Date(),
          },
        }).catch((err: any) =>
          this.logger.error('Failed to update CallLog on teardown', err, { callSid })
        );

        this.broadcast.emit(callSid, 'stream_ended', { callSid, duration, summary, reason });
      })
      .catch((err: any) => {
        this.logger.error('Failed to generate post-call summary', err, { callSid });
        this.broadcast.emit(callSid, 'stream_ended', { callSid, duration, summary: '', reason });
      });
  }
}

// ─── G.711 μ-law helpers ──────────────────────────────────────────────────────

/**
 * Decode a G.711 μ-law byte to a signed 16-bit PCM sample.
 *
 * FIX 3: Previous implementation used an incorrect formula.
 * This is the standard ITU-T G.711 algorithm:
 *   1. Invert all bits (Twilio sends complemented mulaw)
 *   2. Extract sign, exponent (3 bits), mantissa (4 bits)
 *   3. magnitude = ((mantissa | 0x10) << (exponent + 3)) - 132
 *
 * Used only for RMS amplitude computation (waveform display), not in the audio path.
 */
function mulawDecode(byte: number): number {
  byte = ~byte & 0xFF;
  const sign      = byte & 0x80;
  const exponent  = (byte >> 4) & 0x07;
  const mantissa  = byte & 0x0F;
  const magnitude = ((mantissa | 0x10) << (exponent + 3)) - 132;
  return sign ? -magnitude : magnitude;
}

/**
 * Compute the RMS amplitude of a base64-encoded μ-law buffer.
 * Returns a value in [0, 100] suitable for waveform visualisation.
 *
 * FIX 10: Previously returned Math.random() * 80 + 20.
 * Now computes true root-mean-square of decoded PCM samples.
 */
function computeRmsAmplitude(base64Payload: string): number {
  const bytes = Buffer.from(base64Payload, 'base64');
  if (bytes.length === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < bytes.length; i++) {
    const pcm = mulawDecode(bytes[i]);
    sumSquares += pcm * pcm;
  }
  const rms = Math.sqrt(sumSquares / bytes.length);
  // PCM16 max ≈ 32767; normalise to 0–100
  return Math.min(100, Math.round((rms / 32767) * 100));
}
