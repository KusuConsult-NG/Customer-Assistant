/**
 * Hand back the database pool when a test file finishes.
 *
 * ── The bug this closes ─────────────────────────────────────────────────────
 *
 * Jest isolates every test FILE: a fresh module registry, a fresh `globalThis`,
 * even a fresh `process` shim. So `@ace/database`'s "singleton" is one client
 * per file, not one per process — and each of those clients opens a connection
 * pool that stays open for the life of the worker, because nothing disconnects
 * it. With 38 suites over 3 workers that is roughly thirteen pools per worker,
 * and PostgreSQL's default 100 connections ran out by arithmetic rather than by
 * load.
 *
 * It surfaced as `FATAL: sorry, too many clients already` from whichever suite
 * was unlucky enough to be running at the peak — selfie, voice-handoff, live,
 * different every run — which reads exactly like a fault in that suite and
 * sends you debugging the wrong file. Lowering `DATABASE_CONNECTION_LIMIT`
 * shrank each pool but not the NUMBER of pools, so it moved the ceiling closer
 * without removing it.
 *
 * ── Why it is registered here ───────────────────────────────────────────────
 *
 * A root-level `afterAll` from a `setupFilesAfterEnv` file runs AFTER the
 * suite's own `afterAll`, which is the only ordering that works: the suites
 * clean up their fixtures through this same client, and disconnecting first
 * would make them reconnect and leave a fresh pool open behind them.
 *
 * With this, at most one pool per worker is live at a time.
 */
afterAll(async () => {
  try {
    const { prisma } = require('@ace/database');
    await prisma.$disconnect();
  } catch {
    // A suite that never touched the database has nothing to release, and a
    // failure to disconnect must not turn a passing suite red.
  }
});
