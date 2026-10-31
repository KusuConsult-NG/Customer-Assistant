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
import { assertDatabaseGuarantees } from '../src/config/db-readiness';

const query = prisma.$queryRawUnsafe as jest.Mock;

describe('the booking-constraint boot check', () => {
  const realNodeEnv = process.env.NODE_ENV;
  const realOptOut = process.env.ALLOW_MISSING_BOOKING_CONSTRAINT;
  let exit: jest.SpyInstance;

  class ExitCalled extends Error {
    constructor(public code?: number) {
      super(`process.exit(${code})`);
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALLOW_MISSING_BOOKING_CONSTRAINT;
    // Throwing stops execution where the real exit would, so nothing after
    // the refusal runs in the test either.
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as any);
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
    if (realOptOut === undefined) delete process.env.ALLOW_MISSING_BOOKING_CONSTRAINT;
    else process.env.ALLOW_MISSING_BOOKING_CONSTRAINT = realOptOut;
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

  it('refuses in production when it cannot even ask', async () => {
    process.env.NODE_ENV = 'production';
    query.mockRejectedValue(new Error('connection refused'));

    // The app cannot serve without a database anyway; exiting lets the
    // orchestrator restart and retry rather than leaving a process up that
    // answers every request with an error.
    await expect(assertDatabaseGuarantees()).rejects.toThrow('process.exit(1)');
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
