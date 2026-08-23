/**
 * Suite 05 — The retired web-chat widget.
 *
 * ── Why this suite was rewritten ────────────────────────────────────────────
 *
 * It used to exercise the embedded widget as a live surface: config resolution
 * by API key, chat sessions, per-session history, rate limits, and the
 * orchestrator's own guarantees driven THROUGH the widget endpoint.
 *
 * The widget was retired. `/api/widget/*` answers 410 Gone by design, so every
 * one of those checks had been failing for as long as the retirement has
 * existed — sixteen of them — reporting a deliberate decision as a defect.
 * Nobody had run the harness in a while, which is the only reason that was
 * survivable.
 *
 * A suite that fails for a reason nobody intends to fix is worse than no suite:
 * it trains people to skim the failures, and the next real one is skimmed too.
 *
 * ── What it checks now ──────────────────────────────────────────────────────
 *
 * The retirement itself, because it has a contract and the contract is
 * load-bearing (see CLAUDE.md):
 *
 *   - 410 Gone, not 404. The embed snippet is a <script> tag on tenants' own
 *     sites that we cannot reach in and remove. A 404 also describes an outage,
 *     a bad URL or a broken proxy, and somebody would go hunting for a fault
 *     that is not there.
 *   - the body names the replacement, so the person reading it learns where
 *     their customers went rather than only that something stopped.
 *   - the CORS carve-out stays. Without it a tenant's browser blocks the 410 as
 *     a cross-origin violation and the site owner sees a CORS error instead of
 *     the explanation.
 *   - no widget endpoint writes anything. A retired surface that still creates
 *     contacts is a retired surface only in the changelog.
 *
 * ── Where the orchestrator guarantees moved ─────────────────────────────────
 *
 * The AI-* checks here drove real guarantees over a dead transport. They are
 * checked on live paths instead, and were already before this rewrite:
 *
 *   AI disclosure          → orchestrator.spec.ts, and `npm run parity`
 *   payout details only    → orchestrator.spec.ts, and `npm run parity`
 *   escalation handoff     → orchestrator.spec.ts ("What a handoff records")
 *   booking in hours       → booking-flow.spec.ts, agent-tools.spec.ts
 *   model unavailable      → orchestrator.spec.ts (keyless degradation)
 *
 * The WhatsApp probe covers the same orchestrator over the channel customers
 * actually use.
 */
const H = require('../harness');
const { api, prisma, check, suite, seedSession, uniq } = H;
const crypto = require('crypto');

/** Every widget route, including the ones that used to write. */
const RETIRED_ROUTES = [
  ['GET', '/api/widget/config?apiKey=anything'],
  ['POST', '/api/widget/chat'],
  ['GET', '/api/widget/session/some-session-id'],
];

module.exports = async function () {
  suite('05 · Retired web-chat widget');

  const A = await seedSession('widgetA');

  const raw = `ace_live_pk_${crypto.randomBytes(16).toString('hex')}`;
  await prisma.apiKey.create({
    data: {
      organizationId: A.orgId,
      keyName: 'E2E Key',
      keyHash: crypto.createHash('sha256').update(raw).digest('hex'),
      keyPrefix: raw.slice(0, 16),
    },
  });

  // ── The retirement answers, and answers usefully ──────────────────────────
  for (const [method, path] of RETIRED_ROUTES) {
    const id = `WID-${method === 'GET' ? 'G' : 'P'}${path.includes('chat') ? 'C' : path.includes('session') ? 'S' : 'F'}`;
    await check(
      `${id}-410`,
      `${method} ${path.split('?')[0]} answers 410 Gone`,
      async () => {
        const res = await api(method, path, method === 'POST' ? { body: { apiKey: raw, message: 'hello' } } : {});
        if (res.status !== 410) {
          // 404 is the failure that matters: it is indistinguishable from an
          // outage, and sends the site owner looking for a fault.
          return { expected: '410', actual: `${res.status} ${res.text.slice(0, 120)}` };
        }
        return { ok: true, evidence: '410' };
      },
      'HIGH'
    );
  }

  await check(
    'WID-030',
    'The 410 body names the replacement rather than only refusing',
    async () => {
      const res = await api('POST', '/api/widget/chat', { body: { apiKey: raw, message: 'hello' } });
      const body = `${res.text}`.toLowerCase();
      const namesIt = body.includes('whatsapp') || body.includes('phone') || body.includes('retired');
      if (!namesIt) {
        return { expected: 'a body naming WhatsApp/phone as the replacement', actual: res.text.slice(0, 200) };
      }
      return { ok: true, evidence: res.text.slice(0, 120) };
    },
    'HIGH'
  );

  await check(
    'WID-031',
    'The CORS carve-out survives, so the tenant sees the message and not a CORS error',
    async () => {
      const res = await api('POST', '/api/widget/chat', {
        body: { apiKey: raw, message: 'hello' },
        headers: { Origin: 'https://a-tenant-site.example' },
      });
      const allow = res.headers?.get?.('access-control-allow-origin');
      if (!allow) {
        return {
          expected: 'an Access-Control-Allow-Origin header on the 410',
          actual: 'absent — the browser blocks the 410 and the site owner sees a CORS error instead of the explanation',
        };
      }
      return { ok: true, evidence: `allow-origin=${allow}` };
    },
    'HIGH'
  );

  // ── And it is genuinely inert ─────────────────────────────────────────────
  await check(
    'WID-032',
    'A retired endpoint writes nothing',
    async () => {
      const before = await prisma.contact.count({ where: { organizationId: A.orgId } });
      const conversationsBefore = await prisma.conversation.count({ where: { organizationId: A.orgId } });

      await api('POST', '/api/widget/chat', {
        body: { apiKey: raw, sessionId: uniq('sess'), message: 'i want to book an appointment' },
      });

      const after = await prisma.contact.count({ where: { organizationId: A.orgId } });
      const conversationsAfter = await prisma.conversation.count({ where: { organizationId: A.orgId } });

      if (after !== before || conversationsAfter !== conversationsBefore) {
        return {
          expected: 'no rows created',
          actual: `contacts ${before}→${after}, conversations ${conversationsBefore}→${conversationsAfter} — a retired surface that still writes is retired only in the changelog`,
        };
      }
      return { ok: true, evidence: 'no contact, no conversation' };
    },
    'CRITICAL'
  );

  // widget.js itself is NOT checked here: it is served by the web app, and this
  // harness targets the API. `apps/web/e2e` is where a browser-side assertion
  // about the inert script belongs — testing it against the wrong server would
  // report a 404 that means nothing.
};
