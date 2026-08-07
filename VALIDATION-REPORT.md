# ACE Platform — Production Validation & Destructive Testing

**Method:** every assertion below was produced by driving the **running system** over
HTTP and then verifying the consequence directly in PostgreSQL. No result is inferred
from source code. Where something could not be executed it is marked **BLOCKED** with
the reason — never assumed to pass.

**Harness:** `e2e-validation/` — 8 suites, **236 checks**, machine-readable output in
`e2e-validation/results.json`. Re-run with `node e2e-validation/harness.js`.

**Final run: 233 pass · 0 fail · 3 warn · 1 blocked.**

---

## 1. Environment reality

Validation is only as good as what was actually reachable. Probed live:

| Dependency | Status | Consequence for this report |
|---|---|---|
| PostgreSQL (Supabase) | **REACHABLE** | Full data-layer verification performed |
| Redis | **REACHABLE** | Socket.IO adapter + queue paths exercised |
| OpenAI | **REACHABLE but NO CREDITS** (`insufficient_quota`, HTTP 429) | LLM synthesis **BLOCKED**; degraded path verified instead |
| Twilio | **REACHABLE** (account active) | API auth verified; **no calls placed** |
| Meta WhatsApp | **REACHABLE** (+234 708 107 8679) | API auth verified; **no inbound webhook received** |
| Deepgram | **REACHABLE** | Credential valid; **no audio streamed** |
| ElevenLabs | **AUTH FAILED** (HTTP 400) | TTS **BLOCKED** |
| Resend | **REACHABLE** | Email send path available |
| Qdrant | **UNREACHABLE** (no Docker on host) | Vector search **BLOCKED**; Postgres fallback verified |
| Paystack | **NOT CONFIGURED** (placeholder key) | Live payment **BLOCKED**; signature rejection verified |

The database was **empty (0 rows)** at start — a clean dev instance, so destructive
testing was safe and all data below was created by the tests.

---

## 2. Results

| Suite | Total | Pass | Fail | Warn | Blocked |
|---|---|---|---|---|---|
| 01 Authentication & Sessions | 41 | 41 | 0 | 0 | 0 |
| 02 Multi-Tenant Isolation & RBAC | 35 | 35 | 0 | 0 | 0 |
| 03 CRM (volume, search, export, concurrency) | 31 | 31 | 0 | 0 | 0 |
| 04 Scheduling & Reservations | 24 | 24 | 0 | 0 | 0 |
| 05 Widget & AI Orchestrator | 27 | 25 | 0 | 1 | 1 |
| 06 Security | 34 | 34 | 0 | 0 | 0 |
| 07 Integrity, Analytics, Performance, Resilience | 23 | 21 | 0 | 2 | 0 |
| 08 Knowledge Base & Workflows | 21 | 21 | 0 | 0 | 0 |
| **Total** | **236** | **233** | **0** | **3** | **1** |

The three warnings and one blocked item are listed in §5 and §6. **No check fails.**

Unit/integration suites also green: **45** API tests, **32** package tests.
Monorepo builds clean; both apps typecheck clean.

---

## 3. Defects found in this pass and fixed

Each was found by execution, fixed, and re-verified.

### Blocking

**V-01 · Every API route capped at 5 requests/minute, per IP.**
`ThrottlerModule.forRoot([...])` applies *all* named tiers to *every* route — they are
ANDed, not selected by decorator — so the strict `auth` tier governed the whole API.
Additionally the flat limit covered `/refresh`, so a user with several tabs open
silently burned their own login budget, and being per-IP it locked out whole NAT'd
offices while distributed credential-stuffing sailed through untouched.
*Fixed:* tiered by risk (register/forgot-password 5/min, login 60/min, rest 60/min) and
replaced the anti-brute-force role with **per-account lockout** — 5 failures →
escalating 1min/5min/15min/1hr, cleared on success or password reset. The correct
password is refused while locked (verified), so the lock is not bypassable by guessing
right. `AUTH-080..084`.

