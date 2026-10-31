import { Logger } from '@nestjs/common';
import { prisma } from '@ace/database';

const logger = new Logger('DatabaseReadiness');

/**
 * The guarantee this application cannot make for itself.
 *
 * ── Why a boot check, and why it can stop a deployment ──────────────────────
 *
 * `bookings_no_staff_overlap` is a PostgreSQL `EXCLUDE USING gist` constraint,
 * and Prisma cannot express EXCLUDE — so `db push` does not create it. It
 * exists only in a migration file that an operator has to apply by hand.
 *
 * Miss that step and nothing complains. The schema is complete, every query
 * works, the API boots, the dashboard loads. The only difference is that
 * concurrent bookings for the same slot all succeed: this repo has already
 * shipped that once, and eight simultaneous requests produced eight CONFIRMED
 * bookings in one slot with every caller told their appointment was made.
 * Application-level conflict checks are a read-then-write race; the
 * constraint is the whole guarantee.
 *
 * A system that silently tells several citizens they hold the same
 * appointment is not degraded, it is wrong — and it is wrong in exactly the
 * way invariant #1 forbids. So in production this refuses to start. A
 * container that will not boot is a loud, immediate, recoverable failure; a
 * container that boots without the constraint is a quiet one discovered by
 * two people turning up for the same slot.
 *
 * Outside production it warns instead and continues: a developer's database
 * may legitimately predate the migration, and taking away their ability to
 * run the app is how the check gets commented out.
 */
export async function assertDatabaseGuarantees(): Promise<void> {
  const inProduction = process.env.NODE_ENV === 'production';

  // An explicit, deliberate escape hatch. A deployment that genuinely does not
  // take bookings should be able to say so out loud rather than patching this
  // file — and the name makes what is being given up unambiguous.
  if (process.env.ALLOW_MISSING_BOOKING_CONSTRAINT === '1') {
    logger.warn(
      'ALLOW_MISSING_BOOKING_CONSTRAINT=1 — the double-booking guarantee is NOT enforced. ' +
        'Concurrent bookings for one slot can all succeed.'
    );
    return;
  }

  let present = false;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM pg_constraint WHERE conname = 'bookings_no_staff_overlap'`
    );
    present = Array.isArray(rows) && rows.length > 0;
  } catch (err: any) {
    // Could not ask. In production the app cannot serve without a database
    // anyway, so exiting lets the orchestrator restart and retry rather than
    // leaving a process up that answers every request with an error.
    const message = `Could not verify database guarantees: ${err?.message ?? err}`;
    if (inProduction) {
      logger.error(message);
      process.exit(1);
    }
    logger.warn(message);
    return;
  }

  if (present) {
    logger.log('booking_overlap_constraint present — concurrent double-booking is impossible');
    return;
  }

  const remedy =
    'bookings_no_staff_overlap is MISSING. `db push` cannot create it (Prisma cannot express ' +
    'EXCLUDE), so it must be applied from the migrations by hand:\n\n' +
    "  for m in $(grep -l 'EXCLUDE USING' packages/database/prisma/migrations/*/migration.sql | sort); do\n" +
    '    psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f "$m"\n' +
    '  done\n\n' +
    'Until it exists, concurrent bookings for the same slot all succeed and every ' +
    'caller is told their appointment was made.';

  if (inProduction) {
    logger.error(`Refusing to start.\n\n${remedy}\n`);
    process.exit(1);
  }

  logger.warn(`${remedy}\n\n(Starting anyway: NODE_ENV is not production.)`);
}
