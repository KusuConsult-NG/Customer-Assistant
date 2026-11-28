import { FRAME_BYTES, FRAME_MS } from './audiosocket';
import { CallRecorder, forPlayback, rms, silence, toFrames } from './pcm';
import { SentenceSplitter, type ChatMessage, type LlmEvent, type ToolCall } from './llm';
import type { CachedSpeech } from './tts';
import type { SttFactory, SttStream } from './stt';
import type { OpenAiTool } from './voice-tools';
import { pronounced } from './pronounce';
import { PLATEAU_LGAS } from '@ace/database';

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
/** A tool slower than this gets a spoken holding line (only if no ack was already played). */
const TOOL_FILLER_MS = 2_400;
/**
 * No reply audio this long after the caller finished: say a single short
 * acknowledgement from disk so long lookups never feel like dead air.
 * High enough (2.4 s) that normal replies speak directly without robotic fillers.
 */
export const ACK_AFTER_MS = 1_400;
function ackAfterMs(): number {
  const raw = process.env.LOCAL_VOICE_ACK_AFTER_MS?.trim();
  if (raw === '0' || raw === 'off' || raw === 'false') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 200 ? n : ACK_AFTER_MS;
}
// Two words at least: Spitch rendered a bare "Okay." as 0.09 s of silence.
export const ACKS = ['One second, please.', 'Just a moment.'];
export const HOLDING_LINE = 'One moment, please.';
/** After the caller carries on speaking: how long to wait for the rest of their words before answering what was said. */
export const CONTINUATION_WAIT_MS = 2_500;
/**
 * Hold the start of a multi-sentence reply until either every sentence of the
 * round is synthesised, at least this much audio is ready, or the wait runs
 * out. Prevents a pause after a very short first sentence when the next one
 * is not back from the voice yet.
 *
 * Was 4.5 s: a ready first sentence (a 40-character one is about 2.5 s of
 * speech) was held until the 2 s reply deadline on most turns. Measured on
 * the server on 28 Nov 2026, Spitch returns a 46-character sentence in
 * 0.6–1.1 s and the next sentence is made while the first plays (two at a
 * time), so a second of speech in hand covers it. A pause that still happens
 * is logged as voice_local_playback_underrun.
 */
export const MIN_PREBUFFER_MS = 1_000;
/**
 * Silence put between two sentences of a reply. Every clip is trimmed to 30 ms
 * before and 130 ms after its speech (pcm.ts forPlayback), and the voice is
 * sent no full stop, so without this sentences ran into each other 0.16 s
 * apart — breathless. With it the gap is about 0.36 s, a speaker's pause.
 */
export const SENTENCE_GAP_MS = 200;
/** Between the two halves of a long sentence split at its comma: a comma's pause. */
export const CLAUSE_GAP_MS = 60;
/**
 * A sentence longer than this is sent to the voice in parts, split at a comma.
 * Measured on the server on 26 Nov 2026: the one long (155-character) sentence
 * was the one the voices read punctuation aloud in.
 */
export const LONG_SENTENCE_CHARS = 120;
export const MAX_PREBUFFER_WAIT_MS = 2_500;
/**
 * The longest a reply's first words wait for the rest to be ready, from the
 * server setting LOCAL_VOICE_PREBUFFER_WAIT_MS (milliseconds, 0–5000), else
 * MAX_PREBUFFER_WAIT_MS. 0 starts every reply as soon as its first sentence is
 * synthesised: the shortest silence after the caller, at the risk of a pause
 * between sentences when the voice is slow. Read on every turn, so a change
 * needs only an api restart.
 */
export function prebufferWaitMs(): number {
  const raw = process.env.LOCAL_VOICE_PREBUFFER_WAIT_MS?.trim();
  if (!raw) return MAX_PREBUFFER_WAIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 5_000 ? Math.round(n) : MAX_PREBUFFER_WAIT_MS;
}
/**
 * The longest the caller is left in silence, from the moment their turn was
 * committed, before a reply that is ready starts playing — however long the
 * pre-buffer would still wait for the rest of the reply. The owner's rule
 * (27 Nov 2026): the agent carries on within about 2.5 s of the caller going
 * quiet; recognition's endpointing (~0.4 s) comes before this clock starts.
 * It cannot make the model or the voice faster: a first sentence not yet made
 * plays the moment it is. LOCAL_VOICE_REPLY_DEADLINE_MS (0–8000) on the server.
 */
