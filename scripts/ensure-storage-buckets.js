#!/usr/bin/env node
/**
 * Create the two storage buckets this platform needs, as PRIVATE.
 *
 *   node scripts/ensure-storage-buckets.js          # report what exists
 *   node scripts/ensure-storage-buckets.js --apply  # create what is missing
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The buckets were a manual step in a dashboard, written down in CLAUDE.md and
 * nowhere enforced. A deployment that skipped it looks fine until somebody
 * uploads a document or a citizen sends a selfie, and then fails with a
 * storage error that names neither the bucket nor the fix.
 *
 * The step is the same every time and the credentials to do it are already in
 * the environment, so there is no reason it should be done by hand.
 *
 * ── Why PRIVATE, deliberately ───────────────────────────────────────────────
 *
 * `onboarding-selfies` holds photographs of citizens and `knowledge-documents`
 * holds whatever an agency uploaded, which may be internal. Both are served
 * through short-lived signed URLs. A public bucket would make every object
 * readable by anyone who guesses a path, so this refuses to create one and
 * REPORTS a bucket it finds public rather than silently flipping it — changing
 * that is a decision with consequences for data already in there.
 */

const path = require('path');
require(path.join(__dirname, '..', 'apps', 'api', 'dist', 'config', 'load-env.js'));

const BUCKETS = [
  { id: 'knowledge-documents', why: 'uploaded knowledge documents' },
  { id: 'onboarding-selfies', why: 'citizen onboarding photographs' },
];

async function main() {
  const apply = process.argv.includes('--apply');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    console.error(
      '\nSUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set.\n\n' +
      'Without them this platform stores uploads on local disk instead, which is fine\n' +
      'for development and wrong for a deployment with more than one instance.\n'
    );
    process.exit(2);
  }

  // Both headers. With only the bearer token Supabase Storage answers 400/403
  // in a way that reads like a permissions problem rather than a missing key.
  const headers = { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' };
  const base = `${url.replace(/\/+$/, '')}/storage/v1`;

  const listed = await fetch(`${base}/bucket`, { headers });
  if (!listed.ok) {
    console.error(`\nCould not list buckets: HTTP ${listed.status} ${(await listed.text()).slice(0, 200)}\n`);
    process.exit(1);
  }
  const existing = await listed.json();
  const byId = new Map(existing.map((b) => [b.id ?? b.name, b]));

  console.log(`\nStorage at ${url}\n`);

  let missing = 0;
  let wrong = 0;

  for (const bucket of BUCKETS) {
    const found = byId.get(bucket.id);

    if (found && found.public === true) {
      wrong++;
      console.log(
        `PUBLIC    ${bucket.id} — holds ${bucket.why}, and anyone who guesses an object path can read it.\n` +
        `          Not changed automatically: objects are already in there and flipping it is a\n` +
        `          decision about them. Set it to private in the Supabase dashboard.`
      );
      continue;
    }

    if (found) {
      console.log(`OK        ${bucket.id} (private)`);
      continue;
    }

    missing++;
    if (!apply) {
      console.log(`MISSING   ${bucket.id} — for ${bucket.why}`);
      continue;
    }

    const created = await fetch(`${base}/bucket`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: bucket.id, name: bucket.id, public: false }),
    });
    if (created.ok) {
      console.log(`CREATED   ${bucket.id} (private)`);
    } else {
      const text = (await created.text()).slice(0, 200);
      // Someone else creating it between the list and the create is a success,
      // not a failure: the bucket exists, which is all this asks for.
      if (created.status === 409 || /already exists/i.test(text)) {
        console.log(`OK        ${bucket.id} (created by someone else just now)`);
      } else {
        console.log(`FAILED    ${bucket.id}: HTTP ${created.status} ${text}`);
        process.exitCode = 1;
      }
    }
  }

  if (!apply && missing > 0) {
    console.log(`\n${missing} bucket(s) missing. Re-run with --apply to create them.\n`);
  } else if (wrong > 0) {
    console.log('\nNothing uploads safely into a public bucket — fix the ones named above.\n');
  } else {
    console.log('\nBoth buckets exist and are private.\n');
  }
}

main().catch((err) => {
  console.error('\nFailed:', err?.message ?? err, '\n');
  process.exit(1);
});
