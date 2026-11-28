import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import { decryptSecret, prisma, phoneNumberVariants } from '@ace/database';
import { chatCompletionsUrl, llmConfig } from '@ace/orchestrator';
import {
  isPlateauStateOrg,
  pickPlateauMalePersona,
  pickPlateauPersona,
  resolvePersona,
  type AgentOrganization,
} from '../agent-tools/agent-tool-catalog';
import { AgentToolsService } from '../agent-tools/agent-tools.service';
import { ElevenLabsWebhookService, type PostCallPayload } from '../agent-tools/elevenlabs-webhook.service';
import {
  GOVERNOR_VOICE_ID,
  VOICE_MODEL_ID,
  VOICE_SETTINGS,
} from '../agent-tools/elevenlabs-contracts';
import { localRecordingRef } from '../common/call-recording';
import { organizationForDialledNumber } from '../common/dialled-number';
import { CALL_RECORDING_BUCKET, storageDriver, uploadObject } from '../common/object-storage';
import { FRAME_BYTES, FrameReader, KIND, encodeFrame, uuidFromPayload } from './audiosocket';
import { mulawBufferToSlin, warmResampler } from './pcm';
import { callOpening, callSystemPrompt } from './call-setup';
import { streamChat, warmPromptCache } from './llm';
import { deepgramStt, type SttFactory } from './stt';
import {
  assistantGenderFromEnv,
  assistantTtsFromEnv,
  CachedSpeech,
  ElevenLabsTts,
  spitchCircuitState,
  SpitchTts,
  speedFromEnv,
  StaticGovernorAudio,
  type SpeechEngine,
} from './tts';
import { TtsCache } from './tts-cache';
import { clipCheckFromEnv, type ClipCheck } from './speech-check';
import { localToolDefinitions, runLocalTool } from './voice-tools';
import { VoiceSession, type Outcome } from './voice-session';

/**
 * The phone line answered on THIS server, by Asterisk's AudioSocket, instead of
 * by ElevenLabs. OFF unless `LOCAL_VOICE_PIPELINE=1`.
 *
 * ── How a call reaches it ──────────────────────────────────────────────────
 *
 *  1. Asterisk POSTs /api/voice-local/register (caller, dialled number, the
 *     shared secret). The answer is `ok <uuid>` or `fallback <reason>`.
 *     `fallback` sends the call straight to the ElevenLabs agent, exactly as
 *     today — so a missing key, an unknown number or a switched-off pipeline
 *     never costs a call.
 *  2. On `ok`, Asterisk opens AudioSocket(uuid, 127.0.0.1:<port>) and the call
 *     runs as a VoiceSession.
 *  3. When that leg ends, Asterisk GETs /api/voice-local/outcome/<uuid>:
 *     `fallback` → the call goes on to ElevenLabs (the session failed);
 *     anything else → hang up.
 *
 * The AudioSocket port listens on 127.0.0.1 only: it carries raw call audio
 * with no authentication of its own, which is acceptable only because nothing
 * but Asterisk on the same machine can reach it.
 */

const REGISTRATION_TTL_MS = 30_000;

/**
 * End the AudioSocket leg with an explicit HANGUP frame, then close. Tested on
 * Asterisk 20.6: a bare close is only noticed when audio happens to be
 * flowing, so a silent caller would sit on a dead leg and never reach the
 * ElevenLabs fallback. The frame is noticed at once.
 */
function hangUp(socket: net.Socket): void {
  if (socket.destroyed) return;
  try {
    socket.end(encodeFrame(KIND.HANGUP));
  } catch {
    socket.destroy();
  }
  setTimeout(() => socket.destroy(), 2_000).unref?.();
}
const OUTCOME_TTL_MS = 10 * 60_000;

interface Registration {
  uuid: string;
  organizationId: string;
  callerNumber: string;
  calledNumber: string;
  at: number;
}

export interface Readiness {
  enabled: boolean;
  ready: boolean;
  missing: string[];
}

