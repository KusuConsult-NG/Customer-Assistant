# Production Readiness Certification Audit

**Scope requested:** Plateau State Grassroots Revenue Collection Platform
**Repository audited:** `KusuConsult-NG/Customer-Assistant` @ `d8c46a0` (branch `claude/production-readiness-cert-hhe42a`)
**Method:** Static source trace (UI → API → service → Prisma schema). No live execution — see §3.
**Date:** 2026-08-21

---

## PRODUCTION CERTIFICATION: FAIL — NOT PRODUCTION READY

Two independent grounds, either sufficient on its own:

1. **The system described in the certification brief does not exist in this repository.** There is no agent PWA, no KYC, no referee verification, no TIN integration, no taxpayer registry, no revenue catalogue, no invoice/receipt engine, no vehicle renewal, no commission engine, and no reconciliation. Certification cannot be issued for software that is not present.
2. **The one citizen-facing payment path that *does* exist fails the brief's own non-negotiable rules** — specifically Rule 5 (no verified payment = no receipt), Rule 7 (no manual payment confirmation), Rule 11 (idempotency), Rule 13 (authorization) and Rule 14 (public data exposure). These are verified defects in shipped code, not hypotheticals.

---

## 1. Scope finding: audited system ≠ described system

The brief describes a government revenue collection platform. This repository is **Customer Care Agent** — a multi-tenant AI customer-experience platform (WhatsApp + voice + staff dashboard), configured for PLASCHEMA (Plateau State Contributory Healthcare Management Agency) as a tenant. Plateau State is the only overlap.

Repository-wide search, excluding `node_modules`, `.git`, `package-lock.json` and build caches:

| Domain concept from the brief | Files containing it |
|---|---|
| `referee` | 0 |
| `taxpayer` | 0 |
| `commission` | 0 |
| `reconcil*` | 0 |
| `vehicle` | 0 |
| `settlement` | 0 |
| `KYC` | 0 |
| `TIN` (word-boundary) | 0 |
| `MDA` (word-boundary) | 0 |
| `LGA` | 12 — PLASCHEMA health-plan content and a CRM field, not a jurisdiction boundary |
| `invoice` | 2 — SaaS subscription billing, not government assessments |
| `receipt` | 5 — Paystack subscription receipts and WhatsApp read-receipts |

Sections 4–8, 12–16 and 22–23 of the brief (Agent PWA, KYC, Referee, Taxpayer Onboarding, Revenue Catalogue, Assessment/Invoice, Receipt, Public Receipt Verification, Vehicle Renewal, Commission, Reconciliation, Anti-Leakage, PWA) have **no corresponding implementation to test**. They are recorded as NOT APPLICABLE — TARGET ABSENT, not as PASS or FAIL.

## 2. What this repository actually is

| Layer | Present |
|---|---|
| Apps | `apps/api` (NestJS 10), `apps/web` (Next.js 15 App Router — staff dashboard) |
| Packages | `database` (Prisma), `orchestrator`, `pdf-generator`, `scheduling-engine`, `omnichannel-adapters`, `telephony-sdk`, `whatsapp-sdk`, `voice-biometrics`, `shared-types` |
| API modules | auth, organizations, crm, whatsapp, telephony, knowledge, scheduling, billing, workflows, analytics, events, onboarding, agent-tools, webhooks, widget (410 stub) |
| Customer channels | WhatsApp, voice (Twilio/ElevenLabs). Web-chat widget retired |
| Payments | Paystack — **SaaS subscription billing only** (`apps/api/src/billing`) |
| External | Meta WhatsApp, Twilio, Telnyx, ElevenLabs, Deepgram, OpenAI, Qdrant, Supabase Storage, Paystack |
| Citizen-facing pages | `/selfie/:token` (onboarding photo), `/pay/informal` (PLASCHEMA premium payment) |

## 3. Audit conditions — what could not be tested

