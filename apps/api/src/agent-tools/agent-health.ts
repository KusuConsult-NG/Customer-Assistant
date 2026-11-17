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
  total: number;
  normal: number;
  abnormal: number;
  unknown: number;
  /** abnormal / total, or null when there were no calls. */
  abnormalRate: number | null;
  /** True when enough calls ended abnormally that someone should look. */
  alert: boolean;
  /** Every reason seen, most frequent first, so nothing hides behind a category. */
  reasons: { reason: string; kind: EndingKind; count: number }[];
}

/** Below this many calls one bad ending is noise, not a pattern. */
export const CALL_HEALTH_MIN_CALLS = 5;
/** Share of abnormal endings at which the dashboard raises the alarm. */
export const CALL_HEALTH_ALERT_RATE = 0.1;

export function summariseCallHealth(
  conversations: { terminationReason?: string | null; status?: string | null }[],
  windowHours: number
): CallHealth {
  const tally = new Map<string, { kind: EndingKind; count: number }>();
  let normal = 0;
  let abnormal = 0;
  let unknown = 0;
  for (const c of conversations) {
    const kind = classifyEnding(c.terminationReason, c.status);
    if (kind === 'normal') normal++;
    else if (kind === 'abnormal') abnormal++;
    else unknown++;
    const reason = (c.terminationReason ?? '').trim() || (c.status ? `(no reason; status ${c.status})` : '(no reason given)');
    const t = tally.get(reason) ?? { kind, count: 0 };
    t.count++;
    tally.set(reason, t);
  }
  const total = conversations.length;
  const abnormalRate = total ? abnormal / total : null;
  return {
    windowHours,
    total,
    normal,
    abnormal,
    unknown,
    abnormalRate,
    alert: total >= CALL_HEALTH_MIN_CALLS && abnormalRate !== null && abnormalRate >= CALL_HEALTH_ALERT_RATE,
    reasons: [...tally.entries()]
      .map(([reason, t]) => ({ reason, kind: t.kind, count: t.count }))
      .sort((a, b) => b.count - a.count),
  };
}