@Injectable()
export class LocalVoiceService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LocalVoiceService.name);
  private server: net.Server | null = null;
  private readonly pending = new Map<string, Registration>();
  private readonly outcomes = new Map<string, { outcome: Outcome; at: number }>();
  private readonly live = new Set<VoiceSession>();
  private cache: TtsCache | null = null;
  /** Replaceable in tests: the provider each part talks to. */
  stt: SttFactory = deepgramStt;
  llm = streamChat;
  warmLlm: ((m: any[], t: any[]) => Promise<void>) | undefined = (m, t) => warmPromptCache(m, t);
  assistantEngine: (gender?: 'male' | 'female') => SpeechEngine | null = (gender) => assistantTtsFromEnv(gender);
  private static readonly defaultGovernorEngine = (key: string): SpeechEngine =>
    StaticGovernorAudio.fromDisk() ?? new ElevenLabsTts(key, GOVERNOR_VOICE_ID, VOICE_MODEL_ID, VOICE_SETTINGS);
  governorEngine: (key: string) => SpeechEngine = LocalVoiceService.defaultGovernorEngine;

  constructor(
    private readonly tools: AgentToolsService,
    private readonly ingestion: ElevenLabsWebhookService,
  ) {}

  // ── Configuration ─────────────────────────────────────────────────────────

  static enabled(): boolean {
    return process.env.LOCAL_VOICE_PIPELINE === '1';
  }

  readiness(): Readiness {
    const missing: string[] = [];
    if (!process.env.LOCAL_VOICE_SECRET?.trim()) missing.push('LOCAL_VOICE_SECRET');
    if (!process.env.DEEPGRAM_API_KEY?.trim()) missing.push('DEEPGRAM_API_KEY');
    if (!this.assistantEngine()) missing.push('SPITCH_API_KEY / YARNGPT_API_KEY / AZURE_SPEECH_KEY / OPENAI_API_KEY / DEEPGRAM_API_KEY');
    if (!llmConfig().apiKey) missing.push('OPENAI_API_KEY');
    const enabled = LocalVoiceService.enabled();
    return { enabled, ready: enabled && missing.length === 0 && !!this.server, missing };
  }

  private cacheDir(): string {
    return process.env.VOICE_CACHE_DIR?.trim() || path.join(process.env.STORAGE_DIR?.trim() || process.cwd(), 'tts-cache');
  }

  onModuleInit(): void {
    if (!LocalVoiceService.enabled() || process.env.NODE_ENV === 'test') return;
    this.listen();
  }

  onModuleDestroy(): void {
    for (const s of this.live) void s.finish('fallback');
    this.server?.close();
    this.server = null;
  }

  // 127.0.0.1 on a plain server; 0.0.0.0 INSIDE a container, whose port is
  // then published on the host's 127.0.0.1 only (deploy/single-server).
  listen(port = Number(process.env.AUDIOSOCKET_PORT || 9092), host = process.env.AUDIOSOCKET_HOST?.trim() || '127.0.0.1'): Promise<number> {
    warmResampler();
    const maxMb = Number(process.env.VOICE_CACHE_MAX_MB || 2048);
    this.cache = new TtsCache(this.cacheDir(), maxMb * 1024 * 1024);
    this.server = net.createServer((socket) => this.accept(socket));
    this.server.maxConnections = Number(process.env.LOCAL_VOICE_MAX_CALLS || 30);
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => {
        const actual = (this.server!.address() as net.AddressInfo).port;
        this.log.log(`voice_local_listening ${host}:${actual}`);
        resolve(actual);
      });
    });
  }

  // ── Step 1: register ──────────────────────────────────────────────────────

  secretMatches(given: string | undefined): boolean {
    const want = process.env.LOCAL_VOICE_SECRET?.trim();
    if (!want || !given) return false;
    const a = Buffer.from(want);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** `ok <uuid>` to answer locally, `fallback <reason>` to send the call to ElevenLabs. */
  async register(callerNumber: string, calledNumber: string): Promise<string> {
    const r = this.readiness();
    if (!r.enabled) return 'fallback disabled';
    if (!r.ready) {
      this.log.warn(`voice_local_not_ready missing=${r.missing.join(',') || 'listener'}`);
      return 'fallback not-ready';
    }
    const primaryTts = this.assistantEngine();
    if (primaryTts instanceof SpitchTts) {
      const cb = spitchCircuitState();
      if (cb.open) {
        this.log.warn(`voice_local_spitch_circuit_open failures=${cb.consecutiveFailures} retryAfterMs=${cb.retryAfterMs}`);
        return 'fallback spitch-circuit-open';
      }
    }
    if (this.live.size >= (this.server?.maxConnections ?? 30)) return 'fallback busy';
    const organizationId = await this.organizationFor(calledNumber).catch(() => null);
    if (!organizationId) {
      this.log.warn(`voice_local_unknown_number called=${calledNumber}`);
      return 'fallback unknown-number';
    }
    this.sweep();
    const uuid = randomUUID();
    this.pending.set(uuid, { uuid, organizationId, callerNumber: callerNumber.trim(), calledNumber: calledNumber.trim(), at: Date.now() });
    return `ok ${uuid}`;
  }

  /**
   * The agency that owns the dialled number: its TelephonyConfig line first,
   * then `LOCAL_VOICE_ORGANIZATION_SLUG` for a bridge whose carrier delivers
   * every call to one extension whatever number was dialled.
   */
  async organizationFor(calledNumber: string): Promise<string | null> {
    return organizationForDialledNumber(calledNumber, process.env.LOCAL_VOICE_ORGANIZATION_SLUG);
  }


  // ── Step 3: what happened ─────────────────────────────────────────────────

  outcomeOf(uuid: string): string {
    const o = this.outcomes.get(uuid);
    if (o) return o.outcome;
    // Registered but the audio never arrived: Asterisk could not connect, so
    // the caller has heard nothing yet — ElevenLabs should take it.
    if (this.pending.has(uuid)) return 'fallback';
    return 'unknown';
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.pending) if (now - v.at > REGISTRATION_TTL_MS) this.pending.delete(k);
    for (const [k, v] of this.outcomes) if (now - v.at > OUTCOME_TTL_MS) this.outcomes.delete(k);
  }

  // ── Step 2: the call ──────────────────────────────────────────────────────

  private accept(socket: net.Socket): void {
    socket.setNoDelay(true);
    const reader = new FrameReader();
    let session: VoiceSession | null = null;
    let uuid = '';
    let opening = false;
    let ulawLogged = false;
    const early: Buffer[] = [];

    const end = () => {
      if (session) session.callerHungUp();
      else if (uuid) this.outcomes.set(uuid, { outcome: 'fallback', at: Date.now() });
    };
    socket.on('close', end);
    socket.on('error', end);
    socket.on('data', (chunk) => {
      for (const frame of reader.push(chunk)) {
        if (frame.kind === KIND.UUID && !uuid) {
          uuid = uuidFromPayload(frame.payload);
          const reg = this.pending.get(uuid);
          this.pending.delete(uuid);
          if (!reg) {
            this.log.warn(`voice_local_unregistered uuid=${uuid}`);
            this.outcomes.set(uuid, { outcome: 'fallback', at: Date.now() });
            hangUp(socket);
            return;
          }
          opening = true;
          // The session is handed over as soon as it EXISTS, not when the
          // opening has been synthesised: until then the caller's audio was
          // kept for one second and the rest dropped, so a slow opening (a
          // cold speech cache, a slow provider) starved Deepgram, which closes
          // after ~10 s without audio (1011) — and the call failed over.
          void this.begin(reg, socket, (s) => {
            session = s;
            for (const f of early.splice(0)) s.onCallerAudio(f);
          })
            .catch((err) => {
              this.log.warn(`voice_local_setup_failed uuid=${uuid} error=${err?.message}`);
              this.outcomes.set(uuid, { outcome: 'fallback', at: Date.now() });
              hangUp(socket);
            });
        } else if (frame.kind === KIND.AUDIO) {
          // 160 bytes per 20 ms is G.711 µ-law, not the 16-bit linear the
          // voice line reads (320 bytes). It is what Asterisk sends when the
          // AudioSocket leg is dialled without c(slin): it takes the caller's
          // codec. Read as 16-bit it is noise, and recognition hears no words
          // at all, so it is converted rather than passed on.
          let audio = frame.payload;
          if (audio.length === FRAME_BYTES / 2) {
            if (!ulawLogged) {
              ulawLogged = true;
              this.log.warn(`voice_local_caller_ulaw uuid=${uuid} — the bridge sends µ-law; its dialplan should dial AudioSocket with c(slin)`);
            }
            audio = mulawBufferToSlin(audio);
          }
          if (session) session.onCallerAudio(audio);
          else if (opening && early.length < 50) early.push(audio);
        } else if (frame.kind === KIND.HANGUP) {
          end();
        } else if (frame.kind === KIND.ERROR) {
          this.log.warn(`voice_local_asterisk_error uuid=${uuid} code=${frame.payload.toString('hex')}`);
        }
      }
    });
  }

  async begin(reg: Registration, socket: net.Socket, onSession?: (s: VoiceSession) => void): Promise<VoiceSession> {
    const org = await prisma.organization.findUnique({
      where: { id: reg.organizationId },
      select: { name: true, slug: true, timezone: true, welcomeMessage: true, aiPersonaPrompt: true },
    });
    if (!org) throw new Error('organization not found');
    const agentOrg: AgentOrganization = org;

    // Who is calling, exactly as the ElevenLabs conversation-start webhook
    // answers it: the same caller status, profile and per-call assistant name.
    const start = await this.tools.conversationStart(reg.organizationId, {
      caller_id: reg.callerNumber,
      called_number: reg.calledNumber,
      conversation_id: `local-${reg.uuid}`,
    });
    const vars = start.dynamic_variables;
    const probeEngine = this.assistantEngine();
    const supportsDualGender = probeEngine?.name === 'spitch';
    const persona = isPlateauStateOrg(agentOrg)
      ? supportsDualGender
        ? pickPlateauPersona(assistantGenderFromEnv())
        : { ...pickPlateauMalePersona(), ...(vars.representative_name ? { name: vars.representative_name } : {}) }
      : resolvePersona(null);
    // Keep representative_name in sync with the chosen male/female persona so
    // the Governor's intro, the agent's self-intro, and the voice gender match.
    if (supportsDualGender && isPlateauStateOrg(agentOrg)) {
      vars.representative_name = persona.name;
    } else {
      vars.representative_name ||= persona.name;
    }
    vars.organization_name ||= org.name;
    const now = new Date();
    const systemPrompt = callSystemPrompt(agentOrg, persona, vars, now);
    const opening = callOpening(agentOrg, persona, vars, now, start.conversation_config_override?.agent.first_message);

    const speechEngine = this.assistantEngine(persona.gender);
    if (!speechEngine) throw new Error('speech is not configured');
    const assistantVoice = this.spoken(speechEngine);
    const governorVoice = await this.governorVoice(reg.organizationId);

    const callerNumber = reg.callerNumber;
    const conversationId = `local-${reg.uuid}`;
    const session = new VoiceSession(
      {
        sendAudio: (frame) => {
          if (!socket.destroyed) socket.write(encodeFrame(KIND.AUDIO, frame));
        },
        close: () => hangUp(socket),
        stt: this.stt,
        assistantVoice,
        governorVoice,
        llm: (m, t, s) => this.llm(m, t, s),
        warm: this.warmLlm,
        tools: localToolDefinitions({ contactCentre: isPlateauStateOrg(agentOrg) }),
        runTool: (name, args) => runLocalTool(this.tools, name, args, { organizationId: reg.organizationId, callerNumber, conversationId }),
        log: (event, detail) => this.log.log(`${event} uuid=${reg.uuid} ${detail ? JSON.stringify(detail) : ''}`),
      },
      { systemPrompt, opening, personal: [vars.sip_callername].filter(Boolean) as string[] },
    );
    this.live.add(session);
    void session.done.then(() => this.after(reg, session));
    onSession?.(session);
    await session.start();
    return session;
  }

  /**
   * The Governor's voice, for the `<governor>` part of the opening.
   * ALWAYS plays the 3 approved studio WAV recordings in
   * `data/voice-assets/governor/` (good-morning / good-afternoon / good-evening)
   * directly with zero AI synthesis. Only a test stub replacing `governorEngine`
   * bypasses them.
   */
  private async governorVoice(organizationId: string): Promise<CachedSpeech | null> {
    if (this.governorEngine === LocalVoiceService.defaultGovernorEngine) {
      const approved = StaticGovernorAudio.fromDisk();
      if (approved) {
        return new CachedSpeech(approved, null);
      }
    }

    const spitchKey = process.env.SPITCH_API_KEY?.trim();
    const spitchGovVoice = process.env.SPITCH_GOVERNOR_VOICE?.trim();
    if (spitchKey && spitchGovVoice) {
      return this.spoken(
        new SpitchTts({
          key: spitchKey,
          voice: spitchGovVoice,
          language: process.env.SPITCH_LANGUAGE?.trim() || 'en',
          // His own pace setting; unset, he speaks at the assistant's.
          speed: speedFromEnv('SPITCH_GOVERNOR_SPEED', speedFromEnv('SPITCH_SPEED')),
        }),
      );
    }

    const config = await prisma.hostedAgentConfig
      .findUnique({ where: { organizationId }, select: { apiKey: true } })
      .catch(() => null);
    // A clip already on disk needs no key at all; a missing key only means a
    // new wording falls back to the assistant's voice.
    // The same rule as ElevenLabsApi.keyFor: the agency's own workspace key,
    // else the shared key only where sharing is explicitly allowed.
    let key = '';
    try {
      if (config?.apiKey) key = decryptSecret(config.apiKey, `HostedAgentConfig.apiKey org=${organizationId}`);
      else if (process.env.ELEVENLABS_ALLOW_SHARED_WORKSPACE === '1') key = process.env.ELEVENLABS_API_KEY?.trim() || '';
    } catch {
      /* unreadable: cached clips only */
    }
    return this.spoken(this.governorEngine(key) as any);
  }

  private clipCheck: ClipCheck | null | undefined;
  /**
   * An engine in front of the cache, with every new clip HEARD before it is
   * kept (speech-check.ts): Spitch sometimes reads punctuation aloud, and a
   * clip on disk is replayed on every call after.
   */
  private spoken(engine: SpeechEngine & { voice?: string; voiceId?: string; rate?: string }): CachedSpeech {
    if (this.clipCheck === undefined) this.clipCheck = clipCheckFromEnv();
    return new CachedSpeech(engine, this.cache, this.clipCheck, (text, verdict) =>
      this.log.warn(
        `voice_local_clip_not_kept ${'extras' in verdict ? `said=${JSON.stringify(verdict.extras)}` : `unchecked=${JSON.stringify(verdict.error)}`} text=${JSON.stringify(text)}`,
      ),
    );
  }

  // ── After the call: the record, through the one ingestion path ───────────

  private async after(reg: Registration, session: VoiceSession): Promise<void> {
    this.live.delete(session);
    const outcome = session.outcome ?? 'completed';
    this.outcomes.set(reg.uuid, { outcome, at: Date.now() });
    // What reached us from the caller: tells "no audio from the line",
    // "audio but silent" and "voice but no words" apart (CallerHearing).
    const h = session.hearing;
    this.log.log(
      `voice_local_call_ended uuid=${reg.uuid} outcome=${outcome} secs=${Math.round((Date.now() - session.startedAt) / 1000)}` +
        ` caller_audio_secs=${h.audioSecs} caller_voice_secs=${h.voiceSecs} caller_peak=${h.peak} heard_interim=${h.interims} heard_final=${h.finals}` +
        (session.failure ? ` failure=${JSON.stringify(session.failure)}` : ''),
    );
    try {
      await this.record(reg, session);
    } catch (err: any) {
      this.log.error(`voice_local_record_failed uuid=${reg.uuid} error=${err?.message}`);
    }
  }

  async record(reg: Registration, session: VoiceSession): Promise<void> {
    const durationSecs = Math.round((Date.now() - session.startedAt) / 1000);
    const conversationId = `local-${reg.uuid}`;
    const handedOver = session.outcome === 'fallback';
    const summary = handedOver
      ? `Started on the platform's own voice line and handed to the backup voice agent (${session.failure ?? 'provider failure'}).`
      : await this.summarise(session).catch(() => null);

    const payload: PostCallPayload = {
      type: 'post_call_transcription',
      data: {
        agent_id: 'local-voice',
        conversation_id: conversationId,
        status: 'done',
        has_audio: false,
        transcript: session.transcript.map((t) => ({
          role: t.role,
          message: t.message || null,
          time_in_call_secs: t.atSecs,
          ...(t.toolCalls?.length ? { tool_calls: t.toolCalls.map((c) => ({ tool_name: c.name, params_as_json: c.arguments })) } : {}),
        })),
        metadata: {
          start_time_unix_secs: Math.floor(session.startedAt / 1000),
          call_duration_secs: durationSecs,
          termination_reason: handedOver ? 'handed to backup voice agent' : session.outcome ?? 'completed',
          phone_call: {
            type: 'sip_trunking',
            direction: 'inbound',
            call_sid: conversationId,
            agent_number: reg.calledNumber,
            external_number: reg.callerNumber,
          },
        },
        analysis: summary ? { transcript_summary: summary } : undefined,
      },
    } as PostCallPayload;

    const outcome = await this.ingestion.ingestForOrganization(reg.organizationId, payload, `local:${reg.uuid}`);
    if (!outcome.handled) {
      this.log.warn(`voice_local_not_recorded uuid=${reg.uuid} reason=${(outcome as any).reason}`);
      return;
    }

    // The audio: ours, so it is kept in our own storage.
    if (session.recorder.frames > 0 && storageDriver() !== 'none') {
      const stored = await uploadObject(CALL_RECORDING_BUCKET, reg.organizationId, `${reg.uuid}.wav`, session.recorder.toWav(), 'audio/wav');
      await prisma.callLog.update({ where: { callSid: conversationId }, data: { recordingUrl: localRecordingRef(stored) } });
    }
  }

  /** One sentence for the call list, as ElevenLabs' analysis gives. Best effort. */
  private async summarise(session: VoiceSession): Promise<string | null> {
    const req = callSummaryRequest(session.transcript);
    if ('fixed' in req) return req.fixed;
    if (!llmConfig().apiKey) return null;
    const res = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${llmConfig().apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llmConfig().chatModel, temperature: 0, max_tokens: 160, messages: req.messages }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  }


  /** For the readiness screen and tests. */
  liveCalls(): number {
    return this.live.size;
  }
}

