/**
 * When the business is open, and what is genuinely free.
 *
 * ── Why this is shared rather than owned by one engine ──────────────────────
 *
 * The orchestrator OFFERS free times: booking, rescheduling and reserving all
 * read this list and let the customer pick from it. The hosted agent, until
 * now, could not — it had no availability tool, so it asked the caller to name
 * a time, tried to write it, and discovered the answer from an exclusion
 * violation: "that time is not available, could we try another?" On a busy
 * diary that is a guess-and-retry loop on a live phone call.
 *
 * Giving the agent its own copy of "what is free" would be two implementations
 * of one question, and they would drift — one engine offering a slot the other
 * considers taken is a double booking that both paths believed was legitimate.
 * So the search lives here, next to the bookings it reads, and both engines
 * call it.
 *
 * ── The hours belong to the AGENCY, not the platform ────────────────────────
 *
 * They used to be constants here: Monday–Friday, 08:00–18:00 West Africa Time,
 * for every tenant. On a State platform that is wrong in both directions — a
 * teaching hospital was never offered a weekend slot it could actually staff,
 * and a registry that opens at nine had citizens offered eight o'clock.
 *
 * The caller passes the agency's hours. `DEFAULT_SERVICE_HOURS` reproduces the
 * old constants exactly, so an agency that has never configured them behaves
 * as before, and the defaults live on the Organization row rather than here.
 *
 * ── Why the query is passed in ──────────────────────────────────────────────
 *
 * This module deliberately imports no Prisma client. Both engines already hold
 * one — and the orchestrator's test suites replace it — so a top-level import
 * here would make the shared definition of "free" untestable in the very place
 * it is used most. The caller supplies a loader; everything that decides what
 * free MEANS stays here.
 */
export const BUSINESS_TIMEZONE = 'Africa/Lagos';
const WAT_OFFSET_HOURS = 1;

/** When one agency serves citizens. Hours are whole hours in WAT. */
export interface ServiceHours {
  /** First hour open, inclusive. 8 means a 08:00 start. */
  openHour: number;
  /** Hour it closes, exclusive. 18 means the last slot ends by 18:00. */
  closeHour: number;
  /** Days served, 0 = Sunday … 6 = Saturday. */
  days: readonly number[];
}

/**
 * What every agency got before hours were configurable, and what an agency
 * that has configured nothing still gets.
 */
export const DEFAULT_SERVICE_HOURS: ServiceHours = {
  openHour: 8,
  closeHour: 18,
  days: [1, 2, 3, 4, 5],
};

/**
 * Hours that cannot produce a slot are rejected rather than silently used.
 *
 * An agency saved with closeHour <= openHour, or with no service days, yields
 * an empty availability search — the citizen is told there is nothing free for
 * the next fortnight, which looks like a full diary rather than a
 * misconfiguration. Falling back to the default would be worse: it would offer
 * times the agency never agreed to.
 */
export function assertUsableServiceHours(h: ServiceHours): void {
  if (!Number.isInteger(h.openHour) || h.openHour < 0 || h.openHour > 23) {
    throw new Error(`openHour must be an hour between 0 and 23, got ${h.openHour}`);
  }
  if (!Number.isInteger(h.closeHour) || h.closeHour < 1 || h.closeHour > 24) {
    throw new Error(`closeHour must be an hour between 1 and 24, got ${h.closeHour}`);
  }
  if (h.closeHour <= h.openHour) {
    throw new Error(`closeHour (${h.closeHour}) must be after openHour (${h.openHour})`);
  }
  if (h.days.length === 0) {
    throw new Error('An agency must serve at least one day a week');
  }
  if (h.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new Error(`service days must be 0-6 (Sunday-Saturday), got ${JSON.stringify(h.days)}`);
  }
}

/** How far ahead a search will look before giving up. */
export const SEARCH_HORIZON_DAYS = 14;

/**
 * At most this many offers land on any one day.
 *
 * Five consecutive half-hours on Tuesday morning is one option presented five
 * times; a customer who cannot do Tuesday has been shown nothing.
 */
const MAX_PER_DAY = 2;

export interface FreeSlot {
  start: Date;
  end: Date;
}

/** What occupies a slot. Shared so the two loaders cannot disagree on it. */
export const BUSY_BOOKING_STATUSES = ['CONFIRMED', 'RESCHEDULED'] as const;

/** Rows a loader must return: any booking that occupies time. */
export interface BusyPeriod {
  startTime: Date;
  endTime: Date;
}

/** Reads the bookings that occupy time in a window. */
export type BusyLoader = (from: Date, to: Date) => Promise<BusyPeriod[]>;

function watHour(date: Date): number {
  return (date.getUTCHours() + WAT_OFFSET_HOURS) % 24;
}

/** Day of week in WAT: 0 = Sunday … 6 = Saturday. */
function watDay(date: Date): number {
  const shifted = new Date(date.getTime() + WAT_OFFSET_HOURS * 60 * 60 * 1000);
  return shifted.getUTCDay();
}

export function isWithinServiceHours(
  date: Date,
  hours: ServiceHours = DEFAULT_SERVICE_HOURS
): boolean {
  if (!hours.days.includes(watDay(date))) return false;
  const hour = watHour(date);
  return hour >= hours.openHour && hour < hours.closeHour;
}

/** A time as the customer will hear it. */
export function formatLagos(date: Date): string {
  return date.toLocaleString('en-NG', {
    timeZone: BUSINESS_TIMEZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Up to `limit` genuinely free slots, soonest first and spread across days.
 *
 * Free means: inside business hours for its whole length, at least an hour from
 * now, and overlapping no CONFIRMED or RESCHEDULED booking. It is a read — the
 * database still settles the race at write time through the exclusion
 * constraint, because anything found here can be taken before the customer
 * replies.
 */
export async function findAvailableSlots(
  loadBusy: BusyLoader,
  durationMinutes: number,
  limit: number,
  hours: ServiceHours = DEFAULT_SERVICE_HOURS
): Promise<FreeSlot[]> {
  assertUsableServiceHours(hours);
  const now = Date.now();
  const horizon = new Date(now + SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000);

  const existing = await loadBusy(new Date(now), horizon);
  const busy = existing.map((b) => [b.startTime.getTime(), b.endTime.getTime()] as const);
  const durationMs = durationMinutes * 60 * 1000;

  // Start at the next half-hour boundary, at least an hour out.
  let cursor = new Date(now + 60 * 60 * 1000);
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() > 30 ? 60 : 30);

  const found: FreeSlot[] = [];
  const perDay = new Map<string, number>();

  while (cursor.getTime() < horizon.getTime() && found.length < limit) {
    const end = new Date(cursor.getTime() + durationMs);

    if (isWithinServiceHours(cursor, hours) && isWithinServiceHours(new Date(end.getTime() - 1), hours)) {
      const clashes = busy.some(([s, e]) => cursor.getTime() < e && end.getTime() > s);
      if (!clashes) {
        const day = cursor.toISOString().slice(0, 10);
        const taken = perDay.get(day) ?? 0;
        if (taken < MAX_PER_DAY) {
          perDay.set(day, taken + 1);
          found.push({ start: new Date(cursor), end });
        }
      }
    }

    cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
  }

  return found;
}

/** The soonest free slot, or null. */
export async function findNextAvailableSlot(
  loadBusy: BusyLoader,
  durationMinutes: number,
  hours: ServiceHours = DEFAULT_SERVICE_HOURS
): Promise<FreeSlot | null> {
  return (await findAvailableSlots(loadBusy, durationMinutes, 1, hours))[0] ?? null;
}
