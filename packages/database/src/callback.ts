/**
 * Callback promises: the reference a citizen is quoted, and the time the
 * promise actually falls due.
 *
 * Lives here rather than in either engine because BOTH use it — the
 * orchestrator writes the record and reads the reference back to the citizen,
 * and the API's dispatcher reads the same reference onto the console and
 * recomputes the due time on every retry. Two copies of "when did we say" is
 * how a promise and the thing that keeps it drift apart.
 */
import { DEFAULT_SERVICE_HOURS, isWithinServiceHours, type ServiceHours } from './availability';

/** Statuses that mean "somebody still owes this citizen a call". */
export const OPEN_CALLBACK_STATUSES = ['PENDING', 'DUE', 'IN_PROGRESS'] as const;

/**
 * The reference a citizen is given, derived from the row's own id.
 *
 * Derived rather than stored and generated: a separate counter column is
 * another thing to collide on (the ticket numbering did exactly that — a
 * six-digit clock value that repeated every 16.7 minutes across every tenant),
 * and a uuid is already unique. Upper case because it gets read aloud on a
 * phone call and dictated back at a desk.
 */
export function callbackReference(id: string): string {
  return `CB-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

const HOUR = 60 * 60 * 1000;
const WAT_OFFSET_HOURS = 1;

function watDay(date: Date): number {
  return new Date(date.getTime() + WAT_OFFSET_HOURS * HOUR).getUTCDay();
}

/**
 * The first moment at or after `from` that the agency is actually open.
 *
 * A citizen who asks at 17:50 for a call "within the hour" would otherwise be
 * promised 18:50, after the office has shut — a promise broken at the moment
 * it was made. This moves it to the next opening hour instead, so the record
 * is due when somebody is there to act on it.
 *
 * Returns `from` unchanged when it is already inside serving hours, and gives
 * up after a fortnight of searching rather than looping forever on hours that
 * can never be satisfied (`assertUsableServiceHours` rejects those at the
 * settings endpoint, but this runs inside a live conversation and must not
 * hang on a row that predates that check).
 */
export function nextServiceTime(
  from: Date,
  hours: ServiceHours = DEFAULT_SERVICE_HOURS
): Date {
  if (!hours.days.length || hours.closeHour <= hours.openHour) return from;
  if (isWithinServiceHours(from, hours)) return from;

  // Step to the top of the next hour and walk forward. Hour granularity is
  // enough: these windows are "within the hour" and "tomorrow", not a minute.
  const cursor = new Date(from.getTime());
  cursor.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 24 * 15; i++) {
    cursor.setTime(cursor.getTime() + HOUR);
    if (isWithinServiceHours(cursor, hours)) return cursor;
  }
  return from;
}

/**
 * Whether a callback that failed should be tried again, and when.
 *
 * Backs off so a citizen whose phone is engaged is not rung three times in a
 * minute, and keeps every retry inside serving hours for the same reason the
 * first attempt is.
 */
export function nextAttemptAt(
  attempts: number,
  hours: ServiceHours = DEFAULT_SERVICE_HOURS,
  now: Date = new Date()
): Date {
  const backoffMinutes = [10, 30, 60][Math.min(attempts, 2)];
  return nextServiceTime(new Date(now.getTime() + backoffMinutes * 60_000), hours);
}

/** True when the promise has been missed — used to flag it on the console. */
export function isOverdue(dueAt: Date, now: Date = new Date()): boolean {
  return dueAt.getTime() < now.getTime();
}

/**
 * The reference a citizen is given for an appointment.
 *
 * ── Why it is here and not in each engine ───────────────────────────────────
 *
 * It was in both, differently. The orchestrator quoted
 * `booking.id.slice(-8).toUpperCase()` on WhatsApp and the agent's tools quoted
 * `booking.id.slice(0, 8)` on a phone call — the LAST eight characters in upper
 * case, and the FIRST eight in lower. One booking, two references, neither
 * matching the other, so a citizen who booked by phone and quoted their
 * reference on WhatsApp was answered about a booking nobody could find.
 *
 * `Booking` has no reference column, so this derives one — prefixed, like a
 * callback's, because these get read aloud and dictated at a desk, and
 * "AP-3F2B91CD" survives that where a bare hex string does not.
 */
export function bookingReference(id: string): string {
  return `AP-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}