/** Said of a call in which nothing the caller said was heard. */
export const NO_CALLER_SPEECH_SUMMARY = 'No caller speech was received on this call, so nothing was reported or done.';

/**
 * What the call list's one-line summary is made from. A call of 27 Nov had no
 * caller words at all (their audio never reached the line) and its summary
 * read "The caller inquired about … a government grant … reference number
 * 123456 … under review": the model invented a conversation from the
 * assistant's lines alone. With no caller words there is nothing to
 * summarise, so the record says so plainly; otherwise the model is told to
 * use only what the transcript says.
 */
export function callSummaryRequest(
  transcript: Array<{ role: string; message: string }>,
): { fixed: string } | { messages: Array<{ role: 'system' | 'user'; content: string }> } {
  const turns = transcript.filter((t) => t.message?.trim());
  if (!turns.some((t) => t.role === 'user')) return { fixed: NO_CALLER_SPEECH_SUMMARY };
  const text = turns
    .map((t) => `${t.role === 'user' ? 'Caller' : 'Assistant'}: ${t.message}`)
    .join('\n')
    .slice(0, 12_000);
  return {
    messages: [
      {
        role: 'system',
        content:
          'Summarise this government contact-centre call in two sentences for an officer: what the caller wanted and what was done (reference numbers included). ' +
          'Use ONLY what the transcript says. Never add a request, reference number, status, date or outcome that is not in it; ' +
          'if the caller\'s request is unclear or the call ended before anything was done, say exactly that. No names of the caller.',
      },
      { role: 'user', content: text },
    ],
  };
}
