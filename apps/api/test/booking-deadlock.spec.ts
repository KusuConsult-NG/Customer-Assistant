/**
 * Deadlock handling on booking writes.
 *
 * The eight-simultaneous-callers test proved the exclusion constraint keeps one
 * slot to one booking. It did NOT prove the seven losers are told the truth,
 * and under real contention they were not: PostgreSQL resolves a pile-up on the
 * GiST exclusion constraint by killing one transaction with SQLSTATE 40P01, and
 * a deadlock is not an exclusion violation. Those callers fell past the conflict
 * mapping into the generic failure path and heard "I ran into a technical
 * problem, let me get a colleague" — when the only thing that had happened was
 * that somebody else booked first.
 *
 * That failure is timing-dependent, so it cannot be pinned by racing the
 * database and hoping. These tests drive the classifier and the retry directly
 * with synthetic errors, which is deterministic and states the contract:
 *
 *   deadlock  → roll back, retry, let the constraint decide
 *   conflict  → answer immediately, never retry
 *   anything else → propagate untouched, first time
 */
import { isDeadlock, isOverlapViolation, withDeadlockRetry } from '../src/scheduling/scheduling.service';

const deadlockError = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
const overlapError = () =>
  Object.assign(new Error('conflicting key value violates exclusion constraint "bookings_no_staff_overlap"'), {
    code: '23P01',
  });

describe('isDeadlock', () => {
  it('recognises the SQLSTATE and the message independently', () => {
    expect(isDeadlock({ code: '40P01' })).toBe(true);
    // Prisma does not always surface the SQLSTATE, hence the message check.
    expect(isDeadlock(new Error('deadlock detected while checking exclusion constraint'))).toBe(true);
    expect(isDeadlock({ meta: { code: '40P01' } })).toBe(true);
  });

  it('does not mistake a slot conflict for a deadlock', () => {
    expect(isDeadlock(overlapError())).toBe(false);
    expect(isDeadlock(new Error('connection refused'))).toBe(false);
    expect(isDeadlock(undefined)).toBe(false);
  });

  it('stays disjoint from the conflict classifier', () => {
    // If a single error satisfied both, the retry would swallow a real conflict
    // and the caller would wait through pointless attempts for a slot that is
    // definitively gone.
    expect(isOverlapViolation(deadlockError())).toBe(false);
    expect(isDeadlock(overlapError())).toBe(false);
  });
});

describe('withDeadlockRetry', () => {
  it('retries a deadlock and returns the write that eventually succeeds', async () => {
    let calls = 0;
    const result = await withDeadlockRetry(async () => {
      calls++;
      if (calls < 3) throw deadlockError();
      return 'booked';
    });

    expect(result).toBe('booked');
    expect(calls).toBe(3);
  });

  it('surfaces the conflict WITHOUT retrying — the answer is already known', async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(async () => {
        calls++;
        throw overlapError();
      })
    ).rejects.toThrow(/exclusion constraint/);

    // Exactly one attempt: the slot is taken, and re-asking cannot change that.
    expect(calls).toBe(1);
  });

  it('retries a deadlock into the conflict it was hiding', async () => {
    // The real sequence this exists for: the loser is killed to break the
    // deadlock, retries, and now meets the winner's committed row. The caller
    // gets "that time is taken" instead of "the system broke".
    let calls = 0;
    await expect(
      withDeadlockRetry(async () => {
        calls++;
        throw calls === 1 ? deadlockError() : overlapError();
      })
    ).rejects.toThrow(/exclusion constraint/);

    expect(calls).toBe(2);
  });

  it('gives up after the attempt budget rather than retrying forever', async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(async () => {
        calls++;
        throw deadlockError();
      }, 3)
    ).rejects.toThrow(/deadlock/);

    expect(calls).toBe(3);
  });

  it('propagates an unrelated failure on the first attempt', async () => {
    let calls = 0;
    await expect(
      withDeadlockRetry(async () => {
        calls++;
        throw new Error('database is down');
      })
    ).rejects.toThrow('database is down');

    expect(calls).toBe(1);
  });
});
