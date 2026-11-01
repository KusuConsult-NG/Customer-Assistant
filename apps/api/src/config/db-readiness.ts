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
/**
 * Has the constraint been seen to exist?
 *
 * Boot can finish WITHOUT an answer — when the database cannot be reached at
 * all — and in that case the instance must not serve bookings. The readiness
 * probe reads this and keeps answering 503 until a real verification succeeds,
 * so an unreachable database degrades to "not ready" instead of "started, and
 * quietly unverified".
 */
let verified = false;
let unverifiedReason: string | null = null;

export function bookingGuaranteeStatus(): { verified: boolean; reason: string | null } {
  return { verified, reason: unverifiedReason };
}

/** For tests: forget what a previous run concluded. */
export function resetBookingGuaranteeStatus(): void {
  verified = false;
  unverifiedReason = null;
}

/** Ask the database once. Returns null when the question could not be asked. */
async function constraintPresent(): Promise<boolean | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
      `SELECT 1 AS one FROM pg_constraint WHERE conname = 'bookings_no_staff_overlap'`
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return null;
  }
}

/**
 * Re-ask, for the readiness probe.
 *
 * A database that was unreachable at boot may be reachable a few seconds
 * later — a paused Supabase project waking, a pooler restarting — and the
 * instance should become ready on its own rather than needing a redeploy. But
 * it only becomes ready on a REAL answer: if the constraint turns out to be
 * missing, this stays unverified and the probe stays red, which is the same
 * refusal the boot check makes, just arrived at later.
 */
export async function reverifyBookingGuarantee(): Promise<boolean> {
  if (verified) return true;
  const present = await constraintPresent();
  if (present === true) {
    verified = true;
    unverifiedReason = null;
    logger.log('booking_overlap_constraint verified — concurrent double-booking is impossible');
    return true;
  }
  unverifiedReason =
    present === false
      ? 'bookings_no_staff_overlap is missing from this database'
      : 'the database could not be reached';
  return false;
}

/**
 * What a connection failure most likely means.
 *
 * The driver's message is accurate and unhelpful: an operator reading
 * "Could not verify database guarantees: … tenant/user postgres.abcd not
 * found" in a crash loop reasonably concludes the booking migration is the
 * problem, because that is what this check is named after. It is not — that
 * message comes from Supabase's connection pooler and means it has no tenant
 * matching the user in the connection string.
 *
 * So the cause is named, with what to check, and the DSN is reported as
 * user@host only. Never the whole URL: a PostgreSQL DSN carries the password,
 * and this goes to a log an operator may paste into an issue.
 */
function diagnose(message: string): string {
  const lines: string[] = [];

  try {
    const raw = process.env.DATABASE_URL;
    if (raw) {
      const url = new URL(raw);
      lines.push(`  connecting as: ${url.username || '(no user)'}@${url.hostname}:${url.port || '5432'}${url.pathname}`);
    } else {
      lines.push('  DATABASE_URL is not set at all.');
    }
  } catch {
    lines.push('  DATABASE_URL is set but is not a parseable URL.');
  }

  if (/tenant or user not found|tenant\/user .* not found/i.test(message)) {
    lines.push(
      '',
      "  This is Supabase's pooler refusing the connection, NOT a missing migration.",
      '  It means no tenant matches the user in DATABASE_URL. Check, in order:',
      '    1. the pooler HOST REGION matches the project — aws-0-<region>.pooler.supabase.com',
      '       for a project in another region returns exactly this error;',
      '    2. the project ref in the username (postgres.<project-ref>) is correct;',
      '    3. the project is not PAUSED or deleted (free projects pause when idle).'
    );
  } else if (/can't reach database server|cannot reach database server/i.test(message)) {
    // Prisma's own wording when the TCP connection never completes. Its
    // advice ("make sure your database server is running") is wrong for a
    // managed database: it IS running, and something about the address is
    // wrong — which is the one thing the operator can act on.
    lines.push(
      '',
      '  Nothing answered at that host and port. For a managed database that usually means',
      '  the HOST or PORT is wrong rather than the server being down — Supabase uses 6543',
      '  for the pooled connection and 5432 for the direct one, and the two are not',
      '  interchangeable. Check also that outbound access to that host is permitted.'
    );
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) {
    lines.push('', '  The host in DATABASE_URL does not resolve. Check it for a typo.');
  } else if (/ECONNREFUSED/i.test(message)) {
    lines.push('', '  Nothing is listening on that host and port.');
  } else if (/password authentication failed/i.test(message)) {
    lines.push('', '  The host answered and rejected the credentials in DATABASE_URL.');
  } else if (/does not exist/i.test(message)) {
    lines.push('', '  The host answered; the database or role named in DATABASE_URL does not exist.');
  }

  return lines.join('\n');
}

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
    // Deliberately unguaranteed is still SERVEABLE: the operator said so out
    // loud, and holding readiness red would stop a deployment that has
    // accepted the trade.
    verified = true;
    unverifiedReason = null;
    return;
  }

  // A few attempts, because a cold start is not a misconfiguration: a paused
  // Supabase project or a pooler coming back refuses connections for a few
  // seconds. Bounded, so a genuinely bad DSN is reported quickly rather than
  // holding the boot open.
  let present: boolean | null = null;
  let lastError = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const rows = await prisma.$queryRawUnsafe<Array<{ one: number }>>(
        `SELECT 1 AS one FROM pg_constraint WHERE conname = 'bookings_no_staff_overlap'`
      );
      present = Array.isArray(rows) && rows.length > 0;
      break;
    } catch (err: any) {
      lastError = String(err?.message ?? err);
      // Backoff is overridable so the suite does not spend six seconds
      // waiting out a failure it has already arranged.
      const base = Number(process.env.DB_READINESS_RETRY_MS ?? 1000);
      if (attempt < 4 && base > 0) await new Promise((r) => setTimeout(r, attempt * base));
    }
  }

  if (present === null) {
    // COULD NOT ASK — which is not evidence about the constraint.
    //
    // This used to `process.exit(1)` in production. With a permanently bad
    // connection string that is an endless crash loop, and the only thing the
    // platform reports is "No open ports detected" over a log line about
    // "database guarantees" — so the operator goes looking for a missing
    // migration while the actual fault is in DATABASE_URL.
    //
    // Starting is safe BECAUSE the guarantee is recorded as unverified: the
    // readiness probe answers 503 until a real verification succeeds, so the
    // instance takes no traffic and nothing books an appointment on an
    // unchecked constraint. An instance that listens and reports why is
    // diagnosable; one that never opens a port is not.
    verified = false;
    unverifiedReason = 'the database could not be reached at startup';
    const diagnosis = diagnose(lastError);
    const report =
      `Could not reach the database to verify the double-booking guarantee.\n\n` +
      `  driver said: ${lastError}\n${diagnosis}\n\n` +
      `  Starting anyway, but /api/health/ready will answer 503 and this instance will ` +
      `take no traffic until the database answers. No booking is written on an unverified ` +
      `constraint.\n`;
    if (inProduction) logger.error(report);
    else logger.warn(report);
    return;
  }

  if (present) {
    verified = true;
    unverifiedReason = null;
    logger.log('booking_overlap_constraint present — concurrent double-booking is impossible');
    return;
  }

  unverifiedReason = 'bookings_no_staff_overlap is missing from this database';

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