`node_modules` absent, no `.env`, no PostgreSQL, no Redis, no provider credentials. Therefore **no dynamic testing was performed**: no live API calls, no webhook replay, no concurrency tests, no load/performance measurement, no backup-restore drill, no browser/PWA testing, no test-suite execution.

Every finding below is a source-level trace with file and line references. Sections of the brief requiring live execution (§24 Performance, §27 Backup/DR, §28 Observability, §35 Failure testing) are recorded as **NOT TESTED**. Under the brief's own rule, NOT TESTED is never PASS.

## 4. Critical defects (verified in source)

### DEF-01 — Unauthenticated endpoint marks a citizen PAID with no payment
**Severity: CRITICAL · Production blocker · Brief Rules 5, 7**

`POST /api/public/pay/confirm` (`apps/api/src/onboarding/onboarding.controller.ts:135`) carries **no `@UseGuards`** — `PublicPaymentController` is fully unauthenticated. It accepts `contactId`, `paymentReference` and `amount` from the request body and passes them to `confirmEnrolleePayment` (`apps/api/src/onboarding/onboarding.service.ts:515`), which writes:

```
paymentStatus: 'PAID', paidAmount: amount, paymentReference, paidAt: now,
enrollmentStatus: 'ENROLLED_ACTIVE', tags: [...,'paid-enrollee']
```

There is **no payment gateway call anywhere in this path** — no Paystack initialize, no transaction verify, no webhook, no signature check, no server-side amount lookup. The payment reference is generated in the browser: `` `PAY-PLS-${Date.now()}-${Math.floor(Math.random()*10000)}` `` (`apps/web/src/app/pay/informal/page.tsx:77`). The client then renders "Coverage Activated!" and "₦12,000 / Year (PAID)".

The frontend is the sole authority that payment succeeded — the exact condition the brief marks as an automatic blocker. Any party who can reach the URL can activate health coverage for any enrollee, for any amount, for free.

Note that the platform already has the correct pattern: `BillingService` (`apps/api/src/billing/billing.service.ts`) does Paystack initialize + HMAC-SHA256 webhook verification with `timingSafeEqual`. The citizen payment path does not use it.

### DEF-02 — Both public endpoints are unscoped across tenants
**Severity: CRITICAL · Production blocker · Brief Rule 13**

`lookupEnrolleeForPayment` (`onboarding.service.ts:475`) uses `prisma.contact.findFirst` and `confirmEnrolleePayment` (`:521`) uses `prisma.contact.findUnique({ where: { id } })` — **neither includes `organizationId`**. This violates the invariant stated in the repository's own `CLAUDE.md`: *"Multi-tenancy is by `organizationId` scoping on every query — there is no automatic tenant filter."* Any contact belonging to any tenant on the platform can be read and mutated through these unauthenticated routes.

### DEF-03 — Unauthenticated PII lookup with record enumeration
**Severity: CRITICAL · Production blocker · Brief Rule 14**

`POST /api/public/pay/lookup` requires only a 3-character string and returns full name, phone number, plan type, LGA, preferred hospital, policy ID, payment status, enrollment status, photo status and **the full dependants list** (`onboarding.service.ts:498–512`). Beyond phone lookup it matches `id: { startsWith: q.toLowerCase() }` — a 3-character UUID prefix against a `findFirst`, which is a working enumeration oracle for the contact table. Rate limit is 30/min per the `@Throttle` decorator; that bounds the rate, not the exposure.

### DEF-04 — No transaction record, no idempotency, no immutability
**Severity: CRITICAL · Production blocker · Brief Rules 9, 11**

`packages/database/prisma/schema.prisma` contains **no Payment, Transaction, Receipt, Invoice or Ledger model**. Citizen payment state is stored in `Contact.metadata` — a nullable, freely-mutable `Json` column (`schema.prisma:321`). Consequences:

