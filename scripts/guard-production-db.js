/**
 * Refuse to run destructive tooling against a hosted database.
 *
 * Why this exists: the test harness, the probes and the Jest suite create real
 * organizations through the real API — that is precisely why they catch bugs
 * that mocks do not. Pointed at production once, they left 358 test
 * organizations and ~13,900 contacts in the live CRM, and cleaning that up
 * meant hand-written SQL against the production database.
 *
 * Nothing here inspects credentials or contacts the server. It reads the host
 * out of DATABASE_URL and compares it against the managed-Postgres providers.
 * A local database is the default assumption; anything remote must be opted
 * into out loud.
 *
 * Seeding production IS a legitimate operation, so this is a speed bump and
 * not a wall:
 *
 *   ALLOW_PRODUCTION_DB=1 npm run db:seed:gatekipa
 *
 * Usage:
 *   node scripts/guard-production-db.js "the verification suite"   (CLI, exits 1)
 *   require('./guard-production-db').assertLocalDatabase('the seed')
 */

const HOSTED_PROVIDERS = [
  { pattern: /supabase\.(com|co)/i, name: 'Supabase' },
  { pattern: /rds\.amazonaws\.com/i, name: 'Amazon RDS' },
  { pattern: /neon\.(tech|db)/i, name: 'Neon' },
  { pattern: /render\.com/i, name: 'Render' },
  { pattern: /planetscale/i, name: 'PlanetScale' },
  { pattern: /cockroachlabs\.cloud/i, name: 'CockroachDB Cloud' },
  { pattern: /\.azure\.com/i, name: 'Azure' },
  { pattern: /cloudsql/i, name: 'Cloud SQL' },
  { pattern: /digitalocean\.com/i, name: 'DigitalOcean' },
  { pattern: /heroku/i, name: 'Heroku' },
];

const OVERRIDE = 'ALLOW_PRODUCTION_DB';

/** Strip credentials so a blocked URL can be printed in a log or a terminal. */
function maskUrl(url) {
  return String(url).replace(/:\/\/[^@/]*@/, '://***@');
}

/** The provider this URL points at, or null when it looks local. */
function hostedProvider(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = String(url); // unparseable — match against the raw string instead
  }
  if (/^(localhost|127\.0\.0\.1|::1|0\.0\.0\.0)$/i.test(host)) return null;
  return HOSTED_PROVIDERS.find((p) => p.pattern.test(host))?.name ?? null;
}

/**
 * Exit the process unless DATABASE_URL looks local — or the override is set.
 * `purpose` completes the sentence "<purpose> writes to the database".
 */
function assertLocalDatabase(purpose = 'this script') {
  const url = process.env.DATABASE_URL;
  const provider = hostedProvider(url);
  if (!provider) return;

  if (process.env[OVERRIDE]) {
    console.warn(
      `\n⚠  ${OVERRIDE} is set — running ${purpose} against ${provider}: ${maskUrl(url)}\n`
    );
    return;
  }

  console.error(
    `\n✗ Refusing to run ${purpose} against a hosted database.\n` +
      `\n  DATABASE_URL → ${provider}: ${maskUrl(url)}\n` +
      `\n  This writes real rows. The harness and probes register organizations\n` +
      `  through the real API; pointed at production once they left 358 test\n` +
      `  organizations and ~13,900 contacts in the live CRM.\n` +
      `\n  Point .env at a local database:\n` +
      `      mv .env .env.production.backup && cp .env.example .env\n` +
      `\n  Or, if you really do mean this database:\n` +
      `      ${OVERRIDE}=1 <your command>\n`
  );
  process.exit(1);
}

module.exports = { assertLocalDatabase, hostedProvider, maskUrl };

if (require.main === module) {
  assertLocalDatabase(process.argv[2] || 'this script');
}
