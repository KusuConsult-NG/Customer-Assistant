/**
 * Which appointment the customer means.
 *
 * Shared by the flows that act on an existing appointment — moving one and
 * cancelling one — because "you have two coming up, which did you mean?" is the
 * same question either way, and getting it wrong is the same failure: the
 * customer's OTHER appointment is the one that changes, and they find out when
 * they turn up for the one they thought they still had.
 *
 * Both flows used to answer that question by not asking it. They took the
 * soonest, which is right exactly as often as the customer happened to mean the
 * soonest.
 */
import type { SlotDefinition } from './flows';

/**
 * The key the orchestrator seeds the candidate list under.
 *
 * Underscore-prefixed so it can never collide with a slot name — `nextSlot`
 * only looks for slots, so this is inert data travelling in the same bag, which
 * is what keeps the flow engine free of database access.
 */
export const TARGETS_KEY = '_targets';

export interface AppointmentTarget {
  id: string;
  kind: 'BOOKING' | 'RESERVATION';
  /** What to call it when asking — "your Dental Check-up appointment". */
  label: string;
  /** When it currently is, ISO. */
  startIso: string;
  /** Already formatted for the customer, so the engine never needs a timezone. */
  startLabel: string;
}

export function readTargets(collected: Record<string, string>): AppointmentTarget[] {
  try {
    const parsed = JSON.parse(collected[TARGETS_KEY] ?? '[]');
    return Array.isArray(parsed) ? (parsed as AppointmentTarget[]) : [];
  } catch {
    return [];
  }
}

/** The appointment being acted on: the one they picked, or the only one there was. */
export function chosenTarget(collected: Record<string, string>): AppointmentTarget | null {
  const targets = readTargets(collected);
  if (targets.length === 0) return null;
  if (targets.length === 1) return targets[0];
  const index = Number(collected.which);
  return Number.isInteger(index) && targets[index] ? targets[index] : null;
}

/**
 * Match a reply against a numbered list of labels.
 *
 * Accepts the number, or enough of the label to be unambiguous — "the 10
 * o'clock one", "Tuesday". Ambiguity returns null rather than picking the first
 * match, because picking wrongly here changes a real appointment.
 */
export function pickFromList(text: string, labels: string[]): number | null {
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

export function numbered(labels: string[]): string {
  return labels.map((l, i) => `${i + 1} — ${l}`).join('\n');
}

/**
 * The "which one?" slot, worded for what the flow is about to do.
 *
 * Skipped entirely when there is only one candidate: asking about a single
 * appointment is a question whose answer we already have.
 */
export function whichSlot(verb: string): SlotDefinition {
  return {
    name: 'which',
    aliases: ['appointment', 'booking', 'reservation'],
    skipIf: (c) => readTargets(c).length <= 1,
    prompt: (c) =>
      `You have more than one coming up. Which would you like to ${verb}?\n\n` +
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
  };
}
