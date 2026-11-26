import { FRAME_BYTES, FRAME_MS } from './audiosocket';
import { CallRecorder, forPlayback, rms, silence, toFrames } from './pcm';
import { SentenceSplitter, type ChatMessage, type LlmEvent, type ToolCall } from './llm';
import type { CachedSpeech } from './tts';
import type { SttFactory, SttStream } from './stt';
import type { OpenAiTool } from './voice-tools';

/**
 * One phone call answered by the server's own voice pipeline:
 *
 *   caller audio (AudioSocket) → Deepgram → the model, with the SAME prompt
 *   and tools as the ElevenLabs agent → Azure en-NG speech → caller
 *
 * The session owns timing — when the caller has finished, when to talk, when
 * to stop talking because the caller started — and nothing else. Who the
 * caller is, what the script says and every write to a record belong to the
 * same services the ElevenLabs agent calls, injected here.
 *
 * ── Failure means FALLBACK, never silence ──────────────────────────────────
 * Any provider failing (recognition, speech, the model) ends this session with
 * outcome `fallback`. The dialplan asks for the outcome when the AudioSocket
 * leg ends and sends the call on to the ElevenLabs agent, which looks the
 * caller up again from their number. A restarted conversation is worse than an
 * unbroken one and far better than dead air.
 */

export type Outcome = 'completed' | 'fallback' | 'caller_hung_up';

export interface TranscriptTurn {
  role: 'user' | 'agent';
  message: string;
  atSecs: number;
  toolCalls?: Array<{ name: string; arguments: string }>;
}

export interface SessionDeps {
  /** Writes one 20 ms slin frame to the caller. */
  sendAudio(frame: Buffer): void;
  /** Ends the AudioSocket leg (the dialplan then reads the outcome). */
  close(): void;
  stt: SttFactory;
  assistantVoice: CachedSpeech;
  /** The Governor's voice for `<governor>` in the opening; null speaks it in the assistant's voice. */
  governorVoice: CachedSpeech | null;
  llm(messages: ChatMessage[], tools: OpenAiTool[], signal: AbortSignal): AsyncIterable<LlmEvent>;
  tools: OpenAiTool[];
  /** Optional: prime the model provider's prompt cache while the opening plays. */
  warm?(messages: ChatMessage[], tools: OpenAiTool[]): Promise<void>;
  runTool(name: string, args: Record<string, any>): Promise<unknown>;
  log(event: string, detail?: Record<string, unknown>): void;
  now?: () => number;
}

export interface SessionSetup {
  systemPrompt: string;
  /** The opening as stored, with `<governor>` and `<break>` markup intact. */
  opening: string;
  /** Words that identify this caller (their name): never written to the speech cache. */
  personal: string[];
}

/** Long enough for a caller to think; the prompt asks twice before end_call. */
export const SILENCE_NUDGE_MS = 12_000;
/** Matches the ElevenLabs agent's own ceiling (elevenlabs-contracts.ts). */
export const SILENCE_HANGUP_MS = 180_000;
/** A tool slower than this gets a spoken "one moment" so the line is not dead. */
const TOOL_FILLER_MS = 1_200;
/**
 * No reply audio this long after the caller finished: say a short
 * acknowledgement that is already on disk. Spitch takes 2-6 s per new
 * sentence on the live line, and silence that long reads as a dropped call.
 */
export const ACK_AFTER_MS = 900;
// Two words at least: Spitch rendered a bare "Okay." as 0.09 s (jude) and
// 0.43 s (the Governor's voice) of audio in which Deepgram heard nothing.
export const ACKS = ['Alright, one moment.', 'Okay, let me check.'];
export const HOLDING_LINE = 'One moment, please.';
/** After the caller carries on speaking: how long to wait for the rest of their words before answering what was said. */
export const CONTINUATION_WAIT_MS = 2_500;
const MAX_TOOL_ROUNDS = 6;
/** Caller audio louder than this, with words recognised, while we talk = barge-in. */
const BARGE_IN_RMS = 900;