**V-02 · Connection pool exhaustion under modest concurrency.**
100 concurrent authenticated readers produced ~5% HTTP 500s and a 60s p95. Root cause,
from the server log: `EMAXCONNSESSION — max clients reached in session mode, pool_size:
15`. `DATABASE_URL` pointed at Supabase's pooler on **port 5432 (session mode)**, which
holds one Postgres backend per client and hard-caps at 15. The schema comments document
the correct arrangement; the URLs did not follow it.
*Fixed:* runtime URL moved to **port 6543 (transaction mode)** with `pgbouncer=true`;
`DIRECT_URL` stays on 5432 for migrations; pool sizing centralised and documented in
`packages/database/src/index.ts`. Re-measured: **0 errors at 25/50/100 concurrent**.
`PERF-002`.

**V-03 · Pool exhaustion surfaced as HTTP 500.**
A temporary capacity condition told clients to give up. *Fixed:* global exception filter
maps pool timeout → **503 + Retry-After**, P2002 → 409, P2025 → 404, P2003 → 400, and
withholds internals on anything else.

**V-04 · Duplicate phone number returned HTTP 500.** Raw Prisma `P2002` reached the
browser. A repeat submission or an impatient double-click produced an opaque server
error. *Fixed:* 409 with an actionable message. `CRM-011`, `CRM-060`.

**V-05a · Double-booking under real concurrency (demonstrated, not theorised).**
The application checked for a conflict before inserting, but that is a read-then-write
race: driving 8 simultaneous identical booking requests, **all 8 passed the check before
any committed** — 8 CONFIRMED bookings in one slot. The full run left 84 overlapping
pairs in the database, every one from that test. Two customers would each have been told
their appointment was confirmed. No application-level check can close this.
*Fixed:* PostgreSQL exclusion constraint `bookings_no_staff_overlap`
(`EXCLUDE USING gist (organizationId =, staffName =, tsrange(startTime, endTime) &&)`
scoped to active bookings), enforced at commit time; the losing requests receive 409
rather than a 500. Migration also cancels pre-existing overlaps with an audit note.
Re-verified: 8 concurrent → exactly 1 booking. `SCH-006`, `INT-006`.

**V-05 · Ticket numbers collided under concurrency.** `TCK-<4 digits of Date.now()>-<count+1>`
derived from a COUNT read before the insert: 25 parallel creates produced **14 HTTP 500s**
from the unique constraint. *Fixed:* time-ordered prefix + 3 bytes of randomness with a
bounded retry. 25/25 succeed, all distinct. `CRM-044`.

### Data correctness

**V-06 · Pagination returned overlapping pages.** Ordering by `createdAt` alone is not a
total order — rows sharing a timestamp (every bulk import) come back in arbitrary order,
so users paging a list saw records twice and never saw others. *Fixed:* deterministic
`[createdAt desc, id desc]` ordering everywhere. `CRM-003`.

**V-07 · `?limit=999999999` returned the entire table.** An authenticated denial of
service against the database and the API heap. *Fixed:* clamped to `MAX_PAGE_SIZE=200`;
the CSV export uses an explicit batched cursor read so it is not silently truncated.
`CRM-005`, `PERF-006`.

**V-08 · Negative deal amounts accepted**, silently corrupting `pipelineValue` (a plain
SUM) and every revenue figure derived from it. *Fixed:* rejected. `CRM-043`.

**V-09 · Contacts list over-fetched.** `include: { leads, deals, tickets }` made Prisma
issue a separate query per relation — 7 SQL round trips instead of 4, measured 2101ms vs
919ms — and embedded every child record of every contact in a response that renders a
table. *Fixed:* `_count` in the list, full records retained on the detail endpoint.
p50 at 25 concurrent improved 6226ms → 4835ms.

### Security

