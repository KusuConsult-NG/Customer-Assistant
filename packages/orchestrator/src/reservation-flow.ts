/**
 * Reserving a table, for the number of people who are actually coming.
 *
 * ── Two defects, and the party size is the worse one ────────────────────────
 *
 * Reservations were written from one message. The time was whatever slot came
 * next, which is the same shape the booking, reschedule and cancel paths all
 * had. But the party size had a worse failure:
 *
 *     const partySize = extractPartySize(messageText) ?? 2;
 *
 * A message that did not name a number silently became a table for TWO. "Can I
 * book a table for Friday?" from a group of eight produced a reservation for
 * two, told the customer a table was reserved, and left the restaurant setting
 * two covers. Nothing failed and nothing was logged — a fabricated fact was
 * written into a real reservation and read back as though the customer had
 * said it. That is invariant 1, in the one field a restaurant plans around.
 *
 * So a party size found in the message is used, and a party size that is NOT
 * there is ASKED FOR. Never defaulted.
 *
 * ── Why there is no separate read-back ──────────────────────────────────────
 *
 * The time prompt names the party size — "A table for 4. Here is what is free"
 * — so picking a time answers a question that had the number in it. If we
 * inferred the size from their sentence, that inference is on screen before
 * anything is written, which is the part that matters. Adding a third turn to
 * re-state it would be the same information a third time.
 */
import type { FlowDefinition } from './flows';
import { numbered, pickFromList } from './appointment-targets';

export const RESERVATION_FLOW_NAME = 'make-reservation';

/** Keys the orchestrator seeds before the flow runs. */
export const TABLE_SLOTS_KEY = '_tableSlots';

export interface TableSlot {
  startIso: string;
  endIso: string;
  label: string;
}

export function readTableSlots(collected: Record<string, string>): TableSlot[] {
  try {
    const parsed = JSON.parse(collected[TABLE_SLOTS_KEY] ?? '[]');
    return Array.isArray(parsed) ? (parsed as TableSlot[]) : [];
  } catch {
    return [];
  }
}

export function chosenTableSlot(collected: Record<string, string>): TableSlot | null {
  const slots = readTableSlots(collected);
  const index = Number(collected.when);
  return Number.isInteger(index) && slots[index] ? slots[index] : null;
}

/** The party size as a number, or null if it has not been established. */
export function partySizeOf(collected: Record<string, string>): number | null {
  const n = Number(collected.partySize);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PARTY ? n : null;
}

const MAX_PARTY = 50;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
  // The five languages, for the small numbers a table booking actually uses.
  daya: 1, biyu: 2, uku: 3, hudu: 4, biyar: 5,                       // Hausa
  otu: 1, abuo: 2, ato: 3, ano: 4, ise: 5,                           // Igbo
  ookan: 1, meji: 2, meta: 3, merin: 4, marun: 5,                    // Yoruba
};

const guests = (n: number) => `${n} guest${n === 1 ? '' : 's'}`;

export const RESERVATION_FLOW: FlowDefinition = {
  name: RESERVATION_FLOW_NAME,

  slots: [
    {
      name: 'partySize',
      aliases: ['party', 'people', 'guests', 'persons', 'covers'],
      identifies: (text) => /^\d{1,2}$/.test(text.trim()),
      // Skipped only when the message already named a number — never defaulted.
      skipIf: (c) => partySizeOf(c) !== null,
      prompt: () => 'How many people will the table be for?',
      accept: (text) => {
        const value = text.trim().toLowerCase();

        const digits = value.match(/\b(\d{1,2})\b/);
        if (digits) {
          const n = Number(digits[1]);
          if (n >= 1 && n <= MAX_PARTY) return { value: String(n) };
          return {
            error:
              n < 1
                ? 'A table needs at least one person. How many will be coming?'
                : `That is more than we can seat on one booking. For a party over ${MAX_PARTY}, ` +
                  `say *"speak to an agent"* and a colleague will arrange it.`,
          };
        }

        for (const [word, n] of Object.entries(NUMBER_WORDS)) {
          if (new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu').test(value)) {
            return { value: String(n) };
          }
        }

        return { error: 'How many people should I book the table for? A number is fine.' };
      },
    },
    {
      name: 'when',
      aliases: ['time', 'date', 'day', 'slot'],
      prompt: (c) => {
        const size = partySizeOf(c);
        // The party size is stated HERE rather than in a separate read-back:
        // picking a time answers a question that had the number in it.
        const heading = size ? `A table for ${guests(size)}. ` : '';
        return (
          `${heading}Here is what is free:\n\n` +
          numbered(readTableSlots(c).map((s) => s.label)) +
          '\n\nReply with the number that suits you. If none of these work, ' +
          'say *"speak to an agent"* and a colleague will find something else.'
        );
      },
      accept: (text, c) => {
        const slots = readTableSlots(c);
        const index = pickFromList(text, slots.map((s) => s.label));
        if (index === null) {
          return {
            error:
              'I can only hold one of these, so that I do not put you down for a ' +
              'time that is already taken:\n\n' +
              numbered(slots.map((s) => s.label)) +
              '\n\nReply with the number, or say *"speak to an agent"* for anything else.',
          };
        }
        return { value: String(index) };
      },
    },
  ],

  // No read-back: see the note at the top of this file.
};
