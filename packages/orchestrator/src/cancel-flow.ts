/**
 * Cancelling an appointment, by asking first.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * "cancel my appointment" cancelled the soonest one, immediately, and replied
 * that it had been "successfully cancelled". One message in, one irreversible
 * write out, no question asked.
 *
 * Two ways that goes wrong, and cancelling is the worse verb for both:
 *
 *   - A customer with two appointments loses the one they did not mean. A
 *     rescheduled appointment still exists somewhere; a cancelled one is gone,
 *     the slot is released, and somebody else can take it before they notice.
 *     They find out by turning up for an appointment they no longer have.
 *   - Nobody gets to say "no, wait". Booking, rescheduling and enrolling all
 *     read back before they write. The only one that did not was the one that
 *     cannot be undone.
 *
 * ── Why there is no "are you sure?" beyond the read-back ────────────────────
 *
 * The read-back IS the confirmation, and it names the appointment and its time,
 * so "yes" is answering a specific question rather than a generic one. Asking
 * twice trains people to type "yes" twice without reading either, which is how
 * a confirmation step stops confirming anything.
 */
import type { FlowDefinition } from './flows';
import { chosenTarget, whichSlot } from './appointment-targets';
import { t } from './languages';

export const CANCEL_FLOW_NAME = 'cancel-booking';

export const CANCEL_FLOW: FlowDefinition = {
  name: CANCEL_FLOW_NAME,

  // The only thing this flow needs to know. With one appointment upcoming the
  // slot is skipped and the customer goes straight to the read-back.
  slots: [whichSlot('verb_cancel')],

  summarise: (c, lang) => {
    const target = chosenTarget(c);
    // Should not happen: a target list is seeded before the flow starts. Asking
    // again is the safe reading — it never cancels on a guess.
    if (!target) return t(lang, 'lost_track');
    return t(lang, 'cancel_summary', { label: target.label, when: target.startLabel });
  },
};
