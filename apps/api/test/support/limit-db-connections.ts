/**
 * Cap the connection pool for a TEST process.
 *
 * `@ace/database` sizes its pool at 25 connections per process, which is the
 * right number for an API pod serving concurrent requests. It is the wrong
 * number for a Jest worker.
 *
 * On a 4-CPU machine Jest runs 3 workers. Three pools of 25 is 75, and the API
 * server under test holds up to 25 of its own — exactly the 100 that PostgreSQL
 * allows by default. So the suite sat on the limit, and whether it tipped over
 * depended on how many workers happened to have a live pool at the same moment.
 * It surfaced as `FATAL: sorry, too many clients already` from whichever suite
 * drew the short straw, which reads like a fault in that suite rather than a
 * budget shared by all of them.
 *
 * ── Why 15, and not the 10 this used to say ─────────────────────────────────
 *
 * The real problem was never the size of each pool: Jest gives every test FILE
 * a fresh module registry, so each file built its own client and left its pool
 * open for the life of the worker. Thirteen files per worker is thirteen pools,
 * and shrinking each one only moved the ceiling. That is fixed where it
 * belongs, by releasing the pool when a file ends
 * (`release-db-connections.ts`), which brought the measured peak from 97
 * connections to 40.
 *
 * With one live pool per worker, 10 was then too SMALL: the booking-race tests
 * issue eight simultaneous requests, and a pool of ten leaves nothing for the
 * rest of the suite — so the eight queued instead of racing, and the test that
 * exists to prove the `EXCLUDE` constraint settles the race reported no
 * refusals at all. A failure there reads as "the constraint is gone", which is
 * the single most expensive thing in this repo to misdiagnose.
 *
 * 15 leaves the eight genuinely concurrent, and 3 × 15 alongside the API's 25
 * is 70 of the 100 available.
 *
 * Runs as a `setupFiles` entry so it executes before any test imports
 * `@ace/database` and builds its client. An explicit value already in the
 * environment wins, so CI can raise it.
 */
process.env.DATABASE_CONNECTION_LIMIT = process.env.DATABASE_CONNECTION_LIMIT || '15';
