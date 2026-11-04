/**
 * When the platform may contact a citizen.
 *
 * ── Why this is not the serving hours ───────────────────────────────────────
 *
 * The two answer different questions, and conflating them breaks in both
 * directions.
 *
 * Serving hours say when an APPOINTMENT can be offered. Outbound hours say
 * when a PHONE MAY RING. An agency whose assistant answers around the clock
 * sets serving hours to 0–24 and still does not want a citizen woken at 03:00
 * — which is exactly what happened the moment 24/7 was configured: the
 * callback clamp became inert, so a promise made at 02:00 for "within the
 * hour" fell due at 03:00 and the dispatcher would have dialled it.
 *
 * It fails the other way too. A desk open 08:00–18:00 may well want reminders
 * going out from 07:00, before anyone is at the desk at all.
 *
 * ── Unset means unchanged ───────────────────────────────────────────────────
 *
 * `outboundClosingHour` is the flag. Null there means this agency has not
 * configured outbound hours, and the serving hours are used — which is what
 * every agency got before this existed. Nobody's behaviour changes until
 * somebody decides it should.
 *
 * The other two columns are not consulted when it is null, deliberately: a
 * half-filled configuration is not a configuration, and guessing from a stray
 * `outboundOpeningHour` left over from an abandoned edit would apply a window
 * nobody chose.
 */
import {
  DEFAULT_SERVICE_HOURS,
  assertUsableServiceHours,
  isWithinServiceHours,
  type ServiceHours,
} from './availability';
import { serviceHoursFrom, type OrganizationHoursReader } from './service-hours';

/** What a caller needs to select to resolve these without a second query. */
export const OUTBOUND_HOURS_SELECT = {
  outboundOpeningHour: true,
  outboundClosingHour: true,
  outboundDays: true,
  openingHour: true,
  closingHour: true,
  serviceDays: true,
} as const;

export interface OutboundHoursRow {
  outboundOpeningHour: number | null;
  outboundClosingHour: number | null;
  outboundDays: number[];
  openingHour: number;
  closingHour: number;
  serviceDays: number[];
}

/**
 * Resolve a row that already holds both sets of columns.
 *
 * Separate from the query so a caller holding the organization can avoid a
 * second round trip, and so this is testable without a database.
 */
export function outboundHoursOf(row: OutboundHoursRow): ServiceHours {
  const fallback: ServiceHours = {
    openHour: row.openingHour,
    closeHour: row.closingHour,
    days: row.serviceDays,
  };

  if (row.outboundClosingHour === null || row.outboundClosingHour === undefined) {
    return fallback;
  }

  const configured: ServiceHours = {
    openHour: row.outboundOpeningHour ?? 0,
    closeHour: row.outboundClosingHour,
    days: row.outboundDays?.length ? row.outboundDays : row.serviceDays,
  };

  // A window that cannot be satisfied would stop every callback forever, and
  // silently. The settings endpoint rejects those, so a row holding one was
  // written directly — fall back rather than strand the queue.
  try {
    assertUsableServiceHours(configured);
    return configured;
  } catch {
    return fallback;
  }
}

/**
 * The hours during which this agency may ring or message a citizen.
 *
 * Takes the client for the same reason `serviceHoursFrom` does: the
 * orchestrator's suites replace `@ace/database` wholesale, so a helper that
 * reached for its own client would be undefined in exactly the tests that
 * cover the callback flow.
 */
export async function outboundContactHoursFrom(
  db: OrganizationHoursReader,
  organizationId: string
): Promise<ServiceHours> {
  let row: OutboundHoursRow | null = null;
  try {
    row = (await db.organization.findUnique({
      where: { id: organizationId },
      select: OUTBOUND_HOURS_SELECT,
    })) as OutboundHoursRow | null;
  } catch {
    // Runs inside a live conversation. Throwing here means the citizen gets no
    // reply at all, so the standard week is the safer answer.
    return DEFAULT_SERVICE_HOURS;
  }

  if (!row) return DEFAULT_SERVICE_HOURS;

  // No outbound window configured: defer to serving hours, resolved through
  // the same helper so its own validation and fallbacks apply.
  if (row.outboundClosingHour === null || row.outboundClosingHour === undefined) {
    return serviceHoursFrom(db, organizationId);
  }

  return outboundHoursOf(row);
}

/** True when the platform may contact a citizen right now. */
export function mayContactNow(hours: ServiceHours, now: Date = new Date()): boolean {
  return isWithinServiceHours(now, hours);
}

/**
 * Validate a proposed outbound window.
 *
 * Clearing it is always allowed — an agency must be able to go back to
 * "same as serving hours" without having to know what those are.
 */
export function assertUsableOutboundHours(input: {
  outboundOpeningHour?: number | null;
  outboundClosingHour?: number | null;
  outboundDays?: number[] | null;
}): void {
  const { outboundOpeningHour, outboundClosingHour, outboundDays } = input;

  // Cleared.
  if (outboundClosingHour === null) return;
  if (outboundClosingHour === undefined) return;

  assertUsableServiceHours({
    openHour: outboundOpeningHour ?? 0,
    closeHour: outboundClosingHour,
    // An empty day list means "the serving days", which is checked when it is
    // resolved rather than rejected here.
    days: outboundDays?.length ? outboundDays : [0, 1, 2, 3, 4, 5, 6],
  });
}
