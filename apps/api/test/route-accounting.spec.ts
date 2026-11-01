/**
 * Every HTTP route is accounted for.
 *
 * ── Why this is a test and not a periodic audit ─────────────────────────────
 *
 * "Which endpoints can nobody reach?" has been answered by hand three times in
 * this repository, and got a different number each time — 25%, then 75%, then
 * 53, then 33 — because the answer depends on noticing that a path is built
 * from a template string, that one controller file holds three `@Controller`
 * prefixes, or that eleven of the routes are called by a voice agent rather
 * than a browser. Each hand audit also found real defects: endpoints with no
 * screen, a screen posting the wrong field names, and three routes shadowed by
 * middleware that had never matched anything.
 *
 * So the audit runs here instead, and fails when a route is in neither
 * category:
 *
 *   REACHABLE — some file under `apps/web/src` builds this path.
 *   MACHINE-FACING — declared below, with who calls it.
 *
 * A new endpoint with no screen and no entry fails this test, which is the
 * moment to decide which it is. A deleted endpoint whose entry is left behind
 * fails too, so the list cannot rot into documentation of a route that is gone.
 *
 * This checks ACCOUNTABILITY, not correctness: that somebody decided who calls
 * each route. What each one does is the job of the suites around it.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const API_SRC = join(__dirname, '..', 'src');
const WEB_SRC = join(__dirname, '..', '..', 'web', 'src');

interface Route {
  method: string;
  path: string;
  file: string;
}

function walk(dir: string, match: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, match));
    else if (match(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Every route Nest will register.
 *
 * The controller prefix is tracked per `@Controller`, not per file: three
 * controllers live in `onboarding.controller.ts`, and applying the first
 * prefix to all of them mislabelled three routes in an earlier hand audit.
 */
