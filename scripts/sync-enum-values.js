#!/usr/bin/env node
/**
 * Add enum values that schema.prisma declares and the database does not have.
 *
 *   node scripts/sync-enum-values.js            # report, change nothing
 *   node scripts/sync-enum-values.js --apply    # add the missing values
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * A new enum VALUE fails differently from a new column, and far more quietly.
 * Prisma selects all mapped columns, so a missing column breaks unrelated
 * reads loudly and immediately. A missing enum value breaks nothing until
 * something WRITES it — and then only that one write, with everything else on
 * the deployment working perfectly.
 *
 * That is what `WHATSAPP_CLOUD` did. It was added to
 * `TelephonyProviderType` in 4c3bbcf and deployed, while
 * `whatsapp.service.ts` writes `provider: 'WHATSAPP_CLOUD'` on every inbound
 * WhatsApp call event. With the value absent from the database, PostgreSQL
 * rejects that one upsert, `processCallEvent` throws, and everything after it
 * never runs — including the message that tells the citizen why their call was
 * not answered. A citizen who phoned got silence, which is the exact failure
 * the commit was written to remove.
 *
 * `render.yaml` has `autoDeploy: true` and no migration step: the build runs
 * `prisma generate` against a dummy URL and never touches the real database.
 * So the enum value and the code that writes it could not arrive together, and
 * nothing in the pipeline said so.
 *
 * ── Why ADD VALUE rather than `db push` ────────────────────────────────────
 *
 * `db push` reconciles the WHOLE schema and can drop columns and tables; it
 * wants `--accept-data-loss` for exactly the cases nobody should run
 * unattended against production. This does one thing, cannot delete anything,
 * and is idempotent, so it is safe to run on every deploy.
 *
 * A type that is missing ENTIRELY is reported and not created: a new enum
 * usually arrives with the model that uses it, and that is a `db push`
 * decision for a person, not a side effect of a deploy.
 */

const path = require('path');
const fs = require('fs');

try {
  require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));
} catch {
  // Built output is absent in some contexts; the environment may already carry
  // DATABASE_URL. Reported below if it does not.
}

const { PrismaClient } = require('@prisma/client');

const APPLY = process.argv.includes('--apply');
const SCHEMA =
  process.argv.find((a) => a.startsWith('--schema='))?.slice('--schema='.length) ||
  path.join(__dirname, '..', 'packages', 'database', 'prisma', 'schema.prisma');

/** Postgres identifiers and enum labels we are willing to interpolate. */
const SAFE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function enumsFromSchema(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = new Map();
  for (const m of src.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const name = m[1];
    const values = m[2]
      .split('\n')
      .map((l) => l.split('//')[0].trim())
      .filter(Boolean)
      // A value line is a bare identifier. Anything with an attribute or
      // punctuation is not one, and an @map would mean the DB label differs
      // from the name — none do today, and this refuses to guess if that
      // changes.
      .filter((l) => {
        if (SAFE.test(l)) return true;
        if (l.includes('@map')) {
          throw new Error(
            `enum ${name} has an @map'd value (${l}). The database label differs ` +
            `from the schema name, so this script would add the wrong one. Add it by hand.`
          );
        }
        return false;
      });
    if (values.length) out.set(name, values);
  }
  return out;
}

(async () => {
  if (!process.env.DATABASE_URL && !process.env.DIRECT_URL) {
    console.error('DATABASE_URL (or DIRECT_URL) is not set. Nothing to check against.');
    process.exit(1);
  }

  const declared = enumsFromSchema(SCHEMA);

  // DDL goes down DIRECT_URL, not DATABASE_URL.
  //
  // The datasource sets `url = DATABASE_URL` and `directUrl = DIRECT_URL`, and
  // `directUrl` is read by `prisma migrate` ONLY — a PrismaClient built with no
  // argument uses the pooler. At runtime that is correct and deliberate
  // (Supavisor in transaction mode, port 6543, pgbouncer=true), but it is the
  // wrong end for `ALTER TYPE`: transaction-mode pooling hands each statement
  // whichever backend is free, which is not where DDL belongs.
  //
  // So prefer DIRECT_URL, exactly as a migration would, and fall back to
  // DATABASE_URL only when no direct URL is configured — a local database where
  // both point at the same server.
  const ddlUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;
  const usingPooler = !process.env.DIRECT_URL;
  const prisma = new PrismaClient({ datasourceUrl: ddlUrl });
  let added = 0;
  let failed = 0;
  // Counted separately from `added`: in report mode nothing is added, and a
  // summary driven by `added` alone printed "Nothing to do" directly beneath
  // the list of values it had just reported as missing.
  let missingValues = 0;
  const missingTypes = [];

  try {
    const rows = await prisma.$queryRaw`
      SELECT t.typname AS type, e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
    `;

    const live = new Map();
    for (const r of rows) {
      if (!live.has(r.type)) live.set(r.type, new Set());
      live.get(r.type).add(r.label);
    }

    console.log(
      `${APPLY ? 'APPLY' : 'REPORT ONLY'} — ${declared.size} enum(s) declared in ` +
      `${path.relative(process.cwd(), SCHEMA)}\n` +
      `  connection: ${usingPooler ? 'DATABASE_URL (no DIRECT_URL set)' : 'DIRECT_URL'}\n`
    );

    for (const [name, values] of declared) {
      if (!live.has(name)) {
        missingTypes.push(name);
        continue;
      }
      const have = live.get(name);
      const gaps = values.filter((v) => !have.has(v));
      if (!gaps.length) continue;

      for (const v of gaps) {
        if (!SAFE.test(name) || !SAFE.test(v)) {
          console.error(`  REFUSED  ${name}.${v} — unsafe identifier, not interpolating it`);
          failed++;
          continue;
        }
        if (!APPLY) {
          console.log(`  MISSING  ${name}.${v}`);
          missingValues++;
          continue;
        }
        try {
          // ADD VALUE IF NOT EXISTS is idempotent and cannot remove anything.
          await prisma.$executeRawUnsafe(
            `ALTER TYPE "public"."${name}" ADD VALUE IF NOT EXISTS '${v}'`
          );
          console.log(`  ADDED    ${name}.${v}`);
          added++;
        } catch (err) {
          console.error(`  FAILED   ${name}.${v} — ${err.message.split('\n')[0]}`);
          failed++;
        }
      }
    }

    if (missingTypes.length) {
      console.log(
        `\n  ${missingTypes.length} enum TYPE(s) absent from the database: ${missingTypes.join(', ')}\n` +
        `  Not created here — a new enum normally arrives with the model that uses it,\n` +
        `  which is a \`npm run db:push\` decision for a person.`
      );
    }

    if (!added && !failed && !missingValues && !missingTypes.length) {
      console.log('  Every declared enum value is present. Nothing to do.');
    } else if (APPLY) {
      console.log(`\n  ${added} added, ${failed} failed.`);
    } else {
      console.log(
        `\n  ${missingValues} value(s) missing. Re-run with --apply to add them.`
      );
    }
  } finally {
    await prisma.$disconnect();
  }

  // Only a genuine SQL failure fails the run: a missing TYPE is reported and
  // deliberately left for a person, so it must not block a deploy.
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('enum sync failed:', err.message);
  process.exit(1);
});