- No unique constraint on payment reference exists or can exist → replaying `confirm` overwrites `paidAmount`, `paymentReference` and `paidAt` silently, as many times as called.
- Financial records are mutable by any code path that writes `metadata`, and are destroyed with the contact via `onDelete: Cascade`.
- There is no record to reconcile against a gateway, because no transaction row is ever created.

### DEF-05 — No audit trail for a financial state change
**Severity: CRITICAL · Production blocker · Brief §19**

The schema has **no AuditLog model**. The only trace `confirmEnrolleePayment` leaves is a free-text `Note` (`onboarding.service.ts:561`), created inside `.catch(() => {})` so its failure is swallowed. It records no actor, no IP, no request ID, no previous value, no new value, and is itself mutable and cascade-deletable. The brief's §19 requirements are unmet in full.

### DEF-06 — Zero test coverage on the payment path
**Severity: HIGH**

No test file in the repository references `public/pay` or `confirmEnrolleePayment`. The only two files matching are the controller and service themselves.

### DEF-07 — Existing certification document contradicts the code
**Severity: HIGH · governance**

`PRODUCTION_CERTIFICATION.md` states the application's *"code, database, security model, and local APIs are 100% verified and defect-free"* and marks **Authentication & Authorization: PASS**, attributing non-certification solely to a pending Meta template approval. DEF-01 through DEF-05 were present in the code at that time. That document should be withdrawn — a stakeholder reading it would conclude the security model had been verified.

## 5. Certification matrix

| Area | Status | Evidence | Severity | Blocker |
|---|---|---|---|---|
| Scope alignment with brief | **FAIL** | §1 — 9 of 9 core domain concepts absent | Critical | Yes |
| Agent PWA / KYC / Referee / TIN / Taxpayer | **N/A — TARGET ABSENT** | §1 | — | Yes |
| Revenue catalogue / Assessment / Invoice | **N/A — TARGET ABSENT** | §1 | — | Yes |
| Receipt + public verification | **N/A — TARGET ABSENT** | §1 | — | Yes |
| Vehicle renewal | **N/A — TARGET ABSENT** | §1 | — | Yes |
| Commission engine | **N/A — TARGET ABSENT** | §1 | — | Yes |
| Reconciliation | **N/A — TARGET ABSENT** | §1 | — | Yes |
| Citizen payment (present analogue) | **FAIL** | DEF-01 | Critical | Yes |
| Authorization / tenant isolation | **FAIL** | DEF-02 | Critical | Yes |
| Sensitive data exposure | **FAIL** | DEF-03 | Critical | Yes |
| Idempotency / financial immutability | **FAIL** | DEF-04 | Critical | Yes |
| Audit logging | **FAIL** | DEF-05 | Critical | Yes |
| Database schema (financial models) | **FAIL** | DEF-04 — no financial models exist | Critical | Yes |
| Test coverage (payment) | **FAIL** | DEF-06 | High | Yes |
| Webhook security (providers present) | **PARTIAL** | Meta/Twilio/Telnyx/Paystack/ElevenLabs verified in source; none exercised live | Medium | — |
| SaaS subscription billing (Paystack) | **PARTIAL** | Correct init + HMAC webhook pattern in source; not executed | Medium | — |
| Performance | **NOT TESTED** | §3 — no runnable environment | — | — |
| Backup / disaster recovery | **NOT TESTED** | §3 — no restore drill possible | — | Yes |
| Observability / monitoring | **NOT TESTED** | §3 | — | Yes |
| PWA (installability, offline) | **N/A — TARGET ABSENT** | No manifest or service worker for an agent PWA | — | Yes |
| Test suite execution | **NOT TESTED** | §3 — dependencies not installed | — | Yes |

No area is marked PASS. Under the brief's evidence rule, nothing verified only by source reading and never executed can carry a PASS.

## 6. Required before any production certification

**Blockers, in order:**