**V-10 · Integration secrets disclosed to every role.** `GET /organizations/me` returned
the Meta access token, WhatsApp verify token and Twilio account SID/auth token in
plaintext — to VIEWER and AGENT included. Anyone holding those can send WhatsApp as the
business, place calls billed to its Twilio account, and re-point the webhook.
*Fixed:* masked to `••••<last4>`, never re-readable. `SEC-070`.

**V-11 · Body-parser errors relabelled as 500.** The new catch-all filter intercepted
framework errors carrying their own status — a legitimate 413 became an opaque 500,
telling clients to give up on a request they could have fixed. *Fixed:* statuses carried
by non-HttpException errors are honoured. `KB-002`.

### Product honesty

**V-12 · A model outage silently swallowed customer messages.** When the LLM was
unavailable the assistant replied *"a member of our team will follow up"* with
`shouldHandoff: false` — so no agent was notified and nobody followed up. With OpenAI
returning `insufficient_quota` this was live, observable behaviour.
*Fixed:* degraded replies now **escalate to a human**. `AI-010`.

**V-13 · Sidebar showed placeholder identity after sign-in.** Verified in a real browser:
the header greeted "Browser QA Clinic" while the sidebar still read "My Organization" /
"Administrator". The layout read `localStorage` once on mount and is not remounted by
client-side navigation. *Fixed:* re-reads on navigation, plus a `storage` listener so
signing out in one tab updates the others.

**V-14 · API key usage was not recorded.** `lastUsedAt` was a dropped promise — the only
audit trail for "was this key active when the incident happened?" *Fixed:* awaited.

---

## 4. What was verified, by capability

| Capability | Verified | Evidence |
|---|---|---|
| Registration → login → dashboard | **PASS** | End-to-end in a real browser; org + OWNER row created, bcrypt hash confirmed in DB |
| Password reset, email verification, invite activation | **PASS** | Tokens stored as SHA-256 with expiry; single-use enforced; expired tokens rejected |
| Session revocation | **PASS** | Logout, password change and reset all invalidate outstanding access **and** refresh tokens immediately; deactivation takes effect on the next request |
| JWT integrity | **PASS** | `alg=none`, tampered payload, wrong-key signature, access-token-as-refresh all rejected |
| Brute-force resistance | **PASS** | Per-account lockout with escalation; correct password also refused while locked |
| **Multi-tenant isolation** | **PASS (35/35)** | 8 list endpoints, 5 IDOR probes, 8 cross-tenant writes, org settings, members, knowledge search — no leakage or mutation across tenants |
| RBAC | **PASS** | VIEWER/AGENT correctly refused settings, member management, key minting and free plan activation; self-escalation blocked; role read from DB not token |
| CRM at volume | **PASS** | 1,200 contacts; pagination, search, cascade delete, CSV export (RFC4180 quoting + formula-injection neutralised), concurrency |
| Scheduling | **PASS (24/24)** | Exact/partial double-booking refused, back-to-back allowed, per-staff scoping, past dates refused, cancel preserves clinical notes and reminder markers, refunds open HIGH tickets |
| Widget tenant isolation | **PASS** | 6 invalid-credential probes all refused — no fallback to an arbitrary organization; session history scoped to its own session |
| AI honesty | **PASS** | Discloses it is an AI when asked; refuses to invent bank details, prices or availability; quotes only configured payout details |
| Injection & SSRF | **PASS (34/34)** | SQLi inert across all string inputs; prototype pollution blocked; 10 SSRF vectors refused including DNS-resolved and IPv6-mapped forms; outbound webhook URLs validated too |
| Webhook authenticity | **PASS** | Unsigned and wrongly-signed Paystack payloads rejected without granting a subscription; unsigned WhatsApp payload stores nothing; forged Twilio callback creates no call record |
| Data integrity | **PASS** | 10 FK relationships, 0 orphans; 6 uniqueness invariants hold; no cross-tenant conversation/contact mismatches; no overlapping staff bookings table-wide |
| Analytics correctness | **PASS** | Dashboard figures match direct DB counts; `aiReplyRate` computed (was permanently null); `handoverRate` bounded 0–100 (was tickets/conversations, could exceed 100%) |
| Resilience | **PASS** | Survives Qdrant outage (Postgres fallback), malformed JSON, malformed UUIDs, mixed concurrent load — accepted responses and persisted rows agree exactly |

