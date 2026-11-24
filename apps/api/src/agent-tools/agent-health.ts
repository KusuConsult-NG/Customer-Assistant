/**
 * Two questions about the LIVE phone agent that nothing used to ask.
 *
 * 1. Does it still carry the settings this platform expects?
 *    A sync can be refused (ElevenLabs rejected one over a stale Hausa preset)
 *    and the agent keeps answering with whatever it had before. Every fix in
 *    that window — slower voices, a longer silence timeout — looked shipped and
 *    was not. `liveSettingsDrift` compares what the agent actually holds with
 *    what a sync would write, field by field, so "the sync did not take" is a
 *    line on a screen instead of something a caller discovers.
 *
 * 2. How are calls ending?
 *    A 10-second silence timeout hung up on callers in the middle of the agent's
 *    own sentences, and the first anyone knew was a person hearing it. ElevenLabs
 *    records why every conversation ended; `summariseCallHealth` counts those
 *    reasons so a spike in abnormal endings is visible on the first morning.
 *
 * Both are pure so they are tested without a workspace.
 */

/** One way the live agent disagrees with what a sync would write. */
export interface SettingDrift {
  setting: string;
  live: string;
  expected: string;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const show = (v: unknown): string => (v === undefined || v === null || v === '' ? '(not set)' : String(v));
const sameNumber = (a: number | undefined, b: number | undefined) =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) < 1e-6;
/** ElevenLabs may normalise line endings or trailing space; content is what matters. */
const normaliseText = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/**
 * Compare the settings callers actually hear.
 *
 * `live` is the agent as `agents.get` returns it (camelCase, from the SDK);
 * `expected` is `agentDefinitionFor(...)`'s output. Deliberately NOT compared:
 * the first message and the dynamic-variable defaults, because the Plateau name
 * rotation rewrites both on the live agent between calls — comparing them would
 * report drift after every call and teach everyone to ignore the list.
 */