1. Point the certification at the correct repository, or confirm the revenue platform is unbuilt. The brief's system does not exist here.
2. **Take `/api/public/pay/*` out of service immediately.** Both routes are unauthenticated, cross-tenant, and one of them grants free health coverage. If PLASCHEMA data is live, treat DEF-01/02/03 as an active incident, not a backlog item.
3. Rebuild citizen payment on the gateway: server-side amount resolution, Paystack initialize, verification by webhook + `transaction/verify`, and payment state written **only** by the verified callback — never by a client request.
4. Add real financial models to the schema — `Payment`/`Transaction` with a unique constraint on gateway reference, append-only status transitions, and no cascade delete. Move payment state out of `Contact.metadata`.
5. Add an `AuditLog` model capturing actor, action, target, previous value, new value, request ID, IP and timestamp, written in the same transaction as every financial mutation.
6. Scope every query in `onboarding.service.ts` by `organizationId`; remove the `id: { startsWith: … }` prefix match.
7. Cover the payment path with integration tests: unauthorized call rejected, replayed webhook processed once, amount tampering rejected, cross-tenant access rejected.
8. Withdraw `PRODUCTION_CERTIFICATION.md`.
9. Stand up a testable environment (dependencies, database, seeded credentials) so §24, §27, §28 and §35 can be executed rather than deferred.

**Required before re-audit:** items 2–7 complete, plus a runnable environment. A re-audit without live execution can only reach the same NOT TESTED verdicts on a third of the brief.

---

*Static source audit. No code was modified, no validation weakened, no test removed or skipped.*

---

## Addendum — re-verified 2026-08-24 against `db0d149`

Added when this document was moved onto `main`. The audit above is unchanged; this records only whether it still holds.

The audit was written against `d8c46a0` on 2026-08-21. `main` has advanced ten pull requests since (#38–#47). **None of them touched this code path, and all seven defects are present today**, re-checked individually against `db0d149`:

| Defect | Status | Where it is now |
|---|---|---|
| DEF-01 | Present | `onboarding.controller.ts:124` — `PublicPaymentController`, still no `@UseGuards`; `confirmEnrolleePayment` still writes `PAID` with no gateway call in the path |
| DEF-02 | Present | `onboarding.service.ts:479` `findFirst` and `:524` `findUnique({where:{id}})` — still no `organizationId` |
| DEF-03 | Present | Lookup still returns the dependants list; `id: { startsWith: q.toLowerCase() }` still matches on 3 characters |
| DEF-04 | Present | 28 models in `schema.prisma`, none named Payment/Transaction/Receipt/Invoice/Ledger |
| DEF-05 | Present | No `AuditLog` model; the `Note` write is still inside `.catch(() => {})` |
| DEF-06 | Present | No test file references the path — only the two source files and their build artifacts |
| DEF-07 | Present | `PRODUCTION_CERTIFICATION.md:24` still reads "100% verified and defect-free"; `:33` still marks Authentication & Authorization **PASS** |

One check worth recording, because it is the thing that would have made DEF-01/02/03 false: **there is no global authentication guard.** The only `APP_GUARD` is `ThrottlerGuard` (`app.module.ts:66`), which rate-limits and does not authenticate, and the codebase has no `@Public()` / `IS_PUBLIC` opt-out mechanism. A controller without `@UseGuards` is therefore genuinely unauthenticated, exactly as §4 states.

`amount` is still taken from the request body and written straight to the record. `lookupEnrolleeForPayment` does resolve the real premium server-side (₦12,000 / ₦50,000 / ₦0), but `confirm` never consults it, so the server-side figure constrains nothing.

§1 (audited system ≠ described system) is a finding about the certification brief rather than the code, and is not re-assessed here. This repository is still Customer Care Agent.

**Nothing in this addendum reduces any severity.** Whether DEF-01/02/03 are an active incident or a backlog item still depends on one fact this document cannot establish: whether `/pay/informal` is deployed and reachable.