function collectRoutes(): Route[] {
  const routes: Route[] = [];
  for (const file of walk(API_SRC, (n) => n.endsWith('.controller.ts'))) {
    let prefix = '';
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const ctrl = line.match(/^@Controller\((?:'([^']*)'|"([^"]*)")?\)/);
      if (ctrl) {
        prefix = ctrl[1] ?? ctrl[2] ?? '';
        continue;
      }
      const m = line.match(/^\s*@(Get|Post|Put|Patch|Delete)\((?:'([^']*)'|"([^"]*)")?\)/);
      if (!m) continue;
      const sub = m[2] ?? m[3] ?? '';
      routes.push({
        method: m[1].toUpperCase(),
        path: '/' + [prefix, sub].filter(Boolean).join('/'),
        file: file.slice(file.indexOf('apps/')),
      });
    }
  }
  return routes;
}

const webSource = walk(WEB_SRC, (n) => /\.(ts|tsx)$/.test(n))
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

/**
 * Does the dashboard build this path anywhere?
 *
 * Two rules, and both were learned from getting this wrong.
 *
 * MOST segments may appear literally OR as an interpolation, because the web
 * app builds paths from template strings — including ones where a LITERAL
 * segment is interpolated, as in
 * `/api/scheduling/${kind === 'booking' ? 'bookings' : 'reservations'}/${id}/cancel`.
 * Demanding literals be literal reported those six as unreachable while the
 * screen called all six.
 *
 * But the LAST literal segment must be literal, with no identifier character
 * after it. Allowing every segment to be an interpolation made the check
 * worthless: a brand-new `/api/mutation-probe` was reported as reachable,
 * because `${API_URL}/api/${…}` appears all over the web app and satisfied a
 * pattern of two fully-wildcard segments. A route's own last word is the one
 * piece of evidence that it specifically is being called.
 */
function reachableFromWeb(path: string): boolean {
  const interpolation = String.raw`\$\{[^}]*\}`;
  const anySegment = `(?:${interpolation}|[^/'"\`\\s)]+)`;
  const escape = (seg: string) => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const segments = path.split('/').filter(Boolean);
  const isParam = (seg: string) => seg.startsWith(':') || seg.startsWith('*');
  const lastLiteral = segments.map(isParam).lastIndexOf(false);

  const parts = segments.map((seg, i) => {
    if (isParam(seg)) return anySegment;
    // The deepest literal is the route's identity. Anything shallower may have
    // been interpolated by the caller.
    if (i === lastLiteral) return `${escape(seg)}(?![\\w-])`;
    return `(?:${escape(seg)}|${interpolation})`;
  });

  return new RegExp('/' + parts.join('/')).test(webSource);
}

/**
 * Routes nothing in the dashboard calls, on purpose, and who calls them.
 *
 * `calledBy` is the point of the entry. "Unused" and "called by a voice agent
 * over a webhook" look identical from the dashboard's side, and the difference
 * is whether deleting it breaks a citizen's phone call.
 */
const MACHINE_FACING: Array<{ method: string; path: string; calledBy: string }> = [
  // ── The hosted agent's tool calls ───────────────────────────────────────
  //
  // ElevenLabs Agents invokes these over HTTP during a live conversation,
  // authenticated with the agent key. They are a thin controller over the same
  // services the orchestrator path uses — never a second implementation,
  // because the drift would be in what citizens are told about their money.
  { method: 'POST', path: '/api/agent-tools/lookup-customer', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/book-appointment', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/check-booking', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/cancel-booking', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/reschedule-booking', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/create-ticket', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/payment-details', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/check-availability', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/search-knowledge', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/register-enrollee', calledBy: 'ElevenLabs agent (webhook tool)' },
  { method: 'POST', path: '/api/agent-tools/handoff', calledBy: 'ElevenLabs agent (webhook tool)' },

  // ── Post-call ingestion ────────────────────────────────────────────────
  //
  // Two routes, one per workspace kind. The tenant-scoped one has no env
  // fallback on purpose: falling back would check a tenant's transcripts
  // against the shared workspace's secret.
  { method: 'POST', path: '/api/webhooks/elevenlabs', calledBy: 'ElevenLabs post-call webhook (shared workspace)' },
  { method: 'POST', path: '/api/webhooks/elevenlabs/:organizationId', calledBy: 'ElevenLabs post-call webhook (tenant workspace)' },

  // ── Carrier callbacks ──────────────────────────────────────────────────
  //
  // The carrier POSTs these when a citizen calls. Signature-verified before
  // the body is trusted; `nigeria-carrier` refuses by default until a shared
  // secret is configured.
  { method: 'POST', path: '/api/telephony/inbound/twilio', calledBy: 'Twilio voice webhook' },
  { method: 'POST', path: '/api/telephony/inbound/nigeria-carrier', calledBy: 'Nigerian carrier forward (shared secret)' },
  { method: 'POST', path: '/api/telephony/inbound/africa-talking', calledBy: "Africa's Talking voice webhook" },
  { method: 'POST', path: '/api/telephony/inbound/telnyx', calledBy: 'Telnyx voice webhook' },
  { method: 'POST', path: '/api/telephony/status/twilio', calledBy: 'Twilio status callback' },
  { method: 'POST', path: '/api/telephony/status/telnyx', calledBy: 'Telnyx status callback' },

  // ── Probes ─────────────────────────────────────────────────────────────
  //
  // Liveness is shallow because the only remedy for failing it is a restart;
  // readiness is deep and answers 503 without a database.
  { method: 'GET', path: '/api/health', calledBy: 'Container liveness probe' },
  { method: 'GET', path: '/api/health/ready', calledBy: 'Load balancer readiness probe' },
];

const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

describe('Route accounting', () => {
  const routes = collectRoutes();

  it('found the controllers at all', () => {
    // A refactor that moves or renames controllers must not turn this suite
    // into a test that passes by examining nothing.
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.path === '/api/health')).toBe(true);
  });

  it('leaves no route unaccounted for', () => {
    const declared = new Set(MACHINE_FACING.map(key));
    const orphans = routes
      .filter((r) => !declared.has(key(r)) && !reachableFromWeb(r.path))
      .map((r) => `${key(r)}   (${r.file})`);

    // Each of these is either missing a screen or missing an entry in
    // MACHINE_FACING above. Deciding which is the whole point.
    expect(orphans).toEqual([]);
  });

  it('declares nothing that no longer exists', () => {
    const live = new Set(routes.map(key));
    const stale = MACHINE_FACING.filter((m) => !live.has(key(m))).map(key);

    // Otherwise the list becomes documentation of routes that are gone, which
    // is worse than no list.
    expect(stale).toEqual([]);
  });

  it('says who calls every machine-facing route', () => {
    const vague = MACHINE_FACING.filter((m) => !m.calledBy || m.calledBy.trim().length < 8);
    expect(vague).toEqual([]);
  });

  it('declares each machine-facing route once', () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const m of MACHINE_FACING) {
      if (seen.has(key(m))) duplicates.push(key(m));
      seen.add(key(m));
    }
    expect(duplicates).toEqual([]);
  });
});