export function liveSettingsDrift(live: any, expected: any): SettingDrift[] {
  const out: SettingDrift[] = [];
  const lc = live?.conversationConfig ?? {};
  const ec = expected?.conversationConfig ?? {};
  const add = (setting: string, l: unknown, e: unknown) =>
    out.push({ setting, live: show(l), expected: show(e) });

  // ── Voice ──────────────────────────────────────────────────────────────────
  const lt = lc.tts ?? {};
  const et = ec.tts ?? {};
  if (et.modelId && lt.modelId !== et.modelId) add('Voice model', lt.modelId, et.modelId);
  if (et.voiceId && lt.voiceId !== et.voiceId) add('Assistant voice', lt.voiceId, et.voiceId);
  for (const [key, label] of [
    ['speed', 'Speaking speed'],
    ['stability', 'Voice stability'],
    ['similarityBoost', 'Voice similarity'],
  ] as const) {
    const e = num(et[key]);
    if (e !== undefined && !sameNumber(num(lt[key]), e)) add(label, lt[key], e);
  }
  const voices = (list: any): string =>
    (Array.isArray(list) ? list : [])
      .map((v: any) => `${v?.label ?? '?'}=${v?.voiceId ?? '?'}`)
      .sort()
      .join(', ');
  if (Array.isArray(et.supportedVoices) && voices(lt.supportedVoices) !== voices(et.supportedVoices)) {
    add('Additional voices', voices(lt.supportedVoices) || '(none)', voices(et.supportedVoices) || '(none)');
  }
  // The Governor's speed lives on his own voice entry, not the top-level tts.
  const govLive = (Array.isArray(lt.supportedVoices) ? lt.supportedVoices : []).find((v: any) => v?.label === 'governor');
  const govExp = (Array.isArray(et.supportedVoices) ? et.supportedVoices : []).find((v: any) => v?.label === 'governor');
  if (govLive && govExp && !sameNumber(num(govLive.speed), num(govExp.speed))) {
    add('Governor speaking speed', govLive.speed, govExp.speed);
  }

  // ── Turn-taking: the setting that hung up on callers mid-sentence ─────────
  const lturn = lc.turn ?? {};
  const eturn = ec.turn ?? {};
  for (const [key, label] of [
    ['silenceEndCallTimeout', 'Hang-up after caller silence (seconds)'],
    ['turnTimeout', 'Wait for caller reply (seconds)'],
  ] as const) {
    const e = num(eturn[key]);
    if (e !== undefined && !sameNumber(num(lturn[key]), e)) add(label, lturn[key], e);
  }
  // Noisy-line handling (elevenlabs-contracts.ts): without these, a caller
  // shouting over a generator is asked whether they are still there.
  if (typeof eturn.retranscribeOnTurnTimeout === 'boolean' && Boolean(lturn.retranscribeOnTurnTimeout) !== eturn.retranscribeOnTurnTimeout) {
    add('Re-listen when speech was missed (noisy lines)', lturn.retranscribeOnTurnTimeout ? 'on' : 'off', eturn.retranscribeOnTurnTimeout ? 'on' : 'off');
  }
  if (eturn.spellingPatience && lturn.spellingPatience !== eturn.spellingPatience) {
    add('Patience while spelling', lturn.spellingPatience ?? '(unset)', eturn.spellingPatience);
  }
  const emax = num(ec.conversation?.maxDurationSeconds);
  if (emax !== undefined && !sameNumber(num(lc.conversation?.maxDurationSeconds), emax)) {
    add('Maximum call length (seconds)', lc.conversation?.maxDurationSeconds, emax);
  }

  // ── Language ───────────────────────────────────────────────────────────────
  const ea = ec.agent ?? {};
  const la = lc.agent ?? {};
  if (ea.language && la.language !== ea.language) add('Language', la.language, ea.language);
  const presets = Object.keys(lc.languagePresets ?? {});
  if (ec.languagePresets && Object.keys(ec.languagePresets).length === 0 && presets.length > 0) {
    add('Other languages offered', presets.join(', '), '(none)');
  }

  // ── What the agent is told ─────────────────────────────────────────────────
  if (ea.prompt?.prompt && normaliseText(la.prompt?.prompt) !== normaliseText(ea.prompt.prompt)) {
    add('Instructions (system prompt)', 'differs from this platform', 'current version');
  }

  // ── The conversation-start webhook ("all circuits are busy" when on) ───────
  const ew = expected?.platformSettings?.overrides?.enableConversationInitiationClientDataFromWebhook;
  if (typeof ew === 'boolean') {
    const lw = live?.platformSettings?.overrides?.enableConversationInitiationClientDataFromWebhook;
    if (Boolean(lw) !== ew) add('Caller lookup before greeting', lw ? 'on' : 'off', ew ? 'on' : 'off');
  }

  return out;
}

/** A line for the existing drift list, with the remedy. */
export function describeSettingDrift(d: SettingDrift): string {
  return `${d.setting} on the live agent is ${d.live}; this platform expects ${d.expected}. Run Sync configuration — if this is still listed afterwards, the sync was refused.`;
}

// ── How calls end ────────────────────────────────────────────────────────────

export type EndingKind = 'normal' | 'abnormal' | 'unknown';

/**
 * Classify ElevenLabs' termination reason.
 *
 * The reason is free text and its exact wording is not documented, so the raw
 * reason is ALWAYS reported alongside, and anything unrecognised is `unknown`
 * rather than quietly counted as fine.
 */
export function classifyEnding(reason: string | undefined | null, status?: string | null): EndingKind {
  if (status && /fail/i.test(status)) return 'abnormal';
  const r = (reason ?? '').toLowerCase();
  if (!r) return 'unknown';
  if (/silence|inactiv|time ?out|timed out|max(imum)?[ _]?duration|error|fail|exception|crash|internal/.test(r)) {
    return 'abnormal';
  }
  if (/end_call|end call|remote party|client disconnected|hung up|hang ?up|caller ended|user ended|call ended by|completed/.test(r)) {
    return 'normal';
  }
  return 'unknown';
}

export interface CallHealth {
  windowHours: number;
  /**
   * Calls left out of every count below because they ended under a setting
   * that has since been corrected on the live agent (see `endedUnderOldSetting`).
   */
  superseded: number;
  total: number;
  normal: number;
  abnormal: number;
  unknown: number;
  /** abnormal / total, or null when there were no calls. */
  abnormalRate: number | null;
  /** True when enough calls ended abnormally that someone should look. */
  alert: boolean;
  /** Every reason seen, most frequent first, so nothing hides behind a category. */
  reasons: {
    reason: string;
    kind: EndingKind;
    count: number;
    /** When this ending was last seen (ISO), so an old problem can be told from a new one. */
    lastAt?: string | null;
    /**
     * For an ending that is NOT normal: the most recent calls that ended this
     * way, enough to open each in ElevenLabs' Call History and read why. "Failed,
     * no reason" was otherwise impossible to trace from here. Never a caller, a
     * number or a transcript.
     */
    calls?: EndedCall[];
  }[];
}

