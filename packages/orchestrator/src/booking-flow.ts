/**
 * Booking an appointment at a time the customer chose.
 *
 * ── What this changes ───────────────────────────────────────────────────────
 *
 * Booking took the next free slot in the diary and wrote it, then told the
 * customer which slot it had taken and invited them to correct it. That is
 * better than the reschedule bug it sits beside — it is honest about what it
 * did, and the customer can move it — but it is the same shape: one message in,
 * one write out, and a time nobody chose.
 *
 * The cost lands on the people least able to absorb it. A PLASCHEMA enrollee
 * travels to a facility; "we have put you down for Tuesday 11:00" to somebody
 * who can only come after work is an appointment they will miss, a slot the
 * clinic holds empty, and a second conversation to undo it.
 *
 * ── Why there is no read-back here, when cancelling has one ─────────────────
 *
 * The customer picks one slot from a list of genuinely free ones. That reply IS
 * the decision, about the only variable in it — so a "yes" afterwards confirms
 * the thing they just said. Two steps to mean one thing is how people learn to
 * answer without reading, which then costs something on the flows where the
 * read-back is load-bearing.
 *
 * Cancelling and rescheduling keep theirs because they act on an appointment
 * that already exists: the cost of a misread there is an appointment moved or
 * destroyed, not a wrong slot that can be picked again.
 *
 * ── What it will not do ─────────────────────────────────────────────────────
 *
 * It does not parse "sometime next week" into a timestamp, for the same reason
 * rescheduling does not: a misparsed date is a real appointment at a time
 * nobody agreed. Every offered slot was checked free; anything that matches
 * none of them is re-offered, and a customer who needs something else can ask
 * for a person, which wins over any flow.
 */
import type { FlowDefinition } from './flows';
import { numbered, pickFromList } from './appointment-targets';
import { t } from './languages';

export const BOOKING_FLOW_NAME = 'book-appointment';

/** Keys the orchestrator seeds before the flow runs. */
export const SLOTS_KEY = '_slots';
export const SERVICE_KEY = '_service';

export interface BookableSlot {
  startIso: string;
  endIso: string;
  label: string;
}

export function readSlots(collected: Record<string, string>): BookableSlot[] {
  try {
    const parsed = JSON.parse(collected[SLOTS_KEY] ?? '[]');
    return Array.isArray(parsed) ? (parsed as BookableSlot[]) : [];
  } catch {
    return [];
  }
}

/** The slot the customer picked. */
export function chosenSlot(collected: Record<string, string>): BookableSlot | null {
  const slots = readSlots(collected);
  const index = Number(collected.when);
  return Number.isInteger(index) && slots[index] ? slots[index] : null;
}

export const serviceOf = (collected: Record<string, string>) =>
  collected[SERVICE_KEY] || 'General Consultation';

export const BOOKING_FLOW: FlowDefinition = {
  name: BOOKING_FLOW_NAME,
  title: 'Booking an appointment',

  slots: [
    {
      name: 'when',
      label: 'Time',
      // Stores an index into the offered slots; staff need the slot itself.
      display: (c) => chosenSlot(c)?.label ?? '',
      aliases: ['time', 'date', 'day', 'slot'],
      prompt: (c, lang) =>
        t(lang, 'book_ask', {
          service: serviceOf(c),
          list: numbered(readSlots(c).map((x) => x.label)),
        }),
      accept: (text, c, lang) => {
        const slots = readSlots(c);
        const index = pickFromList(text, slots.map((x) => x.label));
        if (index === null) {
          return {
            error: t(lang, 'book_only_these', {
              list: numbered(slots.map((x) => x.label)),
            }),
          };
        }
        return { value: String(index) };
      },
    },
  ],

  // No read-back: see the note at the top of this file.
};
