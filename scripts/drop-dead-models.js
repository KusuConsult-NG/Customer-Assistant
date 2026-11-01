#!/usr/bin/env node
/**
 * Drop `companies` and `calendar_integrations`, or refuse and say why.
 *
 * ── Why this is a script and not a hand-run psql ────────────────────────────
 *
 * `packages/database/prisma/migrations/.../drop_dead_company_and_calendar_models`
 * is a `DROP TABLE` with the precondition written in a comment at the top:
 * verify three counts are zero first, because "this migration cannot tell the
 * difference — it drops either way".
 *
 * A precondition an operator has to remember, under a `DROP TABLE` they are
 * running against production, is the kind of step that gets skipped at the end
 * of a long deploy. So it is enforced here instead: the counts are taken, and a
 * single non-zero one makes this REFUSE rather than drop. The destructive
 * version then needs both `--apply` and, if rows exist, an explicit
 * `--i-have-read-the-rows` — which exists so that dropping real data is
 * something somebody chose, not something a flag defaulted into.
 *
 * ── Why the tables are going ────────────────────────────────────────────────
 *
 * Neither model was ever referenced: no service read them, no controller
 * exposed them, no seed wrote them, and `Contact.companyId` was an optional
 * column with an index that nothing ever set. A model in the schema reads as a
 * feature. `CalendarIntegration` also held `accessToken`/`refreshToken` as
 * PLAINTEXT — the one exemption from this repo's encryption-at-rest rule,
 * granted precisely because nothing used it. A plaintext credential column
 * that exists for no reason is somewhere for credentials to end up later.
 *
 * ── Ordering ────────────────────────────────────────────────────────────────
 *
 * Run this BEFORE the next `db push` against the new schema. A push sees the
 * tables as removable and refuses without `--accept-data-loss`: a safe failure,
 * but a failure that stops a deploy.
 *
 * Usage:
 *   node scripts/drop-dead-models.js                 # report, change nothing
 *   node scripts/drop-dead-models.js --apply         # drop, if the tables are empty
 *   node scripts/drop-dead-models.js --apply --i-have-read-the-rows
 *
 * A database created by `db push` against the current schema never had these
 * tables, so this reports "already absent" and exits 0. That is the expected
 * result in development and in CI.
 */

const path = require('path');
const fs = require('fs');

// Load .env the same way the other scripts do — parsed as text, never executed,
// because a password containing ( ) * ! or a space is legal in a .env and a
// syntax error in a shell.
const ROOT = path.resolve(__dirname, '..');
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (process.env[k] === undefined) {
      process.env[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}

const { prisma } = require('@ace/database');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const acceptRows = args.includes('--i-have-read-the-rows');

/** Does a table exist in the public schema? */
async function tableExists(name) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
    name
  );
  return rows.length > 0;
}

async function columnExists(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    table,
    column
  );
  return rows.length > 0;
}

/** Row count, or null when the table is not there to count. */
async function countOf(name) {
  if (!(await tableExists(name))) return null;
  const rows = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM "${name}"`);
  return rows[0].n;
}

async function main() {
  console.log('\nDead models: companies, calendar_integrations\n');

  const companies = await countOf('companies');
  const calendars = await countOf('calendar_integrations');
  const hasCompanyId = await columnExists('contacts', 'companyId');
  const linkedContacts = hasCompanyId
    ? (await prisma.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "contacts" WHERE "companyId" IS NOT NULL`
      ))[0].n
    : null;

  const show = (label, value) =>
    console.log(`  ${label.padEnd(34)} ${value === null ? 'already absent' : value + ' row(s)'}`);

  show('companies', companies);
  show('calendar_integrations', calendars);
  show('contacts.companyId (set)', linkedContacts);

  if (companies === null && calendars === null && !hasCompanyId) {
    console.log('\nNothing to do — this database never had them. (A `db push` against the');
    console.log('current schema does not create them.)\n');
    return;
  }

  const rows = (companies ?? 0) + (calendars ?? 0) + (linkedContacts ?? 0);

  if (rows > 0 && !acceptRows) {
    // Refused, not dropped. The migration file cannot make this distinction;
    // that is the whole reason this script exists.
    console.error(
      '\nREFUSING: these tables are NOT empty. The schema change assumes nobody ever'
    );
    console.error('used them, and this database says otherwise — read the rows before deciding.\n');
    console.error('  Inspect:  SELECT * FROM companies LIMIT 20;');
    console.error('            SELECT * FROM calendar_integrations LIMIT 20;');
    console.error('            SELECT id, "companyId" FROM contacts WHERE "companyId" IS NOT NULL;\n');
    console.error('CalendarIntegration rows hold PLAINTEXT OAuth tokens. If any exist, revoke');
    console.error('them with the provider rather than only deleting the row.\n');
    console.error('To drop anyway, having read them:');
    console.error('  node scripts/drop-dead-models.js --apply --i-have-read-the-rows\n');
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to drop them.\n');
    return;
  }

  // One transaction: a half-dropped shape (column gone, table kept) is harder
  // to reason about than either end state.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_companyId_fkey"`
    ),
    prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "contacts_companyId_idx"`),
    prisma.$executeRawUnsafe(`ALTER TABLE "contacts" DROP COLUMN IF EXISTS "companyId"`),
    prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "companies"`),
    prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "calendar_integrations"`),
  ]);

  console.log(`\nDropped. ${rows > 0 ? `${rows} row(s) went with them, as instructed.` : 'Both tables were empty.'}\n`);
}

main()
  .catch((err) => {
    console.error('\nFailed:', err.message, '\n');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