/** One call's identity, never its content. */
export interface EndedCall {
  conversationId: string;
  at: string | null;
  direction: 'inbound' | 'outbound' | null;
  durationSecs: number | null;
}

/** How many calls are listed under one abnormal reason. */
export const CALLS_LISTED_PER_REASON = 5;

export interface ConversationEnding {
  terminationReason?: string | null;
  status?: string | null;
  conversationId?: string | null;
  startTimeUnixSecs?: number | null;
  direction?: string | null;
  callDurationSecs?: number | null;
}

/** Below this many calls one bad ending is noise, not a pattern. */
export const CALL_HEALTH_MIN_CALLS = 5;
/** Share of abnormal endings at which the dashboard raises the alarm. */
export const CALL_HEALTH_ALERT_RATE = 0.1;

/**
 * Whether a call ended on a silence timeout OTHER than the one the live agent
 * has now. ElevenLabs writes the timeout in force into the reason ("Ending
 * conversation after 10 seconds of silence"), so a call cut off by the old
 * 10-second setting says so — and once the live agent is confirmed on the
 * current value, that ending describes a problem already fixed, not one
 * callers still meet. Reporting it for a day after the fix taught officers
 * the list was stale.
 *
 * `liveSilenceSeconds` must be what the LIVE agent holds, read from
 * ElevenLabs, never what this platform expects: if a sync was refused and the
 * agent is still on 10, those endings are current and must stay counted.
 */
export function endedUnderOldSetting(reason: string | null | undefined, liveSilenceSeconds: number | null): boolean {
  if (liveSilenceSeconds === null) return false;
  const m = /after\s+(\d+(?:\.\d+)?)\s*seconds?\s+of\s+silence/i.exec(reason ?? '');
  return !!m && Number(m[1]) !== liveSilenceSeconds;
}

export function summariseCallHealth(
  conversations: ConversationEnding[],
  windowHours: number,
  options: { liveSilenceSeconds?: number | null } = {}
): CallHealth {
  const tally = new Map<string, { kind: EndingKind; count: number; last: number; calls: EndedCall[] }>();
  let normal = 0;
  let abnormal = 0;
  let unknown = 0;
  let superseded = 0;
  const current = conversations.filter((c) => {
    if (endedUnderOldSetting(c.terminationReason, options.liveSilenceSeconds ?? null)) {
      superseded++;
      return false;
    }
    return true;
  });
  for (const c of current) {
    const kind = classifyEnding(c.terminationReason, c.status);
    if (kind === 'normal') normal++;
    else if (kind === 'abnormal') abnormal++;
    else unknown++;
    const reason = (c.terminationReason ?? '').trim() || (c.status ? `(no reason; status ${c.status})` : '(no reason given)');
    const t = tally.get(reason) ?? { kind, count: 0, last: 0, calls: [] };
    t.count++;
    const startedAt = Number(c.startTimeUnixSecs) > 0 ? Number(c.startTimeUnixSecs) : 0;
    t.last = Math.max(t.last, startedAt);
    if (kind !== 'normal' && c.conversationId) {
      t.calls.push({
        conversationId: c.conversationId,
        at: startedAt ? new Date(startedAt * 1000).toISOString() : null,
        direction: c.direction === 'inbound' || c.direction === 'outbound' ? c.direction : null,
        durationSecs: Number.isFinite(Number(c.callDurationSecs)) && c.callDurationSecs !== null ? Number(c.callDurationSecs) : null,
      });
    }
    tally.set(reason, t);
  }
  const total = current.length;
  const abnormalRate = total ? abnormal / total : null;
  return {
    windowHours,
    superseded,
    total,
    normal,
    abnormal,
    unknown,
    abnormalRate,
    alert: total >= CALL_HEALTH_MIN_CALLS && abnormalRate !== null && abnormalRate >= CALL_HEALTH_ALERT_RATE,
    reasons: [...tally.entries()]
      .map(([reason, t]) => ({
        reason,
        kind: t.kind,
        count: t.count,
        lastAt: t.last ? new Date(t.last * 1000).toISOString() : null,
        ...(t.kind === 'normal'
          ? {}
          : {
              calls: t.calls
                .sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
                .slice(0, CALLS_LISTED_PER_REASON),
            }),
      }))
      .sort((a, b) => b.count - a.count),
  };
}

