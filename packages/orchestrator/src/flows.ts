/**
 * Multi-turn conversations: asking for one thing at a time and remembering the answers.
 *
 * ── The gap this closes ─────────────────────────────────────────────────────
 *
 * Until now every message was answered in isolation. `ConversationContext.slots`
 * was declared in the types and passed as `{}` on every call; nothing read it
 * and nothing persisted it. That single fact is what made the assistant feel
 * mechanical rather than capable — it could not collect a form, could not
 * confirm before writing, could not accept a correction, and could not ask
 * "what time suits you?", because by the customer's next message it had
 * forgotten it had asked. Rescheduling silently defaulted to "tomorrow, 10am"
 * with a `TODO (multi-turn)` beside it for exactly this reason.
 *
 * ── The shape ───────────────────────────────────────────────────────────────
 *
 * A FLOW is an ordered list of SLOTS plus something to do once they are all
 * filled. The engine's whole job is: work out which slot this message answers,
 * validate it, store it, and ask for the next one — or, when nothing is left,
 * read the answers back and ask the customer to confirm before anything is
 * written. State lives on `Conversation.flowState`, so it survives the gap
 * between two WhatsApp messages and is visible to staff reading the row.
 *
 * ── The rules that keep it from becoming a trap ─────────────────────────────
 *
 * A form a customer cannot escape is worse than no form:
 *
 *   - "cancel", "stop", "forget it" abandons at any point, in any language.
 *   - asking for a human ALWAYS wins, mid-flow or not — that check runs before
 *     this engine is consulted at all.
 *   - a flow goes stale. Somebody who answered two questions and put their
 *     phone down does not want question three next Tuesday; after
 *     FLOW_TTL_MS the flow is dropped and the message is treated fresh.
 *   - a slot can be corrected after the fact ("no, Jos North"), because people
 *     do not answer forms in order and being told "that is not what I asked
 *     for" is the most machine-like thing a system can say.
 *   - NOTHING is written until the customer confirms the read-back. That is
 *     invariant 1 applied to a form: the record is asserted only once it is
 *     real, and the customer has seen exactly what it will say.
 */
import { Language, t } from './languages';

/** After this long without a reply, a part-finished flow is forgotten. */
export const FLOW_TTL_MS = 60 * 60 * 1000;

export interface SlotDefinition {
  name: string;
  /** What to ask when this slot is the next one missing. */
  prompt: (collected: Record<string, string>) => string;
  /**
   * Turn what the customer said into the value to store, or return a reason it
   * cannot be accepted. Returning `{ error }` re-asks WITH the reason, which is
   * the difference between "sorry, try again" and "that hospital is not on the
   * accredited list for Jos North — here are the ones that are".
   */
  accept: (
    text: string,
    collected: Record<string, string>
  ) => { value: string } | { error: string };
  /** Optional: skip this slot entirely given what is already collected. */
  skipIf?: (collected: Record<string, string>) => boolean;
  /** Optional: a customer may decline this one ("no NIN"). */
  optional?: boolean;
  /**
   * Names the customer might call this field — "my NAME is Musa", "wrong LGA".
   * Used only for corrections, and the strongest signal available: it says which
   * field to rewrite instead of leaving the engine to guess.
   */
  aliases?: string[];
  /**
   * True when this text could only be a value for THIS slot — an accredited
   * facility name, a real LGA, eleven digits. See `findCorrection` for why an
   * unidentifiable correction is refused rather than applied to a guess.
   */
  identifies?: (text: string, collected: Record<string, string>) => boolean;
}

export interface FlowDefinition {
  name: string;
  slots: SlotDefinition[];
  /** Read-back shown before anything is written. */
  summarise: (collected: Record<string, string>) => string;
}

export interface FlowState {
  flow: string;
  collected: Record<string, string>;
  /** The slot the last question was about — what this message is answering. */
  awaiting: string | null;
  /** True once the read-back has been sent and we are waiting on yes/no. */
  confirming?: boolean;
  startedAt: number;
  updatedAt: number;
}

