/**
 * The reference a customer is given for a ticket.
 *
 * `Ticket.ticketNumber` is `@unique` across the WHOLE TABLE, not per
 * organization. So two tenants competing for the same string is the ordinary
 * case on a busy platform, not an edge case — and a collision is not a cosmetic
 * problem: the insert raises P2002, the tool reports a failure, and the customer
 * who just described a fault is told "I ran into a technical problem" with
 * nothing recorded.
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * The orchestrator built numbers as `TCK-${Date.now().toString().slice(-6)}` —
 * the last six digits of the epoch millisecond. That is 10^6 values which
 * REPEAT EVERY 16.7 MINUTES, shared across every tenant, with no retry. Two
 * complaints filed in the same millisecond collide; so do two filed 16.7
 * minutes apart. Reproduced end to end: with the candidate numbers held by a
 * different organization, a customer reporting a fault got the failure reply
 * and zero tickets were stored.
 *
 * CrmService had already been fixed for exactly this — its own comment records
 * 14 HTTP 500s out of 25 parallel creates from the previous scheme — but the
 * fix lived in the API, where `packages/orchestrator` could not reach it. So
 * the live engine kept the broken generator. This module is the shared one, in
 * `@ace/database` because that is what both sides already import.
 *
 * ── The scheme ──────────────────────────────────────────────────────────────
 *
 * Base-36 milliseconds keeps numbers sorting chronologically, which is what
 * makes them useful to read; three random bytes make a same-millisecond
 * collision improbable rather than certain; and the bounded retry turns the
 * remaining improbability into a different number rather than a lost ticket.
 *
 * The prefix is a parameter because it carries meaning to staff: a refund
 * request is filed as REF-BK / REF-RS so it can be told apart from a support
 * ticket at a glance.
 */
import { randomBytes } from 'crypto';

/** A time-ordered, collision-resistant reference. */
export function generateTicketNumber(prefix = 'TCK'): string {
  const time = Date.now().toString(36).toUpperCase();
  const entropy = randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${time}-${entropy}`;
}

/**
 * Insert a ticket, allocating a fresh number if the unique constraint bites.
 *
 * Takes a closure rather than data because the two callers need different
 * Prisma options (one wants the contact included), and because retrying has to
 * re-run the insert with a NEW number — not retry the same one.
 *
 * A P2002 on any other field is rethrown untouched: retrying a duplicate
 * contact or a duplicate booking would loop four more times and then report the
 * wrong reason.
 */
export async function createTicketWithUniqueNumber<T>(
  insert: (ticketNumber: string) => Promise<T>,
  prefix = 'TCK',
  attempts = 5
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await insert(generateTicketNumber(prefix));
    } catch (err: any) {
      const target = err?.meta?.target;
      const onTicketNumber =
        err?.code === 'P2002' &&
        (target === undefined ||
          (Array.isArray(target) ? target.includes('ticketNumber') : String(target).includes('ticketNumber')));
      if (!onTicketNumber) throw err;
      lastError = err;
    }
  }
  throw lastError;
}
