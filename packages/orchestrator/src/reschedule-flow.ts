/**
 * Moving an appointment, by asking.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * "Can I move my appointment?" used to relocate the customer's next booking to
 * TOMORROW AT 10:00 — unilaterally, in the database — and then reply that it
 * "has been rescheduled", inviting them to call back if they wanted a specific
 * time. The comment beside it said why: there was no multi-turn state, so it
 * could not ask. That was true, and it is not any more.
 *
 * The cost of the old behaviour was not cosmetic. The customer is told a time
 * they never chose, the clinic expects them then, and if they had two
 * appointments it was always the earliest one that moved, whichever they meant.
 *
 * ── Why the customer picks from a list ──────────────────────────────────────
 *
 * The options offered here are real openings, read out of the same availability
 * search the booking tool uses. The flow deliberately does NOT parse "next
 * Tuesday afternoon" into a timestamp: a misparsed date writes a real
 * appointment at a time nobody agreed, which is the failure this whole change
 * exists to remove. A reply that does not match an offered slot re-offers them.
 * Somebody who wants a time we have not offered can ask for a person, which
 * wins over any flow.
 *
 * ── The two things that are re-checked at write time ────────────────────────
 *
 * State survives for up to an hour, and the world moves underneath it:
 *
 *   - the slot may have been taken by somebody else since it was offered
 *   - the booking may have been cancelled since it was listed
 *
 * So `advanceFlow` returning `execute` is permission to TRY, never a promise
 * that it worked. The orchestrator re-reads both and reports what actually
 * happened — see `completeReschedule`.
 */
import type { FlowDefinition } from './flows';

export const RESCHEDULE_FLOW_NAME = 'reschedule-booking';

/**
 * Keys the orchestrator seeds into `collected` before the flow runs, carrying
 * the data the slots need to ask their questions.
 *
 * Underscore-prefixed so they can never collide with a slot name — `nextSlot`
 * only looks for slots, so these are inert data that happens to travel in the
 * same bag, which is what keeps the engine free of database access.
 */
export const TARGETS_KEY = '_targets';
export const OPTIONS_KEY = '_options';

export interface RescheduleTarget {
  id: string;
  kind: 'BOOKING' | 'RESERVATION';
  /** What to call it when asking — "your Dental Check-up" / "your table for 4". */
  label: string;
  /** When it currently is, ISO. */
  startIso: string;
  /** Already formatted for the customer, so the engine never needs a timezone. */
  startLabel: string;
}

export interface RescheduleOption {
  startIso: string;
  endIso: string;
  label: string;
}

