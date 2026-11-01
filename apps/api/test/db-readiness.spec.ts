/**
 * The boot check for a guarantee the schema cannot carry.
 *
 * `bookings_no_staff_overlap` is an `EXCLUDE USING gist` constraint and Prisma
 * cannot express EXCLUDE, so `db push` never creates it. A database can be
 * structurally complete, pass every query, boot the API and load the
 * dashboard — and still let concurrent bookings for one slot all succeed. That
 * exact bug shipped here once: eight simultaneous requests, eight CONFIRMED
 * bookings in one slot, every caller told their appointment was made.
 *
 * Nothing checked for it at startup. `npm run demo:readiness` did, which is a
 * script nobody runs in production.
 *
 * These tests stub the lookup because the real constraint cannot be dropped to
 * exercise the missing case — and the thing worth testing is the DECISION, not
 * the SQL: refuse in production, warn elsewhere, and let a deployment opt out
 * only by saying so out loud.
 */

jest.mock('@ace/database', () => ({
  prisma: { $queryRawUnsafe: jest.fn() },
}));

import { prisma } from '@ace/database';
import {
  assertDatabaseGuarantees,
  bookingGuaranteeStatus,
  resetBookingGuaranteeStatus,
  reverifyBookingGuarantee,
} from '../src/config/db-readiness';

const query = prisma.$queryRawUnsafe as jest.Mock;

