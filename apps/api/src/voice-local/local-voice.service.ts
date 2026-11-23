import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'crypto';
import * as net from 'net';
import * as path from 'path';
import { prisma, phoneNumberVariants } from '@ace/database';
import { chatCompletionsUrl, llmConfig } from '@ace/orchestrator';
import {
  agentPromptFor,
  firstMessageFor,
  isPlateauStateOrg,
  pickPlateauMalePersona,
  resolvePersona,
  type AgentOrganization,
} from '../agent-tools/agent-tool-catalog';
import { AgentToolsService } from '../agent-tools/agent-tools.service';
import { ElevenLabsApi } from '../agent-tools/elevenlabs-client';
import { ElevenLabsWebhookService, type PostCallPayload } from '../agent-tools/elevenlabs-webhook.service';
import {
  GOVERNOR_VOICE_ID,
  VOICE_MODEL_ID,
  VOICE_SETTINGS,
} from '../agent-tools/elevenlabs-contracts';
import { localRecordingRef } from '../common/call-recording';
import { CALL_RECORDING_BUCKET, storageDriver, uploadObject } from '../common/object-storage';
import { FrameReader, KIND, encodeFrame, uuidFromPayload } from './audiosocket';
import { streamChat } from './llm';
import { deepgramStt, type SttFactory } from './stt';
import { AzureTts, CachedSpeech, ElevenLabsTts, type SpeechEngine } from './tts';
import { TtsCache } from './tts-cache';
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
  assistantEngine: () => SpeechEngine | null = () => AzureTts.fromEnv();
  governorEngine = (key: string): SpeechEngine => new ElevenLabsTts(key, GOVERNOR_VOICE_ID, VOICE_MODEL_ID, VOICE_SETTINGS);

  constructor(
    private readonly tools: AgentToolsService,
    private readonly ingestion: ElevenLabsWebhookService,
    private readonly elevenlabs: ElevenLabsApi,
  ) {}

  // ── Configuration ─────────────────────────────────────────────────────────

  static enabled(): boolean {
    return process.env.LOCAL_VOICE_PIPELINE === '1';
  }

  readiness(): Readiness {
    const missing: string[] = [];
    if (!process.env.LOCAL_VOICE_SECRET?.trim()) missing.push('LOCAL_VOICE_SECRET');
    if (!process.env.DEEPGRAM_API_KEY?.trim()) missing.push('DEEPGRAM_API_KEY');
    if (!this.assistantEngine()) missing.push('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION');
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

  listen(port = Number(process.env.AUDIOSOCKET_PORT || 9092), host = '127.0.0.1'): Promise<number> {
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
    const variants = phoneNumberVariants(calledNumber);
    if (variants.length) {
      const lines = await prisma.telephonyConfig.findMany({
        where: { phoneNumber: { in: variants } },
        select: { organizationId: true },
        take: 2,
      });
      const orgs = [...new Set(lines.map((l) => l.organizationId))];
      if (orgs.length === 1) return orgs[0];
      if (orgs.length > 1) return null; // two agencies claim one number: refuse to guess
    }
    const slug = process.env.LOCAL_VOICE_ORGANIZATION_SLUG?.trim();
    if (!slug) return null;
    const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    return org?.id ?? null;
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
          void this.begin(reg, socket)
            .then((s) => {
              session = s;
              for (const f of early.splice(0)) s.onCallerAudio(f);
            })
            .catch((err) => {
              this.log.warn(`voice_local_setup_failed uuid=${uuid} error=${err?.message}`);
              this.outcomes.set(uuid, { outcome: 'fallback', at: Date.now() });
              hangUp(socket);
            });
        } else if (frame.kind === KIND.AUDIO) {
          if (session) session.onCallerAudio(frame.payload);
          else if (opening && early.length < 50) early.push(frame.payload);
        } else if (frame.kind === KIND.HANGUP) {
          end();
        } else if (frame.kind === KIND.ERROR) {
          this.log.warn(`voice_local_asterisk_error uuid=${uuid} code=${frame.payload.toString('hex')}`);
        }
      }
    });
  }

  async begin(reg: Registration, socket: net.Socket): Promise<VoiceSession> {
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
    const persona = isPlateauStateOrg(agentOrg)
      ? { ...pickPlateauMalePersona(), ...(vars.representative_name ? { name: vars.representative_name } : {}) }
      : resolvePersona(null);
    vars.representative_name ||= persona.name;
    vars.organization_name ||= org.name;
    const fill = (t: string) => t.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, k) => vars[k] ?? '');

    const now = new Date();
    const systemPrompt =
      fill(agentPromptFor(agentOrg, persona)) +
      `\n\n## This call\n\nIt is now ${now.toLocaleString('en-GB', { timeZone: org.timezone || 'Africa/Lagos', dateStyle: 'full', timeStyle: 'short' })} at the agency.` +
      ` Caller status: ${vars.caller_status || 'unknown'}.` +
      `\nYou are speaking on a telephone line. Speak in short spoken sentences; never use lists, headings or symbols.`;
    const opening = fill(start.conversation_config_override?.agent.first_message ?? firstMessageFor(agentOrg, persona));

    const azure = this.assistantEngine();
    if (!azure) throw new Error('speech is not configured');
    const assistantVoice = new CachedSpeech(azure, this.cache);
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
        tools: localToolDefinitions(),
        runTool: (name, args) => runLocalTool(this.tools, name, args, { organizationId: reg.organizationId, callerNumber, conversationId }),
        log: (event, detail) => this.log.log(`${event} uuid=${reg.uuid} ${detail ? JSON.stringify(detail) : ''}`),
      },
      { systemPrompt, opening, personal: [vars.caller_name].filter(Boolean) as string[] },
    );
    this.live.add(session);
    void session.done.then(() => this.after(reg, session));
    await session.start();
    return session;
  }

  /**
   * The Governor's cloned voice, for the `<governor>` part of the opening.
   * Uses whatever already-rendered clip is on disk first (CachedSpeech), so
   * once `npm run voice:prerender` has run, no ElevenLabs key is needed.
   */
  private async governorVoice(organizationId: string): Promise<CachedSpeech | null> {
    const config = await prisma.hostedAgentConfig
      .findUnique({ where: { organizationId }, select: { apiKey: true } })
      .catch(() => null);
    // A clip already on disk needs no key at all; a missing key only means a
    // new wording falls back to the assistant's voice.
    let key = '';
    try {
      key = this.elevenlabs.keyFor(organizationId, config?.apiKey ?? null);
    } catch {
      /* no workspace: cached clips only */
    }
    return new CachedSpeech(this.governorEngine(key) as any, this.cache);
  }

  // ── After the call: the record, through the one ingestion path ───────────

  private async after(reg: Registration, session: VoiceSession): Promise<void> {
    this.live.delete(session);
    const outcome = session.outcome ?? 'completed';
    this.outcomes.set(reg.uuid, { outcome, at: Date.now() });
    this.log.log(
      `voice_local_call_ended uuid=${reg.uuid} outcome=${outcome} secs=${Math.round((Date.now() - session.startedAt) / 1000)}` +
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
    const text = session.transcript
      .filter((t) => t.message)
      .map((t) => `${t.role === 'user' ? 'Caller' : 'Assistant'}: ${t.message}`)
      .join('\n')
      .slice(0, 12_000);
    if (!text || !llmConfig().apiKey) return null;
    const res = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${llmConfig().apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: llmConfig().chatModel,
        temperature: 0,
        max_tokens: 160,
        messages: [
          { role: 'system', content: 'Summarise this government contact-centre call in two sentences for an officer: what the caller wanted and what was done (reference numbers included). No names of the caller.' },
          { role: 'user', content: text },
        ],
      }),
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
