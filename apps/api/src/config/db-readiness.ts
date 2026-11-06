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

/**
 * Every enum value the generated client knows about exists in the database.
 *
 * ── Why this is separate from the constraint check above ────────────────────
 *
 * A missing enum value is the quietest schema drift there is, and it is
 * quieter than a missing column. Prisma selects all mapped columns, so a
 * column the database lacks breaks unrelated READS at once and gets noticed
 * within a minute of a deploy. A value the database lacks breaks nothing until
 * something WRITES it — and then only that one statement, while every other
 * request on the deployment succeeds and every health check stays green.
 *
 * `WHATSAPP_CLOUD` is what that cost. It was added to TelephonyProviderType
 * and deployed, with `whatsapp.service.ts` writing it on every inbound
 * WhatsApp call event. Absent from the database, PostgreSQL rejected that
 * upsert, `processCallEvent` threw, and everything after it never ran —
 * including the reply telling the citizen why their call went unanswered. The
 * commit had been written to stop citizens getting silence, and produced it.
 *
 * `render.yaml` now runs `scripts/sync-enum-values.js --apply` as the api
 * service's preDeployCommand, so the values are added before this process
 * starts. This check is the backstop for the deploy paths that hook does not
 * cover — a Docker deploy, a plan without pre-deploy commands, a manual
 * start — because the whole point is that the failure is otherwise invisible.
 *
 * The declared list comes from the GENERATED CLIENT rather than by reading
 * schema.prisma at boot. The generated client is what the running code will
 * actually try to write, which is the thing that has to match the database; a
 * schema file read at runtime could be a different revision from the client
 * bundled into the build, and would be the wrong question.
 */
export async function assertDeclaredEnumsPresent(): Promise<void> {
  const inProduction = process.env.NODE_ENV === 'production';

  if (process.env.ALLOW_MISSING_ENUM_VALUES === '1') {
    logger.warn(
      'ALLOW_MISSING_ENUM_VALUES=1 — enum drift is NOT checked. A write of a value the ' +
        'database does not have will fail at the statement, and whatever follows it will not run.'
    );
    return;
  }

  // Prisma's own generated enums sit beside the schema's in the same module.
  // `*ScalarFieldEnum` is one per model, and the five named below are client
  // internals; everything else self-mapping is a schema enum.
  const PRISMA_INTERNAL = new Set([
    'TransactionIsolationLevel',
    'SortOrder',
    'QueryMode',
    'NullsOrder',
    'ModelName',
  ]);

  let declared: Map<string, string[]>;
  try {
    // Required lazily and from the generated package directly: this asks what
    // the CLIENT declares, and `@ace/database` re-exports it alongside its own
    // helpers, which would muddy the filter below.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const client = require('@prisma/client') as Record<string, unknown>;
    declared = new Map();
    for (const [name, value] of Object.entries(client)) {
      if (name.endsWith('ScalarFieldEnum') || PRISMA_INTERNAL.has(name)) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const keys = Object.keys(value as Record<string, unknown>);
      if (!keys.length) continue;
      // A generated enum maps every key to itself as a string. Nothing else
      // exported from the client does.
      if (!keys.every((k) => (value as Record<string, unknown>)[k] === k)) continue;
      declared.set(name, keys);
    }
  } catch (err: any) {
    const message = `Could not read the generated enums: ${err?.message ?? err}`;
    if (inProduction) {
      logger.error(message);
      process.exit(1);
    }
    logger.warn(message);
    return;
  }

  if (!declared.size) {
    // Finding nothing would make every assertion below vacuously true, which
    // is the shape of a check that silently stops checking.
    const message =
      'Found no enums in the generated client. The check cannot run, so it is not ' +
      'reporting that the database is in sync.';
    if (inProduction) {
      logger.error(`Refusing to start.\n\n${message}\n`);
      process.exit(1);
    }
    logger.warn(message);
    return;
  }

  let live: Map<string, Set<string>>;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ type: string; label: string }>>(
      `SELECT t.typname AS type, e.enumlabel AS label
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'`
    );
    live = new Map();
    for (const row of rows ?? []) {
      if (!live.has(row.type)) live.set(row.type, new Set());
      live.get(row.type)!.add(row.label);
    }
  } catch (err: any) {
    const message = `Could not verify enum values: ${err?.message ?? err}`;
    if (inProduction) {
      logger.error(message);
      process.exit(1);
    }
    logger.warn(message);
    return;
  }

  const missing: string[] = [];
  const absentTypes: string[] = [];
  for (const [name, values] of declared) {
    const have = live.get(name);
    if (!have) {
      absentTypes.push(name);
      continue;
    }
    for (const v of values) if (!have.has(v)) missing.push(`${name}.${v}`);
  }

  if (!missing.length && !absentTypes.length) {
    logger.log(`enum values present — ${declared.size} enum(s) match the database`);
    return;
  }

  const remedy =
    (missing.length ? `Enum values MISSING from the database: ${missing.join(', ')}.\n` : '') +
    (absentTypes.length ? `Enum types absent entirely: ${absentTypes.join(', ')}.\n` : '') +
    '\nA write of a missing value fails at that statement and nothing after it runs, ' +
    'while every other request succeeds — so this does not show up in a health check.\n\n' +
    'Add the values:\n\n  npm run db:sync-enums -- --apply\n\n' +
    'An absent TYPE needs the schema pushed instead (`npm run db:push`), because a new ' +
    'enum normally arrives with the model that uses it.';

  if (inProduction) {
    logger.error(`Refusing to start.\n\n${remedy}\n`);
    process.exit(1);
  }

  logger.warn(`${remedy}\n\n(Starting anyway: NODE_ENV is not production.)`);
}
