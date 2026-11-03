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
import { normalizePhoneNumber, phoneNumberVariants } from './phone-number';

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
 * The citizen record for a phone number, created if this is the first contact.
 *
 * ── Why this is shared ──────────────────────────────────────────────────────
 *
 * The orchestrator created contacts lazily, when a tool finally needed one.
 * So a citizen who rang, heard the greeting and hung up left a CallLog and no
 * citizen record at all — invisible on Citizens & Contacts, and impossible to
 * ring back, which is exactly the person a care line most needs to reach. The
 * inbound call handler now creates the record the moment the call is answered,
 * and both paths call THIS, so the two cannot disagree about what a new
 * citizen looks like.
 *
 * Matching is across every stored shape (`phoneNumberVariants`) and writing is
 * canonical, so the same person arriving by phone and by WhatsApp lands on one
 * record rather than two.
 */
export async function ensureContactForPhone(
  db: { contact: { findFirst: Function; create: Function } },
  organizationId: string,
  phoneNumber: string,
  fullName?: string
): Promise<{ id: string; fullName: string; phoneNumber: string } | null> {
  const phone = (phoneNumber || '').trim();
  // Carriers send "UNKNOWN", "anonymous" or an empty value for a withheld
  // number. A contact keyed on that is one row every withheld caller in the
  // State shares, so it is not created at all.
  if (!phone || /^(unknown|anonymous|private|restricted|withheld)$/i.test(phone)) return null;

  const existing = await db.contact.findFirst({
    where: { organizationId, phoneNumber: { in: phoneNumberVariants(phone) } },
  });
  if (existing) return existing;

  try {
    return await db.contact.create({
      data: {
        organizationId,
        phoneNumber: normalizePhoneNumber(phone),
        // Not "Valued Customer": this is a State agency and the people on the
        // other end are citizens. The last four digits make one unnamed caller
        // distinguishable from the next at a glance.
        fullName: fullName?.trim() || `Caller (···${phone.slice(-4)})`,
      },
    });
  } catch (err: any) {
    // Two calls from the same new number at once: the unique constraint is the
    // arbiter, and the loser re-reads rather than failing the call.
    if (err?.code === 'P2002') {
      return db.contact.findFirst({
        where: { organizationId, phoneNumber: { in: phoneNumberVariants(phone) } },
      });
    }
    throw err;
  }
}
