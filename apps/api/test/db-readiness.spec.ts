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

// The enum check asks the GENERATED CLIENT what it declares, so the client is
// what has to be controllable here. `var` is hoisted above jest.mock, and the
// factory only runs when the code under test requires the module, by which
// point the assignment has happened.
// eslint-disable-next-line no-var, @typescript-eslint/no-explicit-any
var clientEnums: Record<string, any> = {};
jest.mock('@prisma/client', () => clientEnums);

/**
 * Mutates the mocked module IN PLACE. Jest caches what the factory returned on
 * the first require, so rebinding `clientEnums` leaves the code under test
 * holding the previous object — which is how two of these tests first passed
 * against whatever the preceding test had set.
 */
function setClientEnums(next: Record<string, unknown>): void {
  for (const k of Object.keys(clientEnums)) delete clientEnums[k];
  Object.assign(clientEnums, next);
}

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

describe('the enum-value boot check', () => {
  /**
   * The drift no health check can see. A column the database lacks breaks
   * reads at once; a VALUE it lacks breaks only the statement that writes it,
   * so the pod stays green while one path fails. `WHATSAPP_CLOUD` did exactly
   * that: PostgreSQL rejected the CallLog upsert, processCallEvent threw, and
   * the reply explaining the unanswered call never sent.
   *
   * Stubbed on both sides, because what matters is the DECISION — refuse in
   * production, warn elsewhere, never claim a check that did not run.
   */
  const realNodeEnv = process.env.NODE_ENV;
  let exit: jest.SpyInstance;
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  class ExitCalled extends Error {
    constructor(public code?: number) {
      super(`process.exit(${code})`);
    }
  }

  /** What the database holds, as pg_enum would report it. */
  const live = (rows: Array<[string, string]>) =>
    query.mockResolvedValue(rows.map(([type, label]) => ({ type, label })));

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ALLOW_MISSING_ENUM_VALUES;
    setClientEnums({ TelephonyProviderType: { TWILIO: 'TWILIO', WHATSAPP_CLOUD: 'WHATSAPP_CLOUD' } });
    exit = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code);
    }) as any);
    errorLog = jest.spyOn(require('@nestjs/common').Logger.prototype, 'error').mockImplementation(() => {});
    warnLog = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(require('@nestjs/common').Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (realNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = realNodeEnv;
  });

  const run = () => require('../src/config/db-readiness').assertDeclaredEnumsPresent();

  it('starts when every declared value is in the database', async () => {
    process.env.NODE_ENV = 'production';
    live([['TelephonyProviderType', 'TWILIO'], ['TelephonyProviderType', 'WHATSAPP_CLOUD']]);
    await expect(run()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });

  it('REFUSES to start in production when a value is missing, and names it', async () => {
    process.env.NODE_ENV = 'production';
    live([['TelephonyProviderType', 'TWILIO']]);
    await expect(run()).rejects.toThrow(/process.exit\(1\)/);
    const said = errorLog.mock.calls.flat().join(' ');
    expect(said).toMatch(/TelephonyProviderType\.WHATSAPP_CLOUD/);
    // The remedy has to be in the message: this is read in a deploy log by
    // somebody who did not write the check.
    expect(said).toMatch(/db:sync-enums/);
  });

  it('warns and continues outside production, so a dev database can lag', async () => {
    process.env.NODE_ENV = 'development';
    live([['TelephonyProviderType', 'TWILIO']]);
    await expect(run()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    expect(warnLog.mock.calls.flat().join(' ')).toMatch(/TelephonyProviderType\.WHATSAPP_CLOUD/);
  });

  it('reports an absent TYPE and does not pretend it can create one', async () => {
    process.env.NODE_ENV = 'production';
    live([['SomeOtherEnum', 'X']]);
    await expect(run()).rejects.toThrow(/process.exit\(1\)/);
    const said = errorLog.mock.calls.flat().join(' ');
    expect(said).toMatch(/absent entirely: TelephonyProviderType/);
    expect(said).toMatch(/db:push/);
  });

  it('refuses rather than passing when it finds no enums to check', async () => {
    // A filter that silently matches nothing makes every assertion vacuously
    // true, which is the shape of a check that has stopped checking.
    process.env.NODE_ENV = 'production';
    setClientEnums({ SortOrder: { asc: 'asc', desc: 'desc' }, ContactScalarFieldEnum: { id: 'id' } });
    live([['TelephonyProviderType', 'TWILIO']]);
    await expect(run()).rejects.toThrow(/process.exit\(1\)/);
    expect(errorLog.mock.calls.flat().join(' ')).toMatch(/no enums in the generated client/i);
    // And it must not have claimed the database was fine.
    expect(errorLog.mock.calls.flat().join(' ')).not.toMatch(/match the database/);
  });

  it('skips the check only when told to, out loud', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOW_MISSING_ENUM_VALUES = '1';
    live([['TelephonyProviderType', 'TWILIO']]);
    await expect(run()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(warnLog.mock.calls.flat().join(' ')).toMatch(/ALLOW_MISSING_ENUM_VALUES=1/);
  });

  it('does not treat Prisma\u2019s own generated enums as schema enums', async () => {
    process.env.NODE_ENV = 'production';
    setClientEnums({
      TelephonyProviderType: { TWILIO: 'TWILIO' },
      SortOrder: { asc: 'asc', desc: 'desc' },
      QueryMode: { default: 'default', insensitive: 'insensitive' },
      ModelName: { Contact: 'Contact' },
      ContactScalarFieldEnum: { id: 'id', organizationId: 'organizationId' },
    });
    live([['TelephonyProviderType', 'TWILIO']]);
    // Only TelephonyProviderType is a schema enum, and it matches — so a
    // client whose internals are absent from pg_enum must still boot.
    await expect(run()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
  });
});