export class VoiceSession {
  readonly transcript: TranscriptTurn[] = [];
  readonly recorder = new CallRecorder();
  outcome: Outcome | null = null;
  failure: string | null = null;
  readonly startedAt: number;

  private readonly now: () => number;
  private messages: ChatMessage[] = [];
  private stt: SttStream | null = null;
  private playQueue: Buffer[] = [];
  private playedFrames = 0;
  private pump: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private heard: string[] = [];
  private turnAbort: AbortController | null = null;
  private responding = false;
  private pendingTurn = false;
  private queuedUser: string[] = [];
  private lastCallerSpeech: number;
  private lastActivity: number;
  private nudges = 0;
  private hangupRequested = false;
  private recentLevel = 0;
  private callerIndex = -1;
  private speechChain: Promise<void> = Promise.resolve();
  private spokenThisTurn = '';
  private turnStartedAt = 0;
  private turnFirstText = 0;
  private turnFirstAudio = 0;
  private ackTimer: NodeJS.Timeout | null = null;
  private ackIndex = 0;
  /** Where the caller's words for the turn being answered sit (message and transcript), or -1 for a silence check. */
  private turnUserMessage = -1;
  private turnUserTranscript = -1;
  /** The caller carried on speaking before the reply was heard: the next words join the same turn. */
  private continuing = false;
  private continuationTimer: NodeJS.Timeout | null = null;
  /** The opening is still being queued, and whether the caller has cut it short. */
  private openingActive = false;
  private openingCut = false;
  private openingSpoken: string[] = [];
  private finishing: Promise<void> | null = null;
  private resolveDone!: () => void;
  readonly done = new Promise<void>((r) => (this.resolveDone = r));

  constructor(
    private readonly deps: SessionDeps,
    private readonly setup: SessionSetup,
  ) {
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.lastCallerSpeech = this.startedAt;
    this.lastActivity = this.startedAt;
  }

  private secs(): number {
    return Math.round((this.now() - this.startedAt) / 100) / 10;
  }

  private clockIndex(): number {
    return Math.floor((this.now() - this.startedAt) / FRAME_MS);
  }

  /** Connect recognition, speak the opening. Resolves once the call is live. */
  async start(): Promise<void> {
    this.messages = [{ role: 'system', content: this.setup.systemPrompt }];
    try {
      this.stt = await this.deps.stt({
        onInterim: (text) => this.onInterim(text),
        onFinal: (text, end) => this.onFinal(text, end),
        onUtteranceEnd: () => this.commitTurn(),
        onError: (err) => this.fail(`speech recognition: ${err.message}`),
      });
    } catch (err: any) {
      return this.fail(`speech recognition: ${err?.message ?? err}`);
    }
    this.startPump();
    void this.deps.warm?.(this.messages, this.deps.tools).catch(() => undefined);
    this.watchdog = setInterval(() => this.checkSilence(), 1_000);
    this.watchdog.unref?.();

    // The opening goes into the history BEFORE it is spoken. A caller who
    // answers while it plays has their words placed after it; recorded after
    // the opening finished, it sat after their question and the reply to it,
    // and the model read the conversation out of order.
    this.messages.push({ role: 'assistant', content: plain(this.setup.opening) });
    this.transcript.push({ role: 'agent', message: plain(this.setup.opening), atSecs: 0 });
    let spoken: string;
    try {
      spoken = await this.speakOpening(this.setup.opening);
    } catch (err: any) {
      return this.fail(`opening: ${err?.message ?? err}`);
    }
    void spoken;
    // The acknowledgements and holding line are only useful if they are
    // instant, so they are put on disk now (once per voice, ever) and only
    // ever PLAYED from disk.
    for (const t of [...ACKS, HOLDING_LINE]) {
      if (!this.deps.assistantVoice.peek(t)) void this.deps.assistantVoice.speak(t, { alwaysCache: true }).catch(() => undefined);
    }
  }