function readJson<T>(collected: Record<string, string>, key: string): T[] {
  try {
    const parsed = JSON.parse(collected[key] ?? '[]');
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export const readTargets = (c: Record<string, string>) => readJson<RescheduleTarget>(c, TARGETS_KEY);
export const readOptions = (c: Record<string, string>) => readJson<RescheduleOption>(c, OPTIONS_KEY);

/** The appointment being moved: the one they picked, or the only one there was. */
export function chosenTarget(c: Record<string, string>): RescheduleTarget | null {
  const targets = readTargets(c);
  if (targets.length === 0) return null;
  if (targets.length === 1) return targets[0];
  const index = Number(c.which);
  return Number.isInteger(index) && targets[index] ? targets[index] : null;
}

/** The slot they picked. */
export function chosenOption(c: Record<string, string>): RescheduleOption | null {
  const options = readOptions(c);
  const index = Number(c.when);
  return Number.isInteger(index) && options[index] ? options[index] : null;
}

/**
 * Match a reply against a numbered list of labels.
 *
 * Accepts the number, or enough of the label to be unambiguous — "the 10
 * o'clock one", "Tuesday". Ambiguity returns null rather than picking the
 * first match, because picking wrongly here moves a real appointment.
 */
function pickFromList(text: string, labels: string[]): number | null {
  const value = text.trim().toLowerCase();
  if (!value) return null;

  const asNumber = value.match(/^\s*#?\s*(\d{1,2})\b/);
  if (asNumber) {
    const index = Number(asNumber[1]) - 1;
    if (index >= 0 && index < labels.length) return index;
    return null;
  }

  const matches: number[] = [];
  labels.forEach((label, i) => {
    if (label.toLowerCase().includes(value)) matches.push(i);
  });
  if (matches.length === 1) return matches[0];

  // Fall back to a distinctive fragment: a weekday or a clock time is usually
  // what somebody types instead of a number.
  const fragment = value.match(
    /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}[:.]\d{2}|\d{1,2}\s*(am|pm))\b/
  );
  if (fragment) {
    const needle = fragment[0].replace(/\s+/g, '').replace('.', ':');
    const hits: number[] = [];
    labels.forEach((label, i) => {
      if (label.toLowerCase().replace(/\s+/g, '').includes(needle)) hits.push(i);
    });
    if (hits.length === 1) return hits[0];
  }
  return null;
}

function numbered(labels: string[]): string {
  return labels.map((l, i) => `${i + 1} — ${l}`).join('\n');
}

export const RESCHEDULE_FLOW: FlowDefinition = {
  name: RESCHEDULE_FLOW_NAME,

  slots: [
    {
      name: 'which',
      aliases: ['appointment', 'booking', 'reservation'],
      // Only asked when there is a genuine choice. With one upcoming
      // appointment there is nothing to disambiguate, and asking would be a
      // question whose answer we already have.
      skipIf: (c) => readTargets(c).length <= 1,
      prompt: (c) =>
        'You have more than one coming up. Which would you like to move?\n\n' +
        numbered(readTargets(c).map((t) => `${t.label} — ${t.startLabel}`)) +
        '\n\nReply with the number.',
      accept: (text, c) => {
        const targets = readTargets(c);
        const index = pickFromList(text, targets.map((t) => `${t.label} ${t.startLabel}`));
        if (index === null) {
          return {
            error:
              'I did not catch which one. Please reply with the number:\n\n' +
              numbered(targets.map((t) => `${t.label} — ${t.startLabel}`)),
          };
        }
        return { value: String(index) };
      },
    },
    {
      name: 'when',
      aliases: ['time', 'date', 'day', 'slot'],
      prompt: (c) => {
        const target = chosenTarget(c);
        const options = readOptions(c);
        const heading = target
          ? `Moving ${target.label}, currently ${target.startLabel}.\n\n`
          : '';
        return (
          `${heading}Here is what is free:\n\n` +
          numbered(options.map((o) => o.label)) +
          '\n\nReply with the number that suits you. If none of these work, ' +
          'say *"speak to an agent"* and a colleague will find something else.'
        );
      },
      accept: (text, c) => {
        const options = readOptions(c);
        const index = pickFromList(text, options.map((o) => o.label));
        if (index === null) {
          return {
            // Re-offer rather than guess. Parsing a date out of this sentence
            // is how an appointment ends up at a time nobody agreed.
            error:
              'I can only move it to one of these, so that I do not put you down ' +
              'for a time that is already taken:\n\n' +
              numbered(options.map((o) => o.label)) +
              '\n\nReply with the number, or say *"speak to an agent"* for anything else.',
          };
        }
        return { value: String(index) };
      },
    },
  ],

  summarise: (c) => {
    const target = chosenTarget(c);
    const option = chosenOption(c);
    if (!target || !option) {
      // Should not happen: both slots are filled before a read-back. Asking
      // again is the safe reading — it never asserts a move that was not set up.
      return 'Sorry — I lost track of which appointment we were moving. Could you tell me again?';
    }
    return (
      'Just to confirm before I change anything:\n\n' +
      `• ${target.label}\n` +
      `• From: ${target.startLabel}\n` +
      `• To: ${option.label}\n\n` +
      'Reply *yes* to move it, or tell me what to change.'
    );
  },
};
