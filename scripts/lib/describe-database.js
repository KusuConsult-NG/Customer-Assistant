/**
 * Which database is this script about to read or rewrite?
 *
 * ── The bug this exists to catch ────────────────────────────────────────────
 *
 * Twice in one project. A developer ran a script against a local database
 * carrying leftover `e2e-*` organizations, and nothing in the output said it
 * was not production — so the work went somewhere no citizen would ever read
 * it, with no error anywhere to explain why nothing changed.
 *
 * It happened again, worse, on the credential scripts. The API reported a
 * specific WhatsApp row as undecryptable; `npm run secrets:encrypt` reported
 * ZERO unreadable WhatsApp rows. Both cannot be true of one database, and
 * neither output named the database it was talking about — so the two
 * contradicted each other with no way to tell which was which, while the
 * obvious reading was that the API was wrong.
 *
 * That matters most on exactly these scripts: `secrets:encrypt --apply`
 * REWRITES credentials, and `user:password --apply` sets one and signs every
 * session out. Running either against the wrong database is not a wasted
 * afternoon.
 *
 * ── Why host, port and database name ONLY ───────────────────────────────────
 *
 * Never the user and never the password. This line is read in terminals,
 * pasted into chat and screenshotted — which is exactly how a production
 * password once ended up somewhere it could not be taken back from, in this
 * project, and why a rotation is still outstanding.
 */

/** `host:port/database`, from DIRECT_URL or DATABASE_URL. Never credentials. */
function describeDatabase() {
  const raw = process.env.DIRECT_URL || process.env.DATABASE_URL || '';
  if (!raw) return '(no DATABASE_URL or DIRECT_URL set)';
  try {
    const u = new URL(raw);
    return `${u.hostname}${u.port ? ':' + u.port : ''}${u.pathname}`;
  } catch {
    return '(could not parse the connection URL)';
  }
}

/**
 * True when this looks like a developer's own machine.
 *
 * Not a security control — it is a label, so a report that says "0 unreadable"
 * cannot be mistaken for a statement about production.
 */
function looksLocal() {
  const target = describeDatabase();
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|host\.docker\.internal)\b/.test(target);
}

/** One line, printed before a script reads or writes anything. */
function databaseBanner(mode) {
  const target = describeDatabase();
  const where = looksLocal() ? '  ← LOCAL machine, not production' : '';
  return `${mode}\n  database: ${target}${where}`;
}

module.exports = { describeDatabase, looksLocal, databaseBanner };
