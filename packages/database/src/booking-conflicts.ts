/**
 * Telling apart the two ways a booking write fails under contention.
 *
 * These live in `@ace/database` rather than in the API because BOTH engines
 * write bookings — the API's `SchedulingService` for the dashboard and the
 * agent tools, and the orchestrator when it moves an appointment for a customer
 * on WhatsApp. A second copy would be a second thing to keep correct, and the
 * consequence of getting it wrong is a customer being told the system broke
 * when their slot was merely taken, or told their appointment moved when it did
 * not.
 *
 * The distinction is not cosmetic:
 *
 *   - 23P01 (exclusion_violation) means the slot IS taken. Say so, offer others.
 *   - 40P01 (deadlock_detected) means the write was CONTENDED and rolled back.
 *     Nothing was written, so retrying is safe — and retrying is the only way
 *     to find out which of the two answers is actually true.
 *
 * Eight simultaneous requests reproduced the second one: one won, and the other
 * seven were told there had been a technical problem rather than that the time
 * was taken.
 */

/**
 * True when PostgreSQL rejected a write because of the booking exclusion
 * constraint. Prisma surfaces 23P01 without a dedicated error code, so the
 * constraint name and the generic phrasing are matched as well.
 */
export function isOverlapViolation(err: any): boolean {
  const code = err?.code ?? err?.meta?.code;
  const message = String(err?.message ?? '');
  return code === '23P01'
    || message.includes('bookings_no_staff_overlap')
    || message.includes('exclusion constraint');
}

/** True when PostgreSQL aborted the write to break a deadlock (SQLSTATE 40P01). */
export function isDeadlock(err: any): boolean {
  const code = err?.code ?? err?.meta?.code;
  const message = String(err?.message ?? '');
  return code === '40P01' || /deadlock detected/i.test(message);
}

/**
 * Run a booking write, retrying only the deadlock case.
 *
 * A deadlock abort rolls the whole transaction back, so nothing was written and
 * re-running is safe. Retrying lets the constraint decide: the attempt either
 * succeeds (the slot really was free) or raises the exclusion violation the
 * caller should hear about. Every other error propagates untouched on the first
 * try.
 */
export async function withDeadlockRetry<T>(write: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err: any) {
      if (!isDeadlock(err) || attempt >= attempts) throw err;
      // Jittered, so retries of a pile-up do not re-collide in lockstep.
      await new Promise((r) => setTimeout(r, 15 * attempt + Math.floor(Math.random() * 25)));
    }
  }
}