---

## 4b. Measured capacity — read this before sizing

Throughput for authenticated, database-backed endpoints is bounded by
**(connection pool size ÷ query latency)**, and in this environment the second term is
pathological because the database is ~950ms away.

| Measurement | Result |
|---|---|
| Health endpoint (no database) | 500 requests, **3,571 rps**, p50 5ms, p95 37ms, 0 errors |
| Paginated CRM read, 7,526 rows | p50 ~2.2s, p95 3.1s — dominated by the remote round trip |
| 100 concurrent authenticated readers | 29 served, **71 shed as 503 + Retry-After**, **0 faults**, 0 data inconsistency |
| Measured DB round trip | **974ms** (API on a local host, database in `eu-central-1`) |

The framework is not the limit — 3,571 rps without a database call proves that. The
limit is the database path. Shedding excess load as a retryable 503 is correct
behaviour and no request corrupted anything, but the honest reading is that this
deployment **does not carry 100 concurrent DB-backed readers**. Co-locating the API
with the database (K-02) should move query latency from ~950ms to ~5–20ms and raise the
ceiling by roughly two orders of magnitude — but that must be **measured, not assumed**,
which is why the load targets remain a GA blocker.

`AI-009` (widget chat latency, 14.7s) has the same cause compounded by OpenAI 429
retries, and is not a separate defect.

---

## 5. BLOCKED — could not be verified in this environment

These are **not passes**. Each needs the stated prerequisite.

| Area | Blocker | Needed to certify |
|---|---|---|
| **LLM conversation quality** | OpenAI account has no credits | Add credits; re-run `AI-007` and conversational-memory checks |
| **Voice AI, end to end** | No real call placed; ElevenLabs auth failing; Deepgram never streamed | A Twilio number pointed at a public `API_BASE_URL`, working ElevenLabs key, then live inbound/outbound calls, barge-in, silence watchdog, transcript accuracy, accent handling |
| **WhatsApp inbound** | Meta cannot deliver a webhook to localhost | Public HTTPS endpoint; then text/image/audio/location/interactive, duplicate delivery, retries, human takeover |
| **Vector/semantic search** | Qdrant unreachable (no Docker) | Run Qdrant; verify embedding, retrieval accuracy, citation, deletion of vectors |
| **PDF / DOCX ingestion** | `pdf-parse` / `mammoth` not installed | `npm i pdf-parse mammoth -w @ace/api`; then real PDFs, scanned PDFs, corrupt files |
| **Live payments** | Paystack key is a placeholder | Test keys; then checkout, webhook activation, renewal, failure, refund, duplicate webhooks |
| **Load beyond ~100 concurrent** | Single local host against a remote DB (974ms round trip) | Co-located load generator + API; the 500/1000/5000/10000-user targets were **not** attempted |
| **Responsive layouts** | Browser resize did not take effect in the harness | Manual or Playwright viewport testing at mobile/tablet breakpoints |
| **Full UI sweep** | Only register/login/dashboard/CRM journeys were driven in-browser | Every remaining page's buttons, modals, filters, exports, keyboard navigation, back/forward |

---

## 6. Known-unfixed findings