// ── Whether returning callers are recognised ─────────────────────────────────

/**
 * The SIP bridge asks /api/sip-bridge/caller who is calling and sends the
 * answer as X- headers, which ElevenLabs keeps on the conversation as
 * `sip_callerstatus` etc. A call that arrived WITHOUT them was greeted as a
 * stranger whoever it was: the bridge gave up (the API asleep or slow), the two
 * copies of SIP_BRIDGE_SECRET no longer match, or the bridge was rebuilt
 * without them. Nothing fails when that happens — the caller just hears "How
 * may I help you today?" — so it is counted here rather than heard about.
 */
export interface CallerRecognition {
  /** The lookup is switched on for this agency (bridge secret set, SIP line held). */
  expected: boolean;
  /** Inbound SIP calls counted: those since the first one the lookup answered, when there is one. */
  inboundCalls: number;
  /** Of those, how many arrived with the lookup's answer. */
  lookedUp: number;
  missed: number;
  /** missed / inboundCalls, or null with no calls. */
  missedRate: number | null;
  /** The most recent call that arrived with the answer (ISO), so "since when" can be read. */
  lastLookedUpAt: string | null;
  /** The most recent calls that arrived without it. Identity only, never content. */
  recentMisses: EndedCall[];
  alert: boolean;
}

/** Fewer calls than this and one slow wake-up is noise, not a pattern. */
export const RECOGNITION_MIN_CALLS = 3;
/** Share of calls arriving without the lookup at which the dashboard says so. */
export const RECOGNITION_ALERT_RATE = 0.2;

export interface InboundCall {
  conversationId?: string | null;
  startTimeUnixSecs?: number | null;
  direction?: string | null;
  callDurationSecs?: number | null;
  source?: string | null;
}

/**
 * `calls` is every ended call in the window; `lookedUpIds` the ones ElevenLabs
 * holds a `sip_callerstatus` for. Only INBOUND SIP-trunk calls are counted:
 * the bridge looks up callers, not the callbacks we place.
 *
 * Calls before the first answered lookup in the window are left out, so the
 * day the lookup was switched on does not read as a day of misses. With NO
 * answered lookup at all, every inbound call counts: that is the case where
 * it has stopped entirely.
 */
export function summariseRecognition(calls: InboundCall[], lookedUpIds: Set<string>, expected: boolean): CallerRecognition {
  const inbound = calls.filter((c) => c.direction === 'inbound' && c.source === 'sip_trunk' && c.conversationId);
  const at = (c: InboundCall) => (Number(c.startTimeUnixSecs) > 0 ? Number(c.startTimeUnixSecs) : 0);
  const answered = inbound.filter((c) => lookedUpIds.has(c.conversationId as string));
  const first = answered.length ? Math.min(...answered.map(at)) : null;
  const considered = first === null ? inbound : inbound.filter((c) => at(c) >= first);
  const misses = considered.filter((c) => !lookedUpIds.has(c.conversationId as string));
  const last = answered.length ? Math.max(...answered.map(at)) : 0;
  const total = considered.length;
  const missedRate = total ? misses.length / total : null;
  return {
    expected,
    inboundCalls: total,
    lookedUp: total - misses.length,
    missed: misses.length,
    missedRate,
    lastLookedUpAt: last ? new Date(last * 1000).toISOString() : null,
    recentMisses: misses
      .sort((a, b) => at(b) - at(a))
      .slice(0, CALLS_LISTED_PER_REASON)
      .map((c) => ({
        conversationId: c.conversationId as string,
        at: at(c) ? new Date(at(c) * 1000).toISOString() : null,
        direction: 'inbound' as const,
        durationSecs: Number.isFinite(Number(c.callDurationSecs)) && c.callDurationSecs !== null ? Number(c.callDurationSecs) : null,
      })),
    alert: expected && total >= RECOGNITION_MIN_CALLS && missedRate !== null && missedRate >= RECOGNITION_ALERT_RATE,
  };
}