export const REPLY_DEADLINE_MS = 2_000;
export function replyDeadlineMs(): number {
  const raw = process.env.LOCAL_VOICE_REPLY_DEADLINE_MS?.trim();
  if (!raw) return REPLY_DEADLINE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 8_000 ? Math.round(n) : REPLY_DEADLINE_MS;
}
const MAX_TOOL_ROUNDS = 6;
/** Caller audio louder than this, with words recognised, while we talk = barge-in. */
const BARGE_IN_RMS = 900;
/** Caller loudness counts for a barge-in this long after it was heard: recognition's words arrive after the sound. */
export const BARGE_IN_LOUD_WINDOW_MS = 1_000;
/**
 * One word that stops the agent on its own, when it is ALL the caller has
 * said so far. Other single words ("okay", "yes", "mm") are a listener
 * following along and do not.
 */
export const STOP_WORD = /^(stop|wait|no|sorry|hello|excuse me|hold on|one second|one minute)[.!?,]*$/i;

/** Whether what recognition has heard so far, while the agent speaks, is the caller taking the turn. */
export function isBargeIn(text: string, loudForMs: number | null): boolean {
  if (loudForMs === null || loudForMs > BARGE_IN_LOUD_WINDOW_MS) return false;
  const t = text.trim();
  return t.split(/\s+/).filter(Boolean).length >= 2 || STOP_WORD.test(t);
}

/** A caller frame louder than this is someone speaking; a phone line's own noise stays well below it. */
export const CALLER_VOICE_RMS = 300;

/**
 * What reached the call from the caller's side, for the call-ended log line.
 * A call where the caller "was not heard" is told apart at once: no audio
 * frames at all (nothing came from Asterisk), frames but no voice in them
 * (the line delivered silence), or voice but no words (recognition failed).
 */
export interface CallerHearing {
  /** Seconds of caller audio that arrived from Asterisk. */
  audioSecs: number;
  /** Seconds of it loud enough to be speech. */
  voiceSecs: number;
  /** The loudest 20 ms frame (RMS). */
  peak: number;
  /** Recognition results with words in them: in progress, and final. */
  interims: number;
  finals: number;
}

export class VoiceSession {
  readonly transcript: TranscriptTurn[] = [];
  private callerFrames = 0;
  private callerVoiceFrames = 0;
  private callerPeak = 0;
  private interims = 0;
  private finals = 0;
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
  /** When recognition last returned the caller's words during this turn (0: none since the last turn began). */
  private lastWordsAt = 0;
  /** The LGA this call saved on the agent's behalf (saveNamedLga), so it is saved once. */
  private lgaSaved = '';
  /** From those words to the turn starting: how long recognition took to decide the caller had finished. */
  private turnEndpointMs: number | null = null;
  private lastActivity: number;
  private nudges = 0;
  private hangupRequested = false;
  private recentLevel = 0;
  private callerIndex = -1;
  private speechChain: Promise<void> = Promise.resolve();
  private spokenThisTurn = '';
  private turnPlaybackStarted = false;
  private turnStreamDone = false;
  private turnPendingSynths = 0;
  private turnPrebuffer: Array<{ audio: Buffer; text: string; cached: boolean; clause: boolean }> = [];
  private turnPrebufferMs = 0;
  private prebufferTimer: NodeJS.Timeout | null = null;
  private turnStartedAt = 0;
  private turnFirstText = 0;
  /** When the reply's first sentence was handed to the voice, and when its audio came back. */
  private turnFirstSentence = 0;
  private turnFirstClip = 0;
  /** How recognition ended the turn now being answered, and the silence it had heard. */
  private committedBy: { by: 'speech_final' | 'utterance_end'; silenceMs?: number } | null = null;
  private turnEndedBy: { by: 'speech_final' | 'utterance_end'; silenceMs?: number } | null = null;
  private endSignal: { by: 'speech_final' | 'utterance_end'; silenceMs?: number } | null = null;
  /** The caller's loudness: when last above the barge-in level, and since when without a break. */
  private lastLoudAt = 0;
  private loudSince = 0;
  private turnFirstAudio = 0;
  private ackTimer: NodeJS.Timeout | null = null;
  private ackIndex = 0;
  private ackPlayedThisTurn = false;
  /** Where the caller's words for the turn being answered sit (message and transcript), or -1 for a silence check. */
  private turnUserMessage = -1;
  private turnUserTranscript = -1;
  /** The caller carried on speaking before the reply was heard: the next words join the same turn. */
  private continuing = false;
  private continuationTimer: NodeJS.Timeout | null = null;
  /**
   * The opening's QUESTION (its last sentence) starts playing at this frame.
   * Until then the caller has not been asked anything: what they say is a
   * reply to the greeting ("good evening"), not an answer. Infinity until the
   * opening has been queued.
   */
  private openingQuestionFrame = Number.POSITIVE_INFINITY;
  /** What the caller said before the opening's question began, held until it does. */
  private saidDuringGreeting: string[] = [];
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
        onFinal: (text, end, silenceMs) => this.onFinal(text, end, silenceMs),
        onUtteranceEnd: (silenceMs) => {
          this.endSignal = { by: 'utterance_end', silenceMs };
          this.commitTurn();
        },
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
    try {
      await this.speakOpening(this.setup.opening);
    } catch (err: any) {
      return this.fail(`opening: ${err?.message ?? err}`);
    }
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

