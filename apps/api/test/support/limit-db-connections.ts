/**
 * Cap the connection pool for a TEST process.
 *
 * `@ace/database` sizes its pool at 25 connections per process, which is the
 * right number for an API pod serving concurrent requests. It is the wrong
 * number for a Jest worker.
 *
 * On a 4-CPU machine Jest runs 3 workers. Three pools of 25 is 75, and the
 * API server under test holds up to 25 of its own — exactly the 100 that
 * PostgreSQL allows by default. So the suite sat on the limit, and whether it
 * tipped over depended on how many workers happened to have live pools at the
 * same moment. It surfaced as `FATAL: sorry, too many clients already` from
 * whichever suite drew the short straw, which reads like a fault in that
 * suite rather than a budget shared by all of them.
 *
 * 10 is enough for the concurrency tests to genuinely contend — eight
 * simultaneous bookings need more than a handful — and 3 × 10 alongside the
 * API's 25 leaves comfortable headroom.
 *
 * Runs as a `setupFiles` entry so it executes before any test imports
 * `@ace/database` and builds its client. An explicit value already in the
 * environment wins, so CI can raise it.
 */
process.env.DATABASE_CONNECTION_LIMIT = process.env.DATABASE_CONNECTION_LIMIT || '10';
