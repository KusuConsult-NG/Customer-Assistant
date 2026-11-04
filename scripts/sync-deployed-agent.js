#!/usr/bin/env node
/**
 * Re-sync a DEPLOYED instance's hosted agent, over HTTP.
 *
 *   ACE_EMAIL=you@agency.gov.ng ACE_PASSWORD=… \
 *     node scripts/sync-deployed-agent.js https://ace-api-xxxx.onrender.com
 *
 * ── Why this and not scripts/sync-elevenlabs.js ─────────────────────────────
 *
 * That one talks to the database directly, so running it against a live
 * deployment means pointing a laptop's DATABASE_URL at production — which this
 * repository tells you not to do, for reasons it learned the hard way.
 *
 * This asks the deployment to sync ITSELF, through the same endpoint the
 * dashboard uses, with an ordinary owner or administrator sign-in. Nothing
 * local needs production credentials.
 *
 * ── Why you would run it ────────────────────────────────────────────────────
 *
 * A tool's PARAMETERS can change — `reference` was added to cancel-booking and
 * reschedule-booking so a citizen with two appointments can say which one they
 * mean. An agent provisioned before that has no way to send the new field, and
 * neither the tool count nor the URLs change, so nothing looked wrong until
 * the status check learned to compare parameters. This is the fix for it.
 *
 * It reports the drift AFTER syncing, from a fresh read, so the answer is what
 * the workspace really holds rather than what the sync intended.
 */

const BASE = (process.argv[2] || process.env.ACE_BASE_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.ACE_EMAIL;
const PASSWORD = process.env.ACE_PASSWORD;

if (!BASE || !EMAIL || !PASSWORD) {
  console.error(
    '\nUsage: ACE_EMAIL=… ACE_PASSWORD=… node scripts/sync-deployed-agent.js https://your-api.example.com\n\n' +
    'The sign-in must be an OWNER or ADMIN of the agency whose agent you are syncing.\n'
  );
  process.exit(2);
}

async function req(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

(async () => {
  console.log(`\nSyncing the hosted agent on ${BASE}\n`);

  const login = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) {
    console.error(`Sign in failed: HTTP ${login.status} ${JSON.stringify(login.body).slice(0, 200)}\n`);
    process.exit(1);
  }
  const auth = { Authorization: `Bearer ${login.body.accessToken}` };
  console.log(`Signed in as ${login.body.user?.email} (${login.body.user?.role})`);

  const sync = await req('/api/agent-provisioning/sync', { method: 'POST', headers: auth });
  if (!sync.ok) {
    const msg = typeof sync.body === 'object' ? sync.body.message || JSON.stringify(sync.body) : sync.body;
    console.error(`\nSync failed: HTTP ${sync.status}\n${String(msg).slice(0, 400)}\n`);
    process.exit(1);
  }

  for (const step of sync.body.steps ?? []) {
    console.log(`  ${String(step.action).padEnd(10)} ${step.target}${step.id ? ` ${step.id}` : ''}`);
  }

  // Read it back. A sync that reports success is an intention; the status is
  // the record — and this is the only way to learn whether the workspace
  // honoured the empty `prompt.tools` the sync sends to clear inline tools.
  const status = await req('/api/agent-provisioning/status', { headers: auth });
  if (!status.ok) {
    console.error(`\nSynced, but the status could not be read: HTTP ${status.status}\n`);
    process.exit(1);
  }

  const drift = Array.isArray(status.body.drift) ? status.body.drift : [];
  console.log(
    `\nagent=${status.body.agentId} tools=${status.body.toolCount}/${status.body.expectedToolCount}`
  );

  if (drift.length === 0) {
    console.log('\nNo drift. The deployed agent matches this repository.\n');
    return;
  }

  console.log(`\n${drift.length} thing(s) still differ after the sync:\n`);
  for (const d of drift) console.log(`  · ${d}`);
  console.log('');
  process.exitCode = 1;
})().catch((err) => {
  console.error('\nFailed:', err?.message ?? err, '\n');
  process.exit(1);
});