  /** What reached the call from the caller (see CallerHearing). */
  get hearing(): CallerHearing {
    const secs = (frames: number) => Math.round((frames * FRAME_MS) / 100) / 10;
    return { audioSecs: secs(this.callerFrames), voiceSecs: secs(this.callerVoiceFrames), peak: Math.round(this.callerPeak), interims: this.interims, finals: this.finals };
  }

  /** One AudioSocket audio frame from the caller. */
  onCallerAudio(frame: Buffer): void {
    if (this.outcome) return;
    this.callerIndex = Math.max(this.callerIndex + 1, this.clockIndex());
    this.recorder.add('caller', this.callerIndex, frame);
    const level = rms(frame);
    this.callerFrames++;
    if (level > CALLER_VOICE_RMS) this.callerVoiceFrames++;
    if (level > this.callerPeak) this.callerPeak = level;
    this.recentLevel = this.recentLevel * 0.7 + level * 0.3;
    if (level > BARGE_IN_RMS) {
      const t = this.now();
      if (!this.lastLoudAt || t - this.lastLoudAt > 300) this.loudSince = t;
      this.lastLoudAt = t;
    }
    this.stt?.send(frame);
  }

  /** Asterisk said the caller hung up, or the socket closed. */
  callerHungUp(): void {
    if (!this.outcome) void this.finish('caller_hung_up');
  }

  // ── Listening ─────────────────────────────────────────────────────────────

  private onInterim(text: string): void {
    if (text) {
      this.interims++;
      this.lastWordsAt = this.now();
    }
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
    // Never while the opening is still before its question: the greeting and
    // the recording notice are played whole, and a caller saying "good evening"
    // back to the Governor is not talking over anyone.
    if (this.inGreeting()) return;
    const loudFor = this.lastLoudAt ? this.now() - this.lastLoudAt : null;
    if ((this.playQueue.length > 0 || this.responding) && isBargeIn(text, loudFor)) {
      this.interrupt(text);
    }
  }

  private onFinal(text: string, endOfTurn: boolean, silenceMs?: number): void {
    if (text) {
      this.finals++;
      this.heard.push(text);
      // The end-of-turn result comes AFTER recognition's own silence wait, so
      // it is not when the caller stopped; segments within the turn are.
      if (!endOfTurn) this.lastWordsAt = this.now();
      this.lastCallerSpeech = this.now();
      this.lastActivity = this.now();
    }
    if (endOfTurn) {
      this.endSignal = { by: 'speech_final', silenceMs };
      this.commitTurn();
    }
  }