/**
 * A word boundary that survives Nigerian orthography.
 *
 * `\b` is defined against `[A-Za-z0-9_]`, so in `/\bkwụsị\b/` the trailing
 * boundary sits between `ị` and the end of the string — two non-word characters
 * as far as the engine is concerned, therefore no boundary, therefore no match.
 * The word is spelled correctly and the regex is wrong. Every Igbo and Yoruba
 * abandon word was silently dead for exactly this reason: a customer could type
 * "kwụsị" and the form would keep asking questions.
 */
function word(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, 'iu');
}

/** Words that abandon a flow, across the five supported languages. */
const ABANDON = [
  'cancel', 'stop', 'forget it', 'never ?mind', 'quit', 'leave it', 'not now',
  'make i stop', 'no ?vex',                     // Pidgin
  'ka daina', 'a bar shi',                      // Hausa
  'kw[uụ]s[iị]', 'hap[uụ]',                     // Igbo
  'dur[oó]', 'fi s[ií]l[eẹ]',                   // Yoruba
].map(word);

const AFFIRM = [
  /^\s*(yes|yeah|yep|correct|confirm|ok(ay)?|sure|proceed|go ahead|y)\s*[.!]?\s*$/i,
  /^\s*(eh?en|na so|e correct|abi)\s*[.!]?\s*$/i,          // Pidgin
  /^\s*(i|ii|to|na'?am|haka ne)\s*[.!]?\s*$/i,             // Hausa
  /^\s*(ee|eeh|[oọ] d[iị] mma)\s*[.!]?\s*$/i,              // Igbo
  /^\s*(b[eẹ][eẹ]ni|[oó] da)\s*[.!]?\s*$/i,                // Yoruba
];

const NEGATE = [
  /^\s*(no|nope|nah|wrong|incorrect|n)\s*[.!]?\s*$/i,
  /^\s*(a'?a|babu)\s*[.!]?\s*$/i,                          // Hausa
  /^\s*(mba)\s*[.!]?\s*$/i,                                // Igbo
  /^\s*(r[aá]ra|beeko)\s*[.!]?\s*$/i,                      // Yoruba
];

const DECLINE = [
  'no', 'none', 'skip', "don'?t have", 'do not have', "i don'?t", 'nothing', 'later',
  'ba ni da', 'enwegh[iị] m', 'n k[oò] n[ií]', 'i no get',
].map(word);

export const wantsToAbandon = (text: string) => ABANDON.some((r) => r.test(text ?? ''));
export const isAffirmation = (text: string) => AFFIRM.some((r) => r.test(text ?? ''));
export const isNegation = (text: string) => NEGATE.some((r) => r.test(text ?? ''));
export const isDecline = (text: string) => DECLINE.some((r) => r.test(text ?? ''));

/** A flow older than the TTL is not resumed — see the staleness rule above. */
export function isStale(state: FlowState, now = Date.now()): boolean {
  return now - (state.updatedAt ?? state.startedAt ?? 0) > FLOW_TTL_MS;
}

/**
 * The next slot needing an answer, honouring `skipIf`.
 * Null when everything the flow needs has been collected.
 */
export function nextSlot(
  flow: FlowDefinition,
  collected: Record<string, string>
): SlotDefinition | null {
  for (const slot of flow.slots) {
    if (slot.skipIf?.(collected)) continue;
    if (collected[slot.name] === undefined) return slot;
  }
  return null;
}

/**
 * A correction aimed at a slot already answered — "no, Jos North", "actually
 * my name is Musa". Returns the slot it re-answers, or null.
 *
 * ── Why this refuses more than it accepts ───────────────────────────────────
 *
 * The obvious implementation — strip the correction words, then hand what is
 * left to every answered slot's `accept` in order and take the first that likes
 * it — is wrong, and wrong in the most damaging direction. Most slots validate
 * loosely because most answers are free text: a full name is "two words, no
 * digits", so "Jos South" parses as a perfectly good NAME. "no, Jos South"
 * meaning "I gave you the wrong LGA" therefore renamed the customer to
 * "Jos South", left the LGA untouched, and read the whole thing back as though
 * it had understood. The customer sees their name mangled and their correction
 * ignored in the same message.
 *
 * So a correction is applied only when the FIELD is known, by one of two
 * routes, and refused otherwise so the caller can ask which part is wrong:
 *
 *   1. the customer named it — "my name is …", "wrong LGA", "the hospital is …"
 *   2. the value can only belong to one field — an accredited facility, a real
 *      Plateau LGA, eleven digits. If two fields could claim it, that is not
 *      identification, and it is refused as well.
 */
const CORRECTION_MARKERS = [
  'no', 'actually', 'sorry', 'i meant', 'i said', 'change', 'instead', 'rather',
  'wrong', 'not', "a'?a", 'mba', 'r[aá]ra',
].map(word);

/** The correction scaffolding, removed to leave the value itself. */
const CORRECTION_NOISE =
  /\b(no|actually|sorry|i meant|i said|change it to|change to|change|instead|rather|wrong|it'?s|its|is|it should be|should be|my|the)\b/gi;

function stripNoise(text: string): string {
  return text
    .replace(CORRECTION_NOISE, ' ')
    .replace(/[,;:.!]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "my name is Amina Yusuf Bello" → the part after the field name. */
function valueAfterAlias(text: string, alias: string): string | null {
  const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(
    new RegExp(
      `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])\\s*(?:is|are|na|b[uụ]|ni|should be|:|,|-)?\\s*(.*)$`,
      'iu'
    )
  );
  return match ? (match[1] ?? '').trim() : null;
}

/**
 * What to do about a field the customer says is wrong.
 *
 * `value: null` means they named the field but not the replacement — "the
 * address is wrong", "change my LGA". The field is cleared and asked again,
 * which is the only honest reading: we know what is wrong and not what is
 * right. Filling it with the word "wrong" would be the alternative.
 */
export interface Correction {
  slot: SlotDefinition;
  value: string | null;
}

export function findCorrection(
  flow: FlowDefinition,
  collected: Record<string, string>,
  text: string
): Correction | null {
  if (!CORRECTION_MARKERS.some((r) => r.test(text))) return null;

  const answered = flow.slots.filter((s) => collected[s.name] !== undefined);

  // ── 1. The customer named the field ──────────────────────────────────────
  //
  // Longest alias wins, so "the hospital name is wrong" is about the hospital
  // rather than about the name — both aliases are present and only one of them
  // is what the sentence is about.
  let best: { slot: SlotDefinition; rest: string; aliasLength: number } | null = null;
  for (const slot of answered) {
    for (const alias of slot.aliases ?? []) {
      const rest = valueAfterAlias(text, alias);
      if (rest === null) continue;
      if (!best || alias.length > best.aliasLength) {
        best = { slot, rest, aliasLength: alias.length };
      }
    }
  }
  if (best) {
    const candidate = stripNoise(best.rest);
    if (!candidate) return { slot: best.slot, value: null };
    const parsed = best.slot.accept(candidate, collected);
    if ('value' in parsed && parsed.value !== collected[best.slot.name]) {
      return { slot: best.slot, value: parsed.value };
    }
    return { slot: best.slot, value: null };
  }

  // ── 2. The value names itself, and only one field can claim it ───────────
  const stripped = stripNoise(text);
  if (!stripped) return null;

  const claimants = answered.filter((s) => s.identifies?.(stripped, collected));
  if (claimants.length !== 1) return null;

  const parsed = claimants[0].accept(stripped, collected);
  if ('value' in parsed && parsed.value !== collected[claimants[0].name]) {
    return { slot: claimants[0], value: parsed.value };
  }
  return null;
}

/** A fresh state for a flow that is just beginning. */
export function beginFlow(flow: FlowDefinition): FlowState {
  const now = Date.now();
  return { flow: flow.name, collected: {}, awaiting: null, startedAt: now, updatedAt: now };
}

/** Narrow the JSON column back into a FlowState, or null if it is not one. */
export function asFlowState(value: unknown): FlowState | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<FlowState>;
  if (typeof v.flow !== 'string' || typeof v.collected !== 'object' || v.collected === null) {
    return null;
  }
  return {
    flow: v.flow,
    collected: v.collected as Record<string, string>,
    awaiting: typeof v.awaiting === 'string' ? v.awaiting : null,
    confirming: Boolean(v.confirming),
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : 0,
    updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : 0,
  };
}

/** What the engine decided to do with one message. */
export type FlowStep =
  | { kind: 'ask'; state: FlowState; reply: string }
  | { kind: 'confirm'; state: FlowState; reply: string }
  | { kind: 'execute'; state: FlowState }
  | { kind: 'abandon'; reply: string }
  | { kind: 'not-mine' };

/**
 * Advance a flow by one customer message.
 *
 * Pure: it decides and returns the next state, and never touches the database.
 * That is what makes the whole engine testable without one, and it keeps the
 * persistence decision (when to save, when to clear) in one place in the
 * orchestrator rather than scattered through every branch here.
 */
export function advanceFlow(
  flow: FlowDefinition,
  state: FlowState,
  text: string,
  lang: Language
): FlowStep {
  const message = (text ?? '').trim();

  if (wantsToAbandon(message)) {
    return { kind: 'abandon', reply: t(lang, 'flow_abandoned') };
  }

  const now = Date.now();
  const collected = { ...state.collected };

  // ── Waiting on the read-back ─────────────────────────────────────────────
  if (state.confirming) {
    if (isAffirmation(message)) {
      return { kind: 'execute', state: { ...state, collected, updatedAt: now } };
    }
    // "No" at the read-back means something in it is wrong. If the message
    // also names the correction, apply it; otherwise ask what to change rather
    // than restarting the whole form, which would make the customer repeat
    // five answers to fix one.
    const correction = findCorrection(flow, collected, message);
    if (correction && correction.value === null) {
      delete collected[correction.slot.name];
      return {
        kind: 'ask',
        state: { ...state, collected, awaiting: correction.slot.name, confirming: false, updatedAt: now },
        reply: correction.slot.prompt(collected),
      };
    }
    if (correction) {
      collected[correction.slot.name] = correction.value as string;
      const next: FlowState = { ...state, collected, awaiting: null, confirming: true, updatedAt: now };
      return { kind: 'confirm', state: next, reply: flow.summarise(collected) };
    }
    if (isNegation(message)) {
      return {
        kind: 'ask',
        state: { ...state, collected, awaiting: null, confirming: false, updatedAt: now },
        reply: t(lang, 'flow_what_to_change'),
      };
    }
    // Anything else: re-read it back rather than guessing what they meant.
    return {
      kind: 'confirm',
      state: { ...state, collected, updatedAt: now },
      reply: flow.summarise(collected),
    };
  }

  // ── A correction to something already answered ───────────────────────────
  const correction = findCorrection(flow, collected, message);
  if (correction && correction.value === null) {
    // Named a field as wrong without saying what it should be: clear it and ask.
    delete collected[correction.slot.name];
  } else if (correction) {
    collected[correction.slot.name] = correction.value as string;
  } else if (state.awaiting) {
    // ── The answer to the question we last asked ──────────────────────────
    const slot = flow.slots.find((s) => s.name === state.awaiting);
    if (slot) {
      if (slot.optional && isDecline(message)) {
        collected[slot.name] = '';
      } else {
        // "no, Jos South" right after being asked for the LGA is an answer with
        // a correction word stuck to the front of it. Try it verbatim first,
        // and only strip that scaffolding if the verbatim read fails — so an
        // answer that legitimately contains "not" is never quietly rewritten.
        let parsed = slot.accept(message, collected);
        if ('error' in parsed && CORRECTION_MARKERS.some((r) => r.test(message))) {
          const retry = stripNoise(message);
          if (retry) {
            const second = slot.accept(retry, collected);
            if ('value' in second) parsed = second;
          }
        }
        if ('error' in parsed) {
          // Re-ask WITH the reason, so the customer knows what would work.
          return {
            kind: 'ask',
            state: { ...state, collected, updatedAt: now },
            reply: parsed.error,
          };
        }
        collected[slot.name] = parsed.value;
      }
    }
  } else {
    // Nothing was asked yet — this is the message that started the flow, and
    // it is not an answer to anything.
  }

  const next = nextSlot(flow, collected);
  if (next) {
    return {
      kind: 'ask',
      state: { ...state, collected, awaiting: next.name, confirming: false, updatedAt: now },
      reply: next.prompt(collected),
    };
  }

  return {
    kind: 'confirm',
    state: { ...state, collected, awaiting: null, confirming: true, updatedAt: now },
    reply: flow.summarise(collected),
  };
}