describe('the booking-constraint boot check', () => {
  const realNodeEnv = process.env.NODE_ENV;
  const realOptOut = process.env.ALLOW_MISSING_BOOKING_CONSTRAINT;
  let exit: jest.SpyInstance;
  let errorLog: jest.SpyInstance;

  class ExitCalled extends Error {
    constructor(public code?: number) {
      super(`process.exit(${code})`);
    }
  }

  const realDsn = process.env.DATABASE_URL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALLOW_MISSING_BOOKING_CONSTRAINT;
    // The check caches what it concluded, so each test starts from "unknown".
    resetBookingGuaranteeStatus();
    // The real backoff is 1s/2s/3s between attempts; the suite has already
    // arranged the failure and should not wait it out.
    process.env.DB_READINESS_RETRY_MS = '0';
    // Throwing stops execution where the real exit would, so nothing after
    // the refusal runs in the test either.
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as any);
    errorLog = jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'error')
      .mockImplementation(() => {});
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
    if (realOptOut === undefined) delete process.env.ALLOW_MISSING_BOOKING_CONSTRAINT;
    else process.env.ALLOW_MISSING_BOOKING_CONSTRAINT = realOptOut;
    if (realDsn === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = realDsn;
    delete process.env.DB_READINESS_RETRY_MS;
  });

  it('starts when the constraint is there', async () => {
    process.env.NODE_ENV = 'production';
    query.mockResolvedValue([{ one: 1 }]);

    await expect(assertDatabaseGuarantees()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('REFUSES to start in production when it is missing', async () => {
    process.env.NODE_ENV = 'production';
    query.mockResolvedValue([]);

    // A container that will not boot is a loud, recoverable failure. One that
    // boots without this is found by two citizens arriving for one slot.
    await expect(assertDatabaseGuarantees()).rejects.toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('names the remedy rather than only the fault', async () => {
    process.env.NODE_ENV = 'production';
    query.mockResolvedValue([]);
    const errors: string[] = [];
    jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'error')
      .mockImplementation(((m: string) => errors.push(String(m))) as any);

    await expect(assertDatabaseGuarantees()).rejects.toThrow();

    // Whoever reads this log is mid-deployment and needs the command, not a
    // diagnosis they have to go and research.
    const logged = errors.join('\n');
    expect(logged).toContain('EXCLUDE USING');
    expect(logged).toContain('psql');
    expect(logged).toMatch(/caller is told their appointment was made/i);
  });

  it('warns and continues outside production, so a dev database still runs', async () => {
    process.env.NODE_ENV = 'development';
    query.mockResolvedValue([]);
    const warnings: string[] = [];
    jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(((m: string) => warnings.push(String(m))) as any);

    // Taking away a developer's ability to run the app is how a check like
    // this gets commented out.
    await expect(assertDatabaseGuarantees()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    expect(warnings.join('\n')).toMatch(/not production/i);
  });

  it('does NOT exit when the database is unreachable — it starts unverified', async () => {
    // This is the case that crash-looped a real deployment. The connection
    // string pointed at a Supabase pooler that answered "tenant/user … not
    // found", this check exited 1, and the only thing the platform reported
    // was "No open ports detected" above a log line about "database
    // guarantees" — sending the operator after a migration when the fault was
    // in DATABASE_URL.
    process.env.NODE_ENV = 'production';
    query.mockRejectedValue(new Error('FATAL: (ENOTFOUND) tenant/user postgres.abcdefgh not found'));

    await expect(assertDatabaseGuarantees()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();

    // Starting is only safe because the guarantee is recorded as unverified.
    expect(bookingGuaranteeStatus().verified).toBe(false);
  });

  it('names the pooler, not the migration, when that is what refused', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://postgres.abcdefgh:s3cr3t-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
    query.mockRejectedValue(new Error('FATAL: (ENOTFOUND) tenant/user postgres.abcdefgh not found'));

    await assertDatabaseGuarantees();

    const reported = errorLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(reported).toMatch(/pooler refusing the connection, NOT a missing migration/i);
    expect(reported).toMatch(/HOST REGION/);
    expect(reported).toMatch(/PAUSED/);

    // The DSN is reported as user@host so the operator can see what it tried —
    // and the password is NOT in it. This log is the first thing pasted into
    // an issue.
    expect(reported).toContain('postgres.abcdefgh@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
    expect(reported).not.toContain('s3cr3t-password');
  });

  it("corrects Prisma's advice when a managed host does not answer", async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres';
    query.mockRejectedValue(
      new Error("Can't reach database server at `aws-0-us-east-1.pooler.supabase.com:6543`\n\nPlease make sure your database server is running")
    );

    await assertDatabaseGuarantees();

    // "Make sure your database server is running" is wrong for a managed
    // database — it is running, and the operator cannot act on that.
    const reported = errorLog.mock.calls.map((c: any) => String(c[0])).join('\n');
    expect(reported).toMatch(/HOST or PORT is wrong/);
    expect(reported).toMatch(/6543/);
  });

  it('still refuses to start when the database ANSWERS and the constraint is gone', async () => {
    // The distinction that matters: a real answer of "missing" is evidence
    // about the guarantee, and an unreachable database is not.
    process.env.NODE_ENV = 'production';
    query.mockResolvedValue([]);

    await expect(assertDatabaseGuarantees()).rejects.toThrow('process.exit(1)');
  });

  it('becomes ready on its own once a waking database answers', async () => {
    process.env.NODE_ENV = 'production';
    query.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    await assertDatabaseGuarantees();
    expect(bookingGuaranteeStatus().verified).toBe(false);

    // A paused project that wakes up should not need a redeploy.
    query.mockReset();
    query.mockResolvedValue([{ one: 1 }]);
    await expect(reverifyBookingGuarantee()).resolves.toBe(true);
    expect(bookingGuaranteeStatus().verified).toBe(true);
  });

  it('stays unverified when the late answer is that the constraint is missing', async () => {
    process.env.NODE_ENV = 'production';
    query.mockRejectedValue(new Error('Connection terminated unexpectedly'));
    await assertDatabaseGuarantees();

    query.mockReset();
    query.mockResolvedValue([]);
    await expect(reverifyBookingGuarantee()).resolves.toBe(false);
    expect(bookingGuaranteeStatus().verified).toBe(false);
    expect(bookingGuaranteeStatus().reason).toMatch(/missing/i);
  });

  it('treats the explicit opt-out as serveable, because the operator said so', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_MISSING_BOOKING_CONSTRAINT = '1';

    await assertDatabaseGuarantees();

    // Deliberately unguaranteed must not hold readiness red, or the opt-out
    // would stop the very deployment it exists to allow.
    expect(bookingGuaranteeStatus().verified).toBe(true);
  });


  it('lets a deployment opt out only by saying so explicitly', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_MISSING_BOOKING_CONSTRAINT = '1';
    query.mockResolvedValue([]);
    const warnings: string[] = [];
    jest
      .spyOn(require('@nestjs/common').Logger.prototype, 'warn')
      .mockImplementation(((m: string) => warnings.push(String(m))) as any);

    await expect(assertDatabaseGuarantees()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();

    // And it still says what has been given up, every boot. A silent opt-out
    // is the same hazard with a flag in front of it.
    expect(warnings.join('\n')).toMatch(/NOT enforced/i);
    // It should not even have asked the database.
    expect(query).not.toHaveBeenCalled();
  });
});