  private commitTurn(): void {
    const said = this.heard.join(' ').trim();
    const signal = this.endSignal;
    this.endSignal = null;
    if (!said || this.outcome) return;
    this.committedBy = signal;
    this.heard = [];
    this.nudges = 0;
    if (this.inGreeting()) {
      // Before the opening has asked its question. Answered now, "Good." (from
      // "good evening" to the Governor) was taken as the answer to "Are you
      // still calling from Rockhaven?", and the reply "Thank you for
      // confirming" played the moment that question ended.
      this.saidDuringGreeting.push(said);
      this.transcript.push({ role: 'user', message: said, atSecs: this.secs() });
      return;
    }
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
      this.interrupt(said);
      this.pendingTurn = true;
      return;
    }
    this.messages.push({ role: 'user', content: said });
    this.turnUserMessage = this.messages.length - 1;
    this.turnUserTranscript = this.transcript.length - 1;
    this.beginTurnClock();
    void this.respond();
  }

  /** The opening is still playing and has not yet reached its question. */
  private inGreeting(): boolean {
    return this.playedFrames < this.openingQuestionFrame && this.openingQuestionFrame !== -1;
  }

  /**
   * The opening's question has started: deal with what was said before it.
   * Only short greetings and acknowledgements ("good evening", "hello",
   * "okay"): dropped, and the caller's answer to the question is awaited. Anything
   * more ("I want to report a fire"): answered, the model told it came
   * before the question, so it is never read as the answer to it.
   */
  private releaseGreetingSpeech(): void {
    this.openingQuestionFrame = -1; // the opening is over for this purpose
    const held = this.saidDuringGreeting.splice(0);
    if (!held.length || this.outcome) return;
    const text = held.join(' ').trim();
    if (isGreetingReply(text)) {
      this.deps.log('voice_local_greeting_reply_ignored', { text: text.slice(0, 80) });
      return;
    }
    this.messages.push({ role: 'user', content: `(Said while the greeting was still playing, before you asked your question:) ${text}` });
    this.turnUserMessage = this.messages.length - 1;
    this.turnUserTranscript = -1;
    this.beginTurnClock();
    void this.respond();
  }

  /** Drop the reply being prepared, without treating it as the caller talking over it. */
  private abortReplyQuietly(): void {
    this.clearPrebuffer();
    this.playQueue = [];
    this.turnAbort?.abort();
    this.speechChain = Promise.resolve();
  }

  /** The caller has finished: time the reply, and acknowledge only if genuinely slow. */
  private beginTurnClock(): void {
    this.turnStartedAt = this.now();
    this.turnEndedBy = this.committedBy;
    this.committedBy = null;
    this.turnFirstSentence = 0;
    this.turnFirstClip = 0;
    this.turnEndpointMs = this.lastWordsAt ? this.turnStartedAt - this.lastWordsAt : null;
    this.lastWordsAt = 0;
    this.turnFirstText = 0;
    this.turnFirstAudio = 0;
    this.ackPlayedThisTurn = false;
    if (this.ackTimer) clearTimeout(this.ackTimer);
    const delay = ackAfterMs();
    if (delay <= 0) return;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.turnFirstAudio || this.outcome || this.playQueue.length || this.ackPlayedThisTurn) return;
      const text = ACKS[this.ackIndex++ % ACKS.length];
      const clip = this.deps.assistantVoice.peek(text);
      if (!clip) return;
      this.ackPlayedThisTurn = true;
      this.enqueue(forPlayback(clip));
      this.deps.log('voice_local_ack', { text, ms: this.now() - this.turnStartedAt });
    }, delay);
    this.ackTimer.unref?.();
  }

  private interrupt(heard = ''): void {
    const playing = this.playQueue.length > 0;
    this.clearPrebuffer();
    this.playQueue = [];
    this.turnAbort?.abort();
    this.speechChain = Promise.resolve();
    // after_voice_ms: from the caller starting to talk to the agent going quiet.
    this.deps.log('voice_local_barge_in', {
      after_voice_ms: this.loudSince ? this.now() - this.loudSince : null,
      words: heard.split(/\s+/).filter(Boolean).length,
      was_playing: playing,
    });
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
        // Keep sentences whole instead of slicing mid-sentence at commas so
        // speech cadence sounds warm and human rather than choppy.
        const splitter = new SentenceSplitter({ firstAtComma: false });
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
        this.turnPlaybackStarted = false;
        this.turnStreamDone = false;
        this.turnPendingSynths = 0;
        this.clearPrebuffer();
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
        this.turnStreamDone = true;
        if (!abort.signal.aborted && !this.outcome && this.turnPendingSynths === 0 && this.turnPrebuffer.length > 0) {
          this.flushPrebuffer();
        }

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

        let allOk = true;
        if (calls.length) {
          const ran = await this.runTools(calls, abort.signal);
          if (ran.wrote) wrote = true;
          allOk = ran.allOk;
        }
        await this.saveNamedLga(calls, told());
        if (held.length) {
          if (wrote && !abort.signal.aborted) {
            // Now true: say it, after the write that makes it so.
            this.turnStreamDone = false;
            for (const h of held) {
              spokenParts.push(h);
              this.say(h, abort.signal);
            }
            this.turnStreamDone = true;
            if (!this.outcome && this.turnPendingSynths === 0 && this.turnPrebuffer.length > 0) {
              this.flushPrebuffer();
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
        // Spoken and saved in one response: the reply already asked its next
        // question and every save succeeded, so there is nothing for a second
        // trip to the model to add. It would cost a whole request and, when
        // the model saves first and speaks after, about two seconds of silence.
        if (allOk && !held.length && /\?\s*$/.test(told()) && calls.every((c) => c.function.name === 'update-caller-profile')) {
          this.deps.log('voice_local_second_trip_skipped');
          break;
        }
      }
      await this.speechChain;
      if (!abort.signal.aborted && !this.outcome && this.turnPrebuffer.length > 0) {
        this.flushPrebuffer();
      }
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

  /**
   * The caller named their LGA in answer to the LGA question, and the agent
   * moved on to ward and community without saving it (conversation check,
   * 28 Nov 2026: 2 of 3 new callers). Saved here, once. A change to a location
   * already on file is still refused by the tool until it is read back.
   */
  private async saveNamedLga(calls: ToolCall[], told: string): Promise<void> {
    if (!/\bward\b/i.test(told)) return;
    if (calls.some((c) => c.function.name === 'update-caller-profile' && /"lga"\s*:/.test(c.function.arguments || ''))) return;
    if (!/local government area|\bLGA\b/i.test(agentWordsBeforeCaller(this.messages))) return;
    const lga = lgaNamed(lastCallerWords(this.messages), PLATEAU_LGAS);
    if (!lga || this.lgaSaved === lga) return;
    this.lgaSaved = lga;
    try {
      const r: any = await this.deps.runTool('update-caller-profile', { lga });
      this.deps.log('voice_local_lga_saved', { ok: r?.ok !== false });
    } catch {
      this.deps.log('voice_local_lga_saved', { ok: false });
    }
  }

  /** Run the model's tool calls. Returns whether a WRITE tool succeeded, and whether every call did. */
  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<{ wrote: boolean; allOk: boolean }> {
    let wrote = false;
    let allOk = true;
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
      const refusal = unconfirmedReport(call.function.name, args, lastCallerWords(this.messages));
      if (refusal) {
        // The model read a "No, nothing else." as the yes to its summary and
        // registered the report (conversation check, 27 Nov 2026). Nothing is
        // written; the model is told why and asks again.
        // The caller's own words are not logged: only that it happened.
        this.deps.log('voice_local_report_not_confirmed');
        this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(refusal) });
        allOk = false;
        continue;
      }
      const guard = readBackGuard(call.function.name, args, agentWordsBeforeCaller(this.messages), lastCallerWords(this.messages));
      if (guard.note) {
        this.deps.log('voice_local_readback_required', { tool: call.function.name });
        allOk = false;
      }
      args = guard.args;
      // A slow lookup gets a short spoken holding line — only when fillers are enabled and at most once per turn.
      const filler =
        ackAfterMs() > 0
          ? setTimeout(() => {
              if (this.ackPlayedThisTurn) return;
              const clip = this.deps.assistantVoice.peek(HOLDING_LINE);
              if (!signal.aborted && this.playQueue.length === 0 && clip) {
                this.ackPlayedThisTurn = true;
                this.enqueue(forPlayback(clip));
              }
            }, TOOL_FILLER_MS)
          : null;
      const started = this.now();
      let result: unknown;
      try {
        result = await this.deps.runTool(call.function.name, args);
      } finally {
        if (filler) clearTimeout(filler);
      }
      const ok = (result as any)?.ok !== false;
      if (!ok) allOk = false;
      if (ok && WRITE_TOOLS.has(call.function.name)) wrote = true;
      this.deps.log('voice_local_tool', { tool: call.function.name, ms: this.now() - started, ok });
      let content: Record<string, unknown> = result && typeof result === 'object' ? { ...(result as any) } : { result };
      if (guard.note) content = { ...content, note: guard.note };
      if (call.function.name === 'search-knowledge') content = { ...content, howToSpeakIt: knowledgeGuidance(result) };
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(content).slice(0, 12_000) });
    }
    return { wrote, allOk };
  }

  private clearPrebuffer(): void {
    if (this.prebufferTimer) {
      clearTimeout(this.prebufferTimer);
      this.prebufferTimer = null;
    }
    this.turnPrebuffer = [];
    this.turnPrebufferMs = 0;
  }

  private flushPrebuffer(): void {
    if (this.prebufferTimer) {
      clearTimeout(this.prebufferTimer);
      this.prebufferTimer = null;
    }
    this.turnPlaybackStarted = true;
    const clips = this.turnPrebuffer.splice(0);
    this.turnPrebufferMs = 0;
    for (const c of clips) this.enqueueSpoken(c.audio, c.text, c.cached, c.clause);
  }

  /** `clause`: the second half of a sentence split at its comma (a shorter pause before it). */
  private enqueueSpoken(clip: Buffer, text: string, cached: boolean, clause = false): void {
    // A pause before every sentence but the reply's first, so the voice breathes.
    if (this.spokenThisTurn) this.enqueue(silence(clause ? CLAUSE_GAP_MS : SENTENCE_GAP_MS));
    this.spokenThisTurn += (this.spokenThisTurn ? ' ' : '') + text;
    if (this.turnStartedAt && !this.turnFirstAudio) {
      this.turnFirstAudio = this.now();
      // Where the wait went: recognition deciding the caller had finished
      // (endpoint_ms, before the clock starts), the model's first words, then
      // speech synthesis. The caller's silence is endpoint_ms + first_audio_ms.
      this.deps.log('voice_local_turn', {
        endpoint_ms: this.turnEndpointMs,
        ended_by: this.turnEndedBy?.by ?? null,
        silence_heard_ms: this.turnEndedBy?.silenceMs ?? null,
        first_sentence_ms: this.turnFirstSentence ? this.turnFirstSentence - this.turnStartedAt : null,
        first_clip_ms: this.turnFirstClip ? this.turnFirstClip - this.turnStartedAt : null,
        model_ms: this.turnFirstText ? this.turnFirstText - this.turnStartedAt : null,
        first_audio_ms: this.turnFirstAudio - this.turnStartedAt,
        chars: text.length,
        cached,
      });
    }
    this.enqueue(clip);
  }

  /** Queue a sentence: synthesised in parallel, pre-buffered so multi-sentence replies play seamlessly without mid-speech gaps. */
  private say(sentence: string, signal: AbortSignal): void {
    const text = speakable(sentence);
    if (!text) return;
    splitLongSentence(text).forEach((part, i) => this.sayPart(part, i > 0, signal));
  }

  /** One clip of a reply. `text` is what the caller is told (and recorded); the voice is given its spoken form. */
  private sayPart(text: string, clause: boolean, signal: AbortSignal): void {
    if (this.turnStartedAt && !this.turnFirstSentence) this.turnFirstSentence = this.now();
    this.turnPendingSynths++;
    const synth = this.deps.assistantVoice.speak(pronounced(text), { personal: this.setup.personal, signal }).catch((err: any) => {
      if (!signal.aborted) this.fail(`speech: ${err?.message ?? err}`);
      return null;
    });
    this.speechChain = this.speechChain.then(async () => {
      const r = await synth;
      this.turnPendingSynths = Math.max(0, this.turnPendingSynths - 1);
      if (!r || signal.aborted || this.outcome) return;
      if (this.turnStartedAt && !this.turnFirstClip) this.turnFirstClip = this.now();
      const clip = forPlayback(r.audio);
      if (this.turnPlaybackStarted) {
        if (this.playQueue.length === 0) {
          this.deps.log('voice_local_playback_underrun', { chars: text.length, cached: r.cached });
        }
        this.enqueueSpoken(clip, text, r.cached, clause);
        return;
      }
      this.turnPrebuffer.push({ audio: clip, text, cached: r.cached, clause });
      this.turnPrebufferMs += Math.round(clip.length / 16);
      // The pre-buffer waits for the rest of the reply, but never past the
      // reply deadline counted from when the caller's turn was committed.
      const sinceCaller = this.turnStartedAt ? this.now() - this.turnStartedAt : 0;
      const wait = Math.min(prebufferWaitMs(), Math.max(0, replyDeadlineMs() - sinceCaller));
      if (wait === 0 || (this.turnStreamDone && this.turnPendingSynths === 0) || this.turnPrebufferMs >= MIN_PREBUFFER_MS) {
        this.flushPrebuffer();
      } else if (!this.prebufferTimer) {
        this.prebufferTimer = setTimeout(() => {
          this.prebufferTimer = null;
          if (!signal.aborted && !this.outcome) this.flushPrebuffer();
        }, wait);
        this.prebufferTimer.unref?.();
      }
    });
  }

  /** Speak the opening, whole: it is never cut short. Returns what was queued. */
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

    const spoken: string[] = [];
    const lastIndex = tasks.length - 1;
    for (const [i, { seg, promise }] of tasks.entries()) {
      if (this.outcome) break;
      if (seg.kind === 'break') {
        this.enqueue(silence(seg.ms));
        continue;
      }
      const audio = await promise!;
      if (this.outcome) break;
      // The last sentence is the question: it starts once everything queued
      // ahead of it has been played.
      if (i === lastIndex) this.openingQuestionFrame = this.playedFrames + this.playQueue.length;
      this.enqueue(forPlayback(audio));
      spoken.push(seg.text);
    }
    if (this.openingQuestionFrame === Number.POSITIVE_INFINITY) this.openingQuestionFrame = this.playedFrames + this.playQueue.length;
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
      if (this.openingQuestionFrame >= 0 && this.openingQuestionFrame !== Number.POSITIVE_INFINITY && this.playedFrames >= this.openingQuestionFrame) {
        this.releaseGreetingSpeech();
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
      this.clearPrebuffer();
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

/**
 * A reply to a greeting or a bare acknowledgement — "good evening", "hello",
 * "okay", "thank you" — as opposed to the caller saying what they want.
 * Recognition often keeps only part ("Good.").
 */
export function isGreetingReply(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z' ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4) return false;
  const ok = new Set(['good', 'morning', 'afternoon', 'evening', 'day', 'hello', 'hi', 'hey', 'yes', 'yeah', 'okay', 'ok', 'alright', 'thank', 'thanks', 'you', 'sir', 'madam', 'ma', 'please', 'go', 'ahead', 'hmm', 'mm', 'uh', 'um', 'ah', 'oh', 'and', 'to', 'too', 'same', 'welcome', 'nanpan', 'excellency']);
  return words.every((w) => ok.has(w));
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

/**
 * Exactly the texts the voice is given for one sentence of a reply: what
 * say() and sayPart() send (stage directions dropped, a long sentence split
 * at a comma, then respelled for pronunciation). The prerender uses this, so
 * a clip it renders is under the key a live reply asks for.
 */
export function spokenParts(sentence: string): string[] {
  const text = speakable(sentence);
  return text ? splitLongSentence(text).map((part) => pronounced(part)) : [];
}

/**
 * A sentence longer than LONG_SENTENCE_CHARS, split at the comma nearest its
 * middle that leaves at least four words on each side; each half split again
 * while still too long. Shorter sentences, and long ones with no such comma,
 * are returned whole.
 */
export function splitLongSentence(text: string): string[] {
  if (text.length <= LONG_SENTENCE_CHARS) return [text];
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  let best = -1;
  for (let i = text.indexOf(','); i >= 0; i = text.indexOf(',', i + 1)) {
    if (!/\s/.test(text[i + 1] ?? '')) continue; // "1,000" is not a clause break
    if (words(text.slice(0, i)) < 4 || words(text.slice(i + 1)) < 4) continue;
    if (best < 0 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2)) best = i;
  }
  if (best < 0) return [text];
  return [...splitLongSentence(text.slice(0, best + 1).trim()), ...splitLongSentence(text.slice(best + 1).trim())];
}

/**
 * The caller's most recent words in the history: the last user message that
 * is not a note from the system ("[No reply from the caller…]", "[Note from
 * the system…]"). Empty when the caller has not spoken.
 */
export function lastCallerWords(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const text = String(m.content ?? '').trim();
    if (text.startsWith('[')) continue;
    return text.replace(/^\(Said while the greeting was still playing[^)]*\)\s*/, '');
  }
  return '';
}

