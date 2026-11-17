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
 * makes them useful to read; random bytes make a same-millisecond collision
 * improbable rather than certain; and the bounded retry turns the remaining
 * improbability into a different number rather than a lost ticket.
 *
 * ── Why FIVE random bytes and not three ─────────────────────────────────────
 *
 * Within one millisecond the timestamp is constant, so uniqueness rests
 * entirely on the random part, and the birthday bound — not the raw space —
 * decides it. Three bytes is 2^24 ≈ 16.7M values: across 5,000 references in a
 * single millisecond the expected number of collisions is 5000² / (2 · 2^24) ≈
 * 0.75, so a repeat is MORE LIKELY THAN NOT. CI found exactly that, returning
 * 4,999 distinct numbers from a 5,000 burst.
 *
 * Five bytes is 2^40 ≈ 1.1e12, which takes the same burst to ≈ 1.1e-5 — rare
 * enough that the retry stays the safety net it was meant to be rather than
 * part of normal operation. The cost is two extra characters in something a
 * customer reads back over the phone, which is worth it: the retry is bounded,
 * and a caller who exhausts it is told their complaint could not be filed.
 *
 * The prefix is a parameter because it carries meaning to staff: a refund
 * request is filed as REF-BK / REF-RS so it can be told apart from a support
 * ticket at a glance.
 */
import { randomBytes, randomInt } from 'crypto';

/*
 * ── FIVE DIGITS, by the agency's decision ───────────────────────────────────
 *
 * The time-ordered scheme above ("TCK-MI3K2Q1A-9F3C2B71D4") was collision-
 * proof and impossible to remember: callers were read a reference on the phone
 * and could not keep it. A citizen-facing reference is now five digits —
 * "48213" — read aloud digit by digit, and nothing in front of it. Refunds keep
 * their REF-BK / REF-RS label, which staff use to tell them from complaints.
 *
 * Five digits is 90,000 numbers (10000–99999, so it is always five when spoken)
 * shared across every agency, because `ticketNumber` is unique table-wide. The
 * first digit is never 0, so nobody hears "zero four eight…" and writes four
 * digits. Random, not sequential: a sequence needs a counter row every tenant
 * contends on, and a predictable number lets anyone guess somebody else's case.
 *
 * Collisions are handled the way they always were — a fresh number per retry —
 * and the length GROWS rather than the filing failing: a dozen tries at five
 * digits (each succeeds unless the table is nearly full), then six, then the
 * long form. Nobody is ever told their complaint could not be filed because the
 * short numbers ran out.
 */

/** Digits in a citizen-facing reference. */
export const REFERENCE_DIGITS = 5;

/** Tries at each length before a longer one is used. */
const ATTEMPTS_BY_DIGITS: Array<[digits: number, tries: number]> = [
  [5, 12],
  [6, 8],
];

/** Bytes of randomness in the long fallback form. See the birthday note above. */
const ENTROPY_BYTES = 5;

/** `digits` random digits, never starting with 0. */
function randomDigits(digits: number): string {
  return String(randomInt(10 ** (digits - 1), 10 ** digits));
}

/**
 * A reference: `48213` with no prefix, `REF-BK-48213` with one. `digits` of 0
 * gives the long, time-ordered form used only when the short ones are taken.
 */
export function generateTicketNumber(prefix = '', digits = REFERENCE_DIGITS): string {
  const body =
    digits > 0
      ? randomDigits(digits)
      : `${Date.now().toString(36).toUpperCase()}-${randomBytes(ENTROPY_BYTES).toString('hex').toUpperCase()}`;
  return prefix ? `${prefix}-${body}` : body;
}

/** The lengths tried, in order, ending with the long form. */
function lengthsToTry(attempts?: number): number[] {
  if (attempts !== undefined) return Array.from({ length: attempts }, () => REFERENCE_DIGITS);
  return [...ATTEMPTS_BY_DIGITS.flatMap(([d, n]) => Array.from({ length: n }, () => d)), 0, 0, 0];
}

/**
 * Insert a ticket, allocating a fresh number if the unique constraint bites.
 *
 * Takes a closure rather than data because the callers need different Prisma
 * options (one wants the contact included), and because retrying has to re-run
 * the insert with a NEW number — not retry the same one.
 *
 * A P2002 on any other field is rethrown untouched: retrying a duplicate
 * contact or a duplicate booking would loop and then report the wrong reason.
 * `attempts`, when given, fixes the number of five-digit tries (tests).
 */
export async function createTicketWithUniqueNumber<T>(
  insert: (ticketNumber: string) => Promise<T>,
  prefix = '',
  attempts?: number
): Promise<T> {
  let lastError: unknown;
  for (const digits of lengthsToTry(attempts)) {
    try {
      return await insert(generateTicketNumber(prefix, digits));
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