  /** Still answering, or still playing: the conversation check waits for this before the next caller line. */
  get busy(): boolean {
    return this.responding || this.pendingTurn || this.continuing || this.playQueue.length > 0;
  }

  /** One AudioSocket audio frame from the caller. */
  onCallerAudio(frame: Buffer): void {
    if (this.outcome) return;
    this.callerIndex = Math.max(this.callerIndex + 1, this.clockIndex());
    this.recorder.add('caller', this.callerIndex, frame);
    this.recentLevel = this.recentLevel * 0.7 + rms(frame) * 0.3;
    this.stt?.send(frame);
  }

  /** Asterisk said the caller hung up, or the socket closed. */
  callerHungUp(): void {
    if (!this.outcome) void this.finish('caller_hung_up');
  }

  // ── Listening ─────────────────────────────────────────────────────────────

  private onInterim(text: string): void {
    this.lastCallerSpeech = this.now();
    this.lastActivity = this.now();
    // The caller carries on after a pause, before any of the reply has been
    // heard: they had not finished ("I'm calling you from … Rantya"). The
    // reply to the first half is dropped and the whole answer is taken as one
    // turn. Answered in halves, the first half got the question asked again,
    // and the second ("Okay, go ahead") was taken as a yes to it.
    if (this.responding && !this.turnFirstAudio && this.turnUserMessage >= 0 && !this.hangupRequested && !this.continuing) {
      this.continuing = true;
      this.abortReplyQuietly();
      this.deps.log('voice_local_continuation');
      // Recognition may yet finalise nothing (a cough heard as a word): the
      // turn is then answered as it stood, rather than left in silence.
      if (this.continuationTimer) clearTimeout(this.continuationTimer);
      this.continuationTimer = setTimeout(() => {
        this.continuationTimer = null;
        if (!this.continuing || this.outcome) return;
        this.continuing = false;
        if (!this.responding) {
          this.beginTurnClock();
          void this.respond();
        }
      }, CONTINUATION_WAIT_MS);
      this.continuationTimer.unref?.();
      return;
    }
    // Barge-in: the caller is talking over us. Words recognised AND real
    // level, so a cough or a generator does not cut the assistant off.
    if ((this.playQueue.length > 0 || this.responding || this.openingActive) && text.split(/\s+/).length >= 2 && this.recentLevel > BARGE_IN_RMS) {
      this.interrupt();
    }
  }

  private onFinal(text: string, endOfTurn: boolean): void {
    if (text) {
      this.heard.push(text);
      this.lastCallerSpeech = this.now();
      this.lastActivity = this.now();
    }
    if (endOfTurn) this.commitTurn();
  }

  private commitTurn(): void {
    const said = this.heard.join(' ').trim();
    if (!said || this.outcome) return;
    this.heard = [];
    this.nudges = 0;
    if (this.continuing && this.turnUserMessage >= 0) {
      // The rest of the answer whose first half was already committed.
      this.continuing = false;
      if (this.continuationTimer) clearTimeout(this.continuationTimer);
      const m = this.messages[this.turnUserMessage] as { role: 'user'; content: string };
      m.content = `${m.content} ${said}`;
      if (this.turnUserTranscript >= 0) this.transcript[this.turnUserTranscript].message += ` ${said}`;
      if (this.responding) {
        // The dropped reply is still unwinding; it answers the whole turn when it has.
        this.pendingTurn = true;
        this.abortReplyQuietly();
        return;
      }
      this.beginTurnClock();
      void this.respond();
      return;
    }
    this.transcript.push({ role: 'user', message: said, atSecs: this.secs() });
    if (this.responding) {
      // They spoke while we were still answering. Their words go into the
      // history AFTER whatever we had already said, once the interrupted turn
      // has recorded it — pushed now, they would land before it, and the model
      // would read its own cut-off sentence as the latest thing in the call.
      this.queuedUser.push(said);
      this.interrupt();
      this.pendingTurn = true;
      return;
    }
    this.messages.push({ role: 'user', content: said });
    this.turnUserMessage = this.messages.length - 1;
    this.turnUserTranscript = this.transcript.length - 1;
    this.beginTurnClock();
    void this.respond();
  }