/**
 * A report is registered as CONFIRMED only after a yes. When the caller's last
 * words begin with "No" ("No, nothing else.", "No, that is wrong"), a
 * create-ticket with summaryConfirmed is refused and nothing is written. An
 * emergency still happening (isOngoing) is never held for a summary, so it is
 * never refused here.
 */
const DIGIT_WORDS: Record<string, string> = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/** The digits a sentence says, written or as words ("0803, one two three" → "0803123"). */
export function digitsSpoken(text: string): string {
  return (text.toLowerCase().match(/\d|[a-z]+/g) ?? []).map((t) => (/\d/.test(t) ? t : DIGIT_WORDS[t] ?? '')).join('');
}

/** What the agent said in its last reply BEFORE the caller's latest words: the read-back the caller answered. */
export function agentWordsBeforeCaller(messages: ChatMessage[]): string {
  let i = messages.length - 1;
  while (i >= 0 && !(messages[i].role === 'user' && !/^\[/.test(String(messages[i].content ?? '').trim()))) i--;
  for (let j = i - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
    if (m.role === 'user' && !/^\[/.test(String(m.content ?? '').trim())) break;
  }
  return '';
}

/**
 * A number the caller has not heard read back is not treated as confirmed,
 * whatever the model says (conversation check, 28 Nov 2026: callbacks booked
 * and hidden-number callers' numbers saved with no read-back).
 * - request-callback with numberConfirmed=true: the agent's last reply must
 *   have said at least seven digits and the caller's answer not be a "no";
 *   otherwise it is sent unconfirmed, and the tool returns the number to read.
 * - update-caller-profile with alternativePhoneConfirmed=true: the agent's
 *   last reply must have said that number's last seven digits; otherwise the
 *   number is left out of the save (everything else is saved) and the model
 *   is told to read it back.
 * Returns the arguments to use and, when something was held back, a note for the model.
 */
export function readBackGuard(
  tool: string,
  args: Record<string, any>,
  agentSaid: string,
  callerSaid: string,
): { args: Record<string, any>; note?: string } {
  const yes = (v: unknown) => /^(true|yes)$/i.test(String(v ?? ''));
  const saidNo = /^\W*no\b/i.test(callerSaid);
  const spoken = digitsSpoken(agentSaid);
  if (tool === 'request-callback' && yes(args.numberConfirmed) && (spoken.length < 7 || saidNo)) {
    return {
      args: { ...args, numberConfirmed: false },
      note: 'Not booked yet: the caller has not heard the number read back. Read it back digit by digit as this result gives it, wait for a clear yes, then call request-callback again with numberConfirmed=true.',
    };
  }
  if (tool === 'update-caller-profile' && yes(args.alternativePhoneConfirmed)) {
    const number = String(args.alternativePhone ?? '').replace(/\D/g, '');
    const last7 = number.slice(-7);
    if (!last7 || !spoken.includes(last7) || saidNo) {
      const { alternativePhone: _p, alternativePhoneConfirmed: _c, ...rest } = args;
      const digits = number.split('').join(' ');
      return {
        args: rest,
        note: `The number was NOT saved: the caller has not heard it read back. Read it back digit by digit ("${digits}"), ask if it is correct, and only after a clear yes save it with alternativePhoneConfirmed=true.`,
      };
    }
  }
  return { args };
}

/** What the model is told with every knowledge answer on the phone line: lists three at a time, and no answer means a callback offer. */
export function knowledgeGuidance(result: any): string {
  const found = result?.data?.found !== false && String(result?.speak ?? '').trim() !== '';
  return found
    ? 'Speak this on the phone: if it lists more than three items (events, offices, programmes, steps), first say how many there are, give the first three, and ask whether to continue; give the rest only if they say yes.'
    : 'Nothing verified was found. Say plainly, in one sentence, that you do not have that information, then offer to have a desk officer call them back (request-callback). Do not suggest other places to ask.';
}

/** The one Plateau LGA the caller's words name, if exactly one. */
export function lgaNamed(text: string, lgas: readonly string[]): string | null {
  const hits = lgas.filter((l) => new RegExp(`(^|[^a-z])${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i').test(text));
  return hits.length === 1 ? hits[0] : null;
}

export function unconfirmedReport(tool: string, args: Record<string, any>, callerSaid: string): Record<string, unknown> | null {
  if (tool !== 'create-ticket') return null;
  if (!/^(true|yes)$/i.test(String(args.summaryConfirmed ?? ''))) return null;
  if (/^(true|yes)$/i.test(String(args.isOngoing ?? ''))) return null;
  if (!/^\W*no\b/i.test(callerSaid)) return null;
  return {
    ok: false,
    message:
      `Nothing was registered. The caller's last words were "${callerSaid.slice(0, 120)}", which is not a yes to your summary. ` +
      'If they corrected something, correct the summary and read it back; otherwise ask "Is this summary accurate?" and wait for a clear yes before calling create-ticket again.',
  };
}
