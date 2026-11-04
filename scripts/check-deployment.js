#!/usr/bin/env node
/**
 * Check a DEPLOYED instance, from a machine that can reach it.
 *
 * `npm run demo:readiness` inspects the deployment it is running inside.
 * This is its remote twin: it contacts a running instance over HTTP and
 * reports what that instance says about itself — so the person who can reach
 * the deployment gets the same picture as someone with a shell on it.
 *
 * Usage:
 *
 *   ACE_EMAIL=you@agency.gov.ng ACE_PASSWORD=… \
 *     node scripts/check-deployment.js https://ace-api-xxxx.onrender.com
 *
 * To also test that a provider key can be STORED (the check that fails when
 * ENCRYPTION_KEY is unset), add:
 *
 *   ELEVENLABS_KEY=sk_… ACE_EMAIL=… ACE_PASSWORD=… node scripts/check-deployment.js <url>
 *
 * Nothing is printed that would expose a secret: keys are reported by length
 * and last four characters only, the way the dashboard masks them.
 */

const BASE = (process.argv[2] || process.env.ACE_BASE_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.ACE_EMAIL;
const PASSWORD = process.env.ACE_PASSWORD;
const ELEVEN_KEY = process.env.ELEVENLABS_KEY;

if (!BASE) {
  console.error('Usage: node scripts/check-deployment.js https://your-api.example.com');
  console.error('       ACE_EMAIL / ACE_PASSWORD in the environment for the signed-in checks.');
  process.exit(2);
}

const results = [];
const say = (state, name, detail, fix) => {
  results.push({ state, name, detail, fix });
  const pad = name.padEnd(34);
  console.log(`${state.padEnd(9)} ${pad} ${detail}`);
  if (fix) console.log(`${' '.repeat(10)}${' '.repeat(34)}  → ${fix}`);
};

async function req(path, init = {}) {
  const url = `${BASE}${path}`;
  const started = Date.now();
  try {
    const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: res.ok, status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err?.cause?.code || err?.message || String(err), ms: Date.now() - started };
  }
}