  /** The opening was cut short: the history and the record say what was actually played, and that it stopped. */
  private recordOpeningCut(): void {
    const spoken = this.openingSpoken.join(' ');
    this.messages[1] = { role: 'assistant', content: spoken ? `${spoken} …` : '(The caller spoke before the opening could be played.)' };
    if (this.transcript[0]) this.transcript[0].message = spoken ? `${spoken} …` : '';
  }

  /** Drop the reply being prepared, without treating it as the caller talking over it. */
  private abortReplyQuietly(): void {
    this.playQueue = [];
    this.turnAbort?.abort();
    this.speechChain = Promise.resolve();
  }

  /** The caller has finished: time the reply, and acknowledge if it is slow. */
  private beginTurnClock(): void {
    this.turnStartedAt = this.now();
    this.turnFirstText = 0;
    this.turnFirstAudio = 0;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.turnFirstAudio || this.outcome || this.playQueue.length) return;
      const text = ACKS[this.ackIndex++ % ACKS.length];
      const clip = this.deps.assistantVoice.peek(text);
      if (!clip) return;
      this.enqueue(forPlayback(clip));
      this.deps.log('voice_local_ack', { text, ms: this.now() - this.turnStartedAt });
    }, ACK_AFTER_MS);
    this.ackTimer.unref?.();
  }

  private interrupt(): void {
    this.playQueue = [];
    this.turnAbort?.abort();
    this.speechChain = Promise.resolve();
    // Talking over the opening stops it: clearing what was queued is not
    // enough, because the rest of it was still being queued behind.
    if (this.openingActive && !this.openingCut) {
      this.openingCut = true;
      // Corrected NOW, not when the opening's queueing unwinds: the reply to
      // the caller is requested at once and must see what they actually heard.
      this.recordOpeningCut();
    }
    this.deps.log('voice_local_barge_in');
  }

  private checkSilence(): void {
    if (this.outcome) return;
    const quietFor = this.now() - this.lastCallerSpeech;
    if (quietFor >= SILENCE_HANGUP_MS) {
      void this.finish('completed');
      return;
    }
    if (this.responding || this.playQueue.length || this.heard.length) return;
    if (this.hangupRequested) return;
    if (this.now() - this.lastActivity >= SILENCE_NUDGE_MS && this.nudges < 3) {
      this.nudges++;
      this.lastActivity = this.now();
      // Told as a note, not as words the caller said, so the model asks
      // whether they are still there (twice) and then says goodbye.
      this.messages.push({
        role: 'user',
        content: `[No reply from the caller for ${Math.round(SILENCE_NUDGE_MS / 1000)} seconds (check ${this.nudges}). They have not spoken.]`,
      });
      this.turnUserMessage = -1; // a note, not the caller's words: nothing to join a continuation to
      this.turnUserTranscript = -1;
      void this.respond();
    }
  }

  // ── Answering ─────────────────────────────────────────────────────────────

  private async respond(): Promise<void> {
    if (this.outcome) return;
    this.responding = true;
    const abort = new AbortController();
    this.turnAbort = abort;
    // Whether a write tool has succeeded in this reply: the only thing that
    // makes "I've updated your details" true. Claims made before it are held.
    let wrote = false;
    let corrected = false;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS && !abort.signal.aborted; round++) {
        const splitter = new SentenceSplitter({ firstAtComma: !this.turnFirstAudio });
        let text = '';
        let calls: ToolCall[] = [];
        const held: string[] = [];
        const spokenParts: string[] = [];
        const emit = (sentence: string) => {
          if (!wrote && isSaveClaim(sentence)) held.push(sentence);
          else {
            spokenParts.push(sentence);
            this.say(sentence, abort.signal);
          }
        };
        this.spokenThisTurn = '';
        for await (const ev of this.deps.llm(this.messages, this.deps.tools, abort.signal)) {
          if (abort.signal.aborted) break;
          if (ev.type === 'text') {
            if (!this.turnFirstText && this.turnStartedAt) this.turnFirstText = this.now();
            text += ev.delta;
            for (const s of splitter.push(ev.delta)) emit(s);
          } else {
            calls = ev.calls;
          }
        }
        const rest = splitter.flush();
        if (rest && !abort.signal.aborted) emit(rest);

        if (abort.signal.aborted) {
          // Keep what was actually said — for the model, so it knows where it
          // was cut off, and for the call record, which otherwise lost it.
          if (this.spokenThisTurn) {
            this.messages.push({ role: 'assistant', content: `${this.spokenThisTurn} …` });
            this.transcript.push({ role: 'agent', message: `${this.spokenThisTurn} …`, atSecs: this.secs() });
          }
          return;
        }
        // The history and the record hold what the caller was actually told:
        // a held claim is not in either unless it is spoken below.
        const told = () => [...spokenParts].join(' ').trim();
        this.messages.push({ role: 'assistant', content: told() || null, ...(calls.length ? { tool_calls: calls } : {}) });
        const record = this.transcript.length;
        if (told() || calls.length) {
          this.transcript.push({
            role: 'agent',
            message: told(),
            atSecs: this.secs(),
            ...(calls.length ? { toolCalls: calls.map((c) => ({ name: c.function.name, arguments: c.function.arguments })) } : {}),
          });
        }

        if (calls.length) {
          if (await this.runTools(calls, abort.signal)) wrote = true;
        }
        if (held.length) {
          if (wrote && !abort.signal.aborted) {
            // Now true: say it, after the write that makes it so.
            for (const h of held) {
              spokenParts.push(h);
              this.say(h, abort.signal);
            }
            const lastAssistant = [...this.messages].reverse().find((m) => m.role === 'assistant') as { content: string | null } | undefined;
            if (lastAssistant) lastAssistant.content = told();
            if (this.transcript[record]) this.transcript[record].message = told();
          } else {
            this.deps.log('voice_local_unbacked_claim', { held: held.join(' ').slice(0, 300) });
            if (!corrected && !calls.length && !abort.signal.aborted) {
              // Once per reply: tell the model, and let it do what it claimed or ask.
              corrected = true;
              this.messages.push({ role: 'user', content: UNBACKED_CLAIM_NOTE });
              continue;
            }
          }
        }
        if (!calls.length) break;
        if (this.hangupRequested) break;
      }
      await this.speechChain;
    } catch (err: any) {
      if (!abort.signal.aborted) this.fail(`model: ${err?.message ?? err}`);
    } finally {
      this.responding = false;
      if (this.turnAbort === abort) this.turnAbort = null;
      this.lastActivity = this.now();
      if (this.hangupRequested && !this.outcome) {
        await this.drain();
        void this.finish('completed');
      } else if (this.pendingTurn && !this.outcome) {
        this.pendingTurn = false;
        for (const said of this.queuedUser.splice(0)) this.messages.push({ role: 'user', content: said });
        this.beginTurnClock();
        void this.respond();
      }
    }
  }

  /** Run the model's tool calls. Returns true when a WRITE tool succeeded. */
  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<boolean> {
    let wrote = false;
    // Every call the model made gets an answer, even after a barge-in: a
    // history with an unanswered tool call is refused by the model API, and a
    // write it already decided on (a confirmed report) should still happen.
    for (const call of calls) {
      if (call.function.name === 'end_call') {
        this.hangupRequested = true;
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: '{"ok":true,"message":"The call will end now."}' });
        continue;
      }
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: '{"ok":false,"message":"The arguments were not valid JSON. Try again."}' });
        continue;
      }
      // A slow lookup gets a short spoken holding line, once per tool call.
      const filler = setTimeout(() => {
        // From disk only: synthesised live it arrived after the lookup.
        const clip = this.deps.assistantVoice.peek(HOLDING_LINE);
        if (!signal.aborted && this.playQueue.length === 0 && clip) this.enqueue(forPlayback(clip));
      }, TOOL_FILLER_MS);
      const started = this.now();
      let result: unknown;
      try {
        result = await this.deps.runTool(call.function.name, args);
      } finally {
        clearTimeout(filler);
      }
      const ok = (result as any)?.ok !== false;
      if (ok && WRITE_TOOLS.has(call.function.name)) wrote = true;
      this.deps.log('voice_local_tool', { tool: call.function.name, ms: this.now() - started, ok });
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result ?? {}).slice(0, 12_000) });
    }
    return wrote;
  }

  /** Queue a sentence: synthesised in order, played as soon as it is ready. */
  private say(sentence: string, signal: AbortSignal): void {
    const text = speakable(sentence);
    if (!text) return;
    const synth = this.deps.assistantVoice.speak(text, { personal: this.setup.personal, signal }).catch((err: any) => {
      if (!signal.aborted) this.fail(`speech: ${err?.message ?? err}`);
      return null;
    });
    this.speechChain = this.speechChain.then(async () => {
      const r = await synth;
      if (!r || signal.aborted || this.outcome) return;
      this.spokenThisTurn += (this.spokenThisTurn ? ' ' : '') + text;
      if (this.turnStartedAt && !this.turnFirstAudio) {
        this.turnFirstAudio = this.now();
        // Where the wait went: model to first words, then speech synthesis.
        this.deps.log('voice_local_turn', {
          model_ms: this.turnFirstText ? this.turnFirstText - this.turnStartedAt : null,
          first_audio_ms: this.turnFirstAudio - this.turnStartedAt,
          chars: text.length,
          cached: r.cached,
        });
      }
      this.enqueue(forPlayback(r.audio));
    });
  }

  /** Speak the opening; returns what was actually queued to be heard (all of it, unless the caller cut in). */
  private async speakOpening(opening: string): Promise<string> {
    // Split long assistant opening text into individual sentences so static
    // lines (like the NDPA disclosure) cache independently on disk and short
    // chunks synthesise fast in parallel while the Governor's intro is playing.
    const expanded = openingSentences(opening);

    // Kick off synthesis for all spoken segments in parallel, then enqueue in order.
    const openingStarted = this.now();
    const tasks = expanded.map((seg) => {
      if (seg.kind === 'break') return { seg, promise: null as Promise<Buffer> | null };
      const voice = seg.kind === 'governor' && this.deps.governorVoice ? this.deps.governorVoice : this.deps.assistantVoice;
      const promise = (async () => {
        try {
          const r = await voice.speak(seg.text, { personal: this.setup.personal, alwaysCache: seg.kind === 'governor' });
          // How long each part of the opening took, and whether it came from
          // disk: the first thing to read when a caller reports silence.
          this.deps.log('voice_local_opening_part', { part: seg.kind, cached: r.cached, ms: this.now() - openingStarted, chars: seg.text.length });
          return r.audio;
        } catch (err) {
          if (voice === this.deps.governorVoice) {
            this.deps.log('voice_local_governor_unavailable', { error: (err as Error).message });
            return (await this.deps.assistantVoice.speak(seg.text, { personal: this.setup.personal })).audio;
          }
          // Once more before handing the caller to the backup agent: a slow
          // first render (a new speed, a cold cache) is not a dead provider.
          this.deps.log('voice_local_opening_retry', { error: (err as Error).message, chars: seg.text.length });
          return (await voice.speak(seg.text, { personal: this.setup.personal })).audio;
        }
      })();
      // Attach a no-op catch so an earlier segment throwing doesn't cause an unhandled rejection.
      promise.catch(() => undefined);
      return { seg, promise };
    });

    const spoken = this.openingSpoken;
    this.openingActive = true;
    try {
      for (const { seg, promise } of tasks) {
        if (this.openingCut || this.outcome) break;
        if (seg.kind === 'break') {
          this.enqueue(silence(seg.ms));
          continue;
        }
        const audio = await promise!;
        if (this.openingCut || this.outcome) break;
        this.enqueue(forPlayback(audio));
        spoken.push(seg.text);
      }
    } finally {
      this.openingActive = false;
    }
    return spoken.join(' ');
  }

  // ── Playback: one frame every 20 ms, on a drift-corrected clock ──────────

  private enqueue(slin: Buffer): void {
    this.playQueue.push(...toFrames(slin));
    this.lastActivity = this.now();
  }

  /**
   * One frame every 20 ms, EVERY 20 ms, for the whole call.
   *
   * Asterisk forwards AudioSocket frames to the caller's RTP leg as they
   * arrive; nothing re-times them on the local line. So the timing heard by
   * the carrier is decided here, and two habits of the old pump made callers
   * hear words skipped:
   *
   *   - it sent NOTHING between sentences. The RTP stream stopped and
   *     restarted, and the far end's jitter buffer resynchronised on the
   *     restart, dropping the first packets — the start of the next sentence.
   *     Silence is sent instead, so the stream never stops.
   *   - the clock it kept was not the wall clock. After an event-loop stall
   *     the stream must CATCH UP: a jitter buffer holds audio that arrives a
   *     little early, and drops audio that arrives late. Measured through a
   *     real Asterisk with a busy event loop, dropping the lost time instead
   *     left the stream at 43 frames a second against the 50 the far end
   *     plays. So overdue frames go out at once, at most five per tick (a
   *     100 ms burst), and only a stall longer than 200 ms is written off.
   */
  private startPump(): void {
    const silenceFrame = Buffer.alloc(FRAME_BYTES);
    let next = this.now();
    const tick = () => {
      if (this.outcome) return;
      const now = this.now();
      if (now - next > 10 * FRAME_MS) next = now - FRAME_MS; // a long stall: write it off
      let sent = 0;
      while (now >= next && sent < 5) {
        const frame = this.playQueue.shift();
        if (frame) {
          this.recorder.add('agent', this.clockIndex(), frame);
          this.playedFrames++;
          this.lastActivity = now;
        }
        this.deps.sendAudio(frame ?? silenceFrame);
        next += FRAME_MS;
        sent++;
      }
      this.pump = setTimeout(tick, Math.max(1, next - this.now()));
      this.pump.unref?.();
    };
    this.pump = setTimeout(tick, 0);
    this.pump.unref?.();
  }

  /** Until everything queued has been heard (bounded, so a stuck queue cannot hold the line). */
  private async drain(maxMs = 30_000): Promise<void> {
    await this.speechChain.catch(() => undefined);
    const until = this.now() + maxMs;
    while (this.playQueue.length && this.now() < until && !this.outcome) {
      await new Promise((r) => setTimeout(r, FRAME_MS));
    }
  }

  // ── Ending ────────────────────────────────────────────────────────────────

  private fail(reason: string): void {
    if (this.outcome) return;
    this.failure = reason;
    this.deps.log('voice_local_failed_over', { reason });
    void this.finish('fallback');
  }

  finish(outcome: Outcome): Promise<void> {
    if (this.finishing) return this.finishing;
    this.outcome = outcome;
    this.finishing = (async () => {
      this.turnAbort?.abort();
      if (this.ackTimer) clearTimeout(this.ackTimer);
      if (this.continuationTimer) clearTimeout(this.continuationTimer);
      if (this.pump) clearTimeout(this.pump);
      if (this.watchdog) clearInterval(this.watchdog);
      this.playQueue = [];
      try {
        this.stt?.close();
      } catch {
        /* closing anyway */
      }
      try {
        this.deps.close();
      } catch {
        /* already gone */
      }
      this.resolveDone();
    })();
    return this.finishing;
  }
}