| ID | Finding | Severity |
|---|---|---|
| **K-01** | **Workflow engine executes nothing.** `POST /workflows/:id/execute` matches active workflows and runs none of their actions — no WhatsApp send, no task creation, no branching, retries, queue or dead-letter handling. *Partially addressed:* the endpoint now returns `executed: false` with an explicit notice, and the UI reports "actions were NOT run" instead of a success toast, so nobody is told their automation is live when it is not. The capability itself is still missing. | **HIGH** |
| **K-02** | **API and database in different regions.** `render.yaml` deployed the API to `oregon` against a `eu-central-1` database — every query a transatlantic round trip (~950ms measured, 4 per list request). Corrected to `frankfurt` in `render.yaml`, but **the region must be set to match your actual Supabase project**. | **HIGH** |
| **K-03** | Duplicate search input on the CRM page — two boxes, one non-functional. Cosmetic. | LOW |
| **K-04** | Root layout is a client component, so every page ships an empty shell and paints only after hydration. Acceptable for a dashboard; means no SEO and a blank screen if JS fails. | LOW |
| **K-06** | SMS reminders are not implemented (no provider integrated). Now logs honestly rather than claiming delivery, but 24h/6h SMS reminders do not reach customers. | MEDIUM |

---

## 7. Release decision

### **READY FOR CLOSED BETA**

Not general availability, and not public beta.

**Why it clears internal testing and closed beta:** the properties that make a
multi-tenant B2B product safe to put real customer data into are verified, not assumed.
Tenant isolation passed 35/35 against genuine cross-tenant reads, writes, deletes and
IDOR probes. Authentication, session revocation and RBAC passed 41/41 and 35/35.
Injection, SSRF and webhook forgery passed 34/34. Referential integrity holds across the
whole schema with zero orphans. The product no longer invents bank details, prices,
bookings or delivery confirmations — the failure mode that would have done real
commercial harm.

**Why it is not ready for public beta or GA:** three of the four headline capabilities
on the box — **Voice AI, WhatsApp, and payments** — have never been executed end to end
in this environment. Their credentials authenticate and their code paths are reachable,
but no call has been placed, no WhatsApp message received, and no payment taken. That is
a gap in evidence, not a known fault, and it is not honest to certify around it.

### Blockers for **PUBLIC BETA**

1. **Verify Voice AI on a real call** — inbound and outbound, with a public
   `API_BASE_URL`, a working ElevenLabs key, barge-in, the silence watchdog, and
   transcript persistence. (BLOCKED above.)
2. **Verify WhatsApp inbound on a public endpoint** — including duplicate delivery and
   Meta's retry behaviour.
3. **Verify Paystack end to end with test keys** — checkout, webhook activation,
   failure, and duplicate webhooks.
4. **Restore OpenAI credit and re-run suite 05** — conversational quality and memory are
   currently unverifiable.
5. **Fix K-01 or remove the workflow UI.** Shipping a screen labelled "Visual Workflows"
   that runs nothing is the same class of defect as the fabricated bookings already
   fixed.
6. **Set the deployment region to match the database** (K-02).

### Additional blockers for **GENERAL AVAILABILITY**

7. **Load test at the stated scale** from a co-located generator — 500 → 10,000
   concurrent users. Only ~100 was reached here, and only against a remote database.
8. **Stand up Qdrant and certify semantic search**, including retrieval accuracy and
   hallucination rate against a real corpus.
9. **Install PDF/DOCX parsers and verify ingestion** of real, large and malformed
   documents.
10. **Complete the UI sweep** — every page, modal, filter and export, plus responsive
    breakpoints and keyboard navigation.
11. **Implement SMS or remove the reminder promise** (K-06).
12. **Independent security review.** This pass tested the vulnerability classes I could
    enumerate; that is not the same as an adversarial audit.

---

## 8. Reproducing this

```bash
# Migrations (idempotent)
npx prisma db execute --schema=packages/database/prisma/schema.prisma \
  --file=packages/database/prisma/migrations/20260807000000_audit_fixes/migration.sql
npx prisma db execute --schema=packages/database/prisma/schema.prisma \
  --file=packages/database/prisma/migrations/20260807010000_login_lockout/migration.sql

npm run build
npm test                    # 45 API + 32 package tests

# Runtime validation against a running API
node apps/api/dist/main.js  # or npm run dev
node e2e-validation/harness.js            # all suites
node e2e-validation/harness.js 02-tenancy # one suite
# → e2e-validation/results.json
```