(async () => {
  console.log(`\nCustomer Care Agent — deployment check\n${BASE}\n`);

  // ── 1. Is it up at all ────────────────────────────────────────────────────
  const health = await req('/api/health');
  if (!health.ok) {
    say('DOWN', 'API service', health.error ? `unreachable: ${health.error}` : `HTTP ${health.status}`,
      'Nothing below can run until the service answers. Check the Render logs and that the service is not asleep.');
    process.exit(1);
  }
  // A carrier gives a webhook ~10-15 seconds. A free-tier instance that has
  // spun down takes far longer to wake, so the first real call of the day is
  // dropped before the service answers — and the service looks healthy when
  // you check it by hand a moment later.
  const slow = health.ms > 10000;
  say(slow ? 'DEGRADED' : 'OK', 'API service', `HTTP 200 in ${health.ms}ms`,
    slow
      ? `${Math.round(health.ms / 1000)}s is a COLD START. Twilio and ElevenLabs time out well before that, so an inbound call to a sleeping instance is dropped. ` +
        `Two ways out: the Keep API warm workflow (.github/workflows/keep-warm.yml) pings this probe every 10 minutes so the instance never idles — set the API_BASE_URL repository variable to switch it on — or a plan that does not spin down, which is the only one that also survives a restart.`
      : null);

  // `/ready` is the one that refuses to pass without the double-booking
  // constraint in production — a green /health and a red /ready is exactly
  // the state where every concurrent booking silently succeeds.
  const ready = await req('/api/health/ready');
  say(ready.ok ? 'OK' : 'DOWN', 'Readiness probe',
    ready.ok ? 'ready to serve' : `HTTP ${ready.status}: ${JSON.stringify(ready.body).slice(0, 160)}`,
    ready.ok ? null : 'A failing readiness probe in production usually means the booking EXCLUDE constraint is missing. See packages/database/prisma/migrations.');

  if (!EMAIL || !PASSWORD) {
    console.log('\nSet ACE_EMAIL and ACE_PASSWORD to run the signed-in checks.\n');
    process.exit(0);
  }

  // ── 2. Sign in ────────────────────────────────────────────────────────────
  const login = await req('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!login.ok) {
    say('DOWN', 'Sign in', `HTTP ${login.status}: ${JSON.stringify(login.body).slice(0, 160)}`,
      'Everything below needs a session.');
    process.exit(1);
  }
  const token = login.body.accessToken;
  const auth = { Authorization: `Bearer ${token}` };
  say('OK', 'Sign in', `${login.body.user?.email} · role ${login.body.user?.role}`);

  // ── 3. Is the public URL actually public ──────────────────────────────────
  //
  // `webhookUrl` is built from API_BASE_URL. If it comes back as localhost or
  // a private address, every provider webhook points nowhere and agent
  // provisioning refuses outright — a deployment that looks configured and
  // answers no calls.
  const creds = await req('/api/agent-provisioning/credentials', { headers: auth });
  if (creds.ok) {
    const u = creds.body.webhookUrl || '';
    const privateUrl = /localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\b10\.|\b192\.168\.|\b172\.(1[6-9]|2\d|3[01])\./.test(u);
    say(privateUrl ? 'DOWN' : 'OK', 'Public base URL', u || '(none reported)',
      privateUrl ? 'API_BASE_URL is not public. Set it to this service\'s external URL, or every provider webhook points at the container itself.' : null);

    const mode = creds.body.mode;
    const warn = creds.body.warnings || [];
    say(creds.body.configured ? (warn.length ? 'DEGRADED' : 'OK') : 'DEGRADED',
      'ElevenLabs workspace',
      `mode=${mode} configured=${creds.body.configured} encryptedAtRest=${creds.body.encryptedAtRest} webhookSecret=${creds.body.webhookSecretConfigured}`,
      warn.length ? warn.join(' | ') : null);
  } else {
    say('DOWN', 'ElevenLabs workspace', `HTTP ${creds.status}: ${JSON.stringify(creds.body).slice(0, 200)}`);
  }

  // ── 4. Can a credential be STORED ─────────────────────────────────────────
  //
  // The check that fails when ENCRYPTION_KEY is unset. Storing is REFUSED
  // rather than written in the clear, so this is the difference between a key
  // that saves and one that throws — and nothing else in the deployment
  // reveals it.
  if (ELEVEN_KEY) {
    const put = await req('/api/agent-provisioning/credentials', {
      method: 'POST', headers: auth, body: JSON.stringify({ apiKey: ELEVEN_KEY }),
    });
    const msg = typeof put.body === 'object' ? (put.body.message || JSON.stringify(put.body)) : String(put.body);
    if (put.ok) {
      say('OK', 'Storing a provider key', `saved · ${ELEVEN_KEY.length} chars ending ${ELEVEN_KEY.slice(-4)}`);
    } else if (/ENCRYPTION_KEY/i.test(msg)) {
      say('DOWN', 'Storing a provider key', msg.slice(0, 200),
        'Set ENCRYPTION_KEY on the service: openssl rand -base64 32 (exactly 32 bytes — a wrong length is rejected, not stretched).');
    } else {
      say('DOWN', 'Storing a provider key', `HTTP ${put.status}: ${msg.slice(0, 200)}`);
    }
  } else {
    say('SKIP', 'Storing a provider key', 'ELEVENLABS_KEY not supplied',
      'Set ELEVENLABS_KEY to prove a credential can actually be saved.');
  }

  // ── 5. Does the agent answer ──────────────────────────────────────────────
  const status = await req('/api/agent-provisioning/status', { headers: auth });
  const smsg = typeof status.body === 'object' ? (status.body.message || JSON.stringify(status.body)) : String(status.body);
  if (status.ok) {
    // A 200 is not the same as a healthy agent. `getAgentStatus` is read-only
    // on purpose — repairing drift silently destroys the evidence of how it
    // happened — so it REPORTS the mismatch and something has to read it.
    // Truncating the JSON to 160 characters hid exactly that, and the line
    // said OK while the remote agent carried deprecated inline tools.
    const b = status.body || {};
    const drift = Array.isArray(b.drift) ? b.drift : [];
    const toolsWrong =
      typeof b.toolCount === 'number' &&
      typeof b.expectedToolCount === 'number' &&
      b.toolCount !== b.expectedToolCount;

    const summary =
      `agentId=${b.agentId ?? 'none'} remoteFound=${b.remoteAgentFound} ` +
      `tools=${b.toolCount}/${b.expectedToolCount}`;

    if (!b.configured || !b.remoteAgentFound) {
      say('DOWN', 'Hosted agent', summary,
        'No agent is provisioned in the workspace. POST /api/agent-provisioning/sync.');
    } else if (drift.length || toolsWrong) {
      say('DEGRADED', 'Hosted agent', summary,
        (drift.length ? drift.join(' | ') : '') +
        (toolsWrong ? ` | tool count does not match the catalogue (${b.toolCount} of ${b.expectedToolCount})` : ''));
    } else {
      say('OK', 'Hosted agent', summary);
    }
  } else if (/could not reach/i.test(smsg)) {
    // The wording matters: unreachable is a network fact, not a bad key.
    say('DOWN', 'Hosted agent', smsg.slice(0, 200),
      'The request never left the service. This is NOT a rejected key — check outbound network access.');
  } else {
    say('DEGRADED', 'Hosted agent', smsg.slice(0, 200),
      'ElevenLabs answered and refused. Check the key and the workspace it belongs to.');
  }

  // ── 6. Telephony ──────────────────────────────────────────────────────────
  const org = await req('/api/organizations/me', { headers: auth });
  if (org.ok) {
    say('OK', 'Agency record', `${org.body.name} · hours ${org.body.openingHour}:00–${org.body.closingHour}:00 · days ${JSON.stringify(org.body.serviceDays)}`);
  }

  const cbs = await req('/api/callbacks', { headers: auth });
  // Print the server's own words on failure. "HTTP 500" alone sends you to
  // the wrong place: a missing table, a stale build and a pooler pointed at
  // another database all look identical from the status line.
  const cbMsg = typeof cbs.body === 'object' && cbs.body
    ? (cbs.body.message || JSON.stringify(cbs.body))
    : String(cbs.body ?? '');
  say(cbs.ok ? 'OK' : 'DOWN', 'Callback queue',
    cbs.ok ? `${cbs.body.length} promise(s) recorded` : `HTTP ${cbs.status}: ${cbMsg.slice(0, 300)}`,
    cbs.ok ? null : 'If it names CallbackRequest, `db:push` has not reached THIS database — check the deployed DATABASE_URL is the one you pushed to. Otherwise read the Render logs for the stack.');

  const down = results.filter((r) => r.state === 'DOWN');
  const degraded = results.filter((r) => r.state === 'DEGRADED');
  console.log(`\n${results.filter((r) => r.state === 'OK').length} ok · ${degraded.length} degraded · ${down.length} down\n`);
  if (down.length) {
    console.log('Blocking:');
    for (const d of down) console.log(`  · ${d.name} — ${d.detail}`);
    console.log('');
  }
  process.exit(down.length ? 1 : 0);
})().catch((err) => {
  console.error('\nThe check itself failed:', err);
  process.exit(2);
});