/** Tools that change a record. A claim that something was saved is true only after one of these succeeded. */
export const WRITE_TOOLS = new Set([
  'update-caller-profile',
  'book-appointment',
  'reschedule-booking',
  'cancel-booking',
  'create-ticket',
  'request-callback',
  'register-enrollee',
]);

/**
 * A sentence telling the caller something has been (or is being) saved,
 * updated or registered. The real model was caught saying "Let me update that
 * information for you. Hold on a moment while I save that. I've updated your
 * location." with no tool called at all — on the live line and in the
 * conversation check. Such a sentence is spoken only after a write tool
 * succeeded in the same reply.
 */
const SAVE_CLAIM =
  /\b(?:i(?:'ve| have)?\s+(?:now\s+|just\s+|also\s+)?(?:updated|saved|noted|recorded|registered|logged|changed)|let me (?:update|save|note|record|register|log|change)|i(?:'ll| will) (?:update|save|record|register|log)|(?:updating|saving|recording|registering) (?:that|this|it|your|the)|while i (?:update|save|record|register)|(?:has|have) been (?:successfully )?(?:updated|saved|recorded|registered|logged|changed))\b/i;

export function isSaveClaim(sentence: string): boolean {
  return SAVE_CLAIM.test(sentence);
}

/** Told to the model when it claimed a save it did not make (never heard by the caller). */
export const UNBACKED_CLAIM_NOTE =
  '[Note from the system, not the caller: your last reply said something was saved or updated, but no tool saved it. ' +
  'Nothing was saved, and the caller did not hear that sentence. If the caller has confirmed the details, call the tool ' +
  'that saves them now (update-caller-profile for their profile) and then tell them; if they have not confirmed, ask them to.]';

/**
 * What may be SPOKEN of a model's sentence. The model sometimes writes stage
 * directions ("Goodbye. [Ending the call now.]") and text formatting; every
 * character sent to the voice is read aloud. Square-bracketed asides, markdown
 * marks and ellipses go; the words stay.
 */
export function speakable(sentence: string): string {
  return sentence
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[*_#`~|<>]/g, ' ')
    .replace(/(\.\s*){2,}|…/g, ', ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/^[\s,.;:]+|[\s,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The opening as the caller hears it in text: markup gone, one space between parts. */
export function plain(text: string): string {
  return text
    .replace(/<break\s+time="[\d.]+s"\s*\/>/g, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type OpeningSegment = { kind: 'governor' | 'assistant'; text: string } | { kind: 'break'; ms: number };

/**
 * The opening as the call speaks it: the Governor's part, pauses, and the
 * assistant's part one SENTENCE at a time (each cached and synthesised on its
 * own). The prerender script uses this same function, so what it puts on disk
 * is exactly what a call asks for.
 */
export function openingSentences(opening: string): OpeningSegment[] {
  const out: OpeningSegment[] = [];
  for (const seg of openingSegments(opening)) {
    if (seg.kind !== 'assistant') {
      out.push(seg);
      continue;
    }
    for (const p of seg.text.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean)) out.push({ kind: 'assistant', text: p });
  }
  return out;
}

/** "<governor>…</governor> <break time="1.0s" /> I'm …" → governor, pause, assistant. */
export function openingSegments(opening: string): OpeningSegment[] {
  const out: OpeningSegment[] = [];
  const re = /<governor>([\s\S]*?)<\/governor>|<break\s+time="([\d.]+)s"\s*\/>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (raw: string) => {
    const t = plain(raw);
    if (t) out.push({ kind: 'assistant', text: t });
  };
  while ((m = re.exec(opening))) {
    pushText(opening.slice(last, m.index));
    if (m[1] !== undefined) {
      const t = plain(m[1]);
      if (t) out.push({ kind: 'governor', text: t });
    } else {
      out.push({ kind: 'break', ms: Math.min(5_000, Math.round(Number(m[2]) * 1000)) });
    }
    last = re.lastIndex;
  }
  pushText(opening.slice(last));
  return out;
}
