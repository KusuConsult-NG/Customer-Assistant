# ACE Platform — Correctness & Security Audit

Full read of `apps/api`, `apps/web` and `packages/*` (~20k lines). Everything below
was found, and fixed, in this pass. Grouped by severity.

---

## Before you deploy

1. **Run the migration** — schema changes are required:
   ```bash
   npx prisma migrate deploy --schema=packages/database/prisma/schema.prisma
   ```
   (`packages/database/prisma/migrations/20260807000000_audit_fixes`). It is
   idempotent and de-duplicates existing conversation rows before adding the new
   unique constraint.

2. **Set the new environment variables** (see `.env.example`):
   - `WEBHOOK_SECRET` — outbound webhooks are no longer signed at all without it.
   - `API_BASE_URL` — must be your public API origin. Code previously read an
     undefined `API_URL`.
   - `TELNYX_CONNECTION_ID` — only if you use Telnyx.
   - `MAX_JSON_BODY_SIZE` — optional, defaults to `70mb`.

3. **Configure payment details per organization** (Settings → Payment Collection
   Details). The AI assistant used to recite a hardcoded bank account; it now
   escalates to a human when these are blank.

4. **Re-submit WhatsApp templates.** Existing templates were auto-marked `APPROVED`
   locally without ever being sent to Meta; the migration resets them to
   `PENDING_SUBMISSION`.

5. **Run the ingestion worker** if you use the knowledge base:
   `npm run worker --workspace @ace/api`. Add `pdf-parse` / `mammoth` for PDF/DOCX.

---

## Critical — the feature did not work at all

| # | Issue | Effect |
|---|-------|--------|
| 1 | **Sign-up was completely broken.** The register form posted `adminEmail` / `adminPassword` / `adminFullName`; the API reads `email` / `password` / `fullName`. All three arrived `undefined` and crashed inside bcrypt. The industry dropdown also offered values (`HOSPITALITY`, `HEALTHCARE`, `RETAIL`, `FINANCE`, `EDUCATION`) that are not in the `IndustryType` enum. | No one could create an account. |
| 2 | **Every API route was rate-limited to 5 requests/minute.** `ThrottlerModule.forRoot([...])` applies *all* named tiers to *every* route — they are ANDed, not selected by decorator — so the strict `auth` tier governed the whole API. | The app was unusable past 5 requests. |
| 3 | **Every `@Roles()` route returned 403.** `RolesGuard` was registered as a global `APP_GUARD`. Nest runs global guards *before* controller guards, so it ran before `JwtAuthGuard` populated `request.user`. | Billing, org settings and document deletion were unreachable for everyone, including owners. |
| 4 | **The Paystack webhook 500'd on every delivery.** The controller passed the JSON-parsed `@Body()` into `createHmac().update()`, which throws on a plain object. It then always returned `{status:'success'}`. | No payment ever activated a subscription; Paystack would eventually disable the endpoint. |
| 5 | **Email verification always 404'd.** The page issued `GET /api/auth/verify-email`; only `POST` existed. | No account could be verified. |
| 6 | **`/api/auth/setup-account` did not exist.** Invite emails link to `/setup-account?token=…`. | Invited team members could never set a password or log in. |
| 7 | **`/reset-password` page did not exist.** Every password-reset email linked to a 404. | Password reset was impossible. |
| 8 | **The document ingestion worker could never read a file.** It branched on `startsWith('http')` and otherwise called `fs.readFile(storageUrl)` — but `storageUrl` is a *Supabase Storage path*, not a local path. | Every queued document failed with ENOENT. |
| 9 | **Knowledge uploads were capped at 100 KB** (Express default) despite a documented 50 MB limit — `app.use(express.json({limit}))` after `NestFactory.create` is a no-op because Nest's parser already ran. | Any real document 413'd. |
| 10 | **Notifications never fired.** The layout connected to `io(API_URL)` — the default namespace, which has no gateway — and listened for event names the server never emits. | The bell icon was permanently empty. |
| 11 | **Twilio signature verification could never pass** and the media-stream URL fell back to `ws://localhost:4000`. Both read `process.env.API_URL`, which is defined nowhere (`.env` defines `API_BASE_URL`). | Every authenticated inbound call was answered "This call could not be authenticated. Goodbye." |
| 12 | **Human agent replies were never delivered.** `POST /api/conversations/:id/messages` wrote a `Message` row and returned it — nothing was ever sent to WhatsApp. | Agents saw their reply in the transcript and assumed the customer got it. |
| 13 | **Dashboard read flat fields from a nested response.** Analytics returns `{ metrics: {...} }`; the page read `dashboard.totalContacts` etc. | Conversations, bookings, reservations and open tickets were hardcoded 0; the rest silently reverted to page-limited CRM counts. |
| 14 | **`/api/analytics/overview` and `/api/billing/initialize-payment`** are called by the API client. Neither route has ever existed. |
| 15 | **Outbound calls used a placeholder number.** The lookup required `isDefault: true`, which `updateTelephonyConfig` never writes. | Every dashboard-configured org fell back to `+2348030000000`. |

## Critical — security & multi-tenancy

| # | Issue |
|---|-------|
| 16 | **Widget served an arbitrary tenant.** `getWidgetConfig` fell back to `prisma.organization.findFirst()` when the API key did not resolve — so a wrong, blank or guessed key returned the *first organization in the table*: its name, logo, AI persona and knowledge base, with the visitor's contact record and transcript filed under it. The `ApiKey` table with its `keyHash` column existed and was unused. |
| 17 | **Widget history leaked other customers' chats.** `getSessionHistory` ignored `sessionId` entirely and returned `findFirst({organizationId, channel: WEBCHAT})`. |
| 18 | **WhatsApp inbound fell back to "any active config"** when `phoneNumberId` did not match — routing a customer's message, the AI reply, the new contact and the transcript into an unrelated organization. |
| 19 | **Telephony inbound fell back to "the first telephony config"** for unrecognised numbers, with the same cross-tenant effect. It also auto-created a rogue "Default Organization". |
| 20 | **`sendAgentMessage` / `toggleHumanHandoff` had no org scoping** — any authenticated user could post into another tenant's conversation, delivered over that tenant's WhatsApp number. |
| 21 | **Both Socket.IO gateways were unauthenticated**, with `origin: '*'`, and `join_organization` joined whatever `organizationId` the client sent. Anyone reachable could stream a tenant's live messages, call transcripts and handoff events — and emit `agent_whisper` / `agent_takeover` into them. `monitor_call` accepted any `callSid`. |
| 22 | **Paying was optional.** The billing page called `/api/billing/activate` unconditionally right after opening checkout, then rendered a receipt. And `initializePaystackTransaction` called `activatePlan()` outright when `PAYSTACK_SECRET_KEY` was unset. Either path granted ENTERPRISE for free. |
| 23 | **SSRF guard was string-matching only.** It compared the hostname against literal private addresses, so a public DNS name resolving to `169.254.169.254`, decimal-encoded IPs, or IPv6-mapped forms all passed. Now resolves DNS and checks every address; redirects refused. Applied to outbound webhook URLs too. |
| 24 | **Logout did nothing.** It returned "Logged out successfully" while the access (1d) and refresh (7d) tokens stayed valid. Deactivating a user likewise had no effect until their token expired. Now `tokenVersion` is checked on every request. |
| 25 | **Hardcoded JWT secret fallbacks** in three places would silently sign tokens with a string published in this repository. |
| 26 | **`SubscriptionGuard` was dead on the WhatsApp controller** — applied at class level, so it ran before the per-route `JwtAuthGuard` and its own `if (!user) return true` waved everything through. |
| 27 | **`TenantContextMiddleware` interpolated a JWT claim straight into raw SQL.** (Unregistered, so unreachable — deleted.) |
| 28 | **The billing modal collected raw card number, expiry and CVV** in our own form. The data went nowhere, but the form put the app in PCI-DSS scope. Replaced with a Paystack handoff. |
| 29 | **Webhook signing fell back to `'ace-webhook-secret'`**, a literal in the source, so receivers could not distinguish us from anyone else. |
| 30 | Widget endpoints were `@SkipThrottle()` — unauthenticated, and calling OpenAI on every request. |

## Wrong assumptions — code that lied about what it did

| # | Issue |
|---|-------|
| 31 | **The AI denied being an AI.** Asked "are you a bot?", it replied *"Haha, no! I'm a customer support representative here at {org}"* under a `Stealth Human Persona` heading. Disclosure on request is required in several target markets (California B.O.T. Act §17941, EU AI Act Art. 50). Now answers honestly. Related: "is this a real person?" was matched by the *escalation* phrase list and silently queued the customer instead of answering — found by a test written for this fix. |
| 32 | **Fabricated bank details were read out to customers.** `Providus Bank / 9928374102` plus three invented USSD codes (`*737*000*<4 random digits>#`), in the orchestrator, the billing service, the billing page and an agent-console quick reply. Following them would have sent a customer's money to an account no tenant owns. Now sourced from per-org configuration, with a handoff when unset. |
| 33 | **Bookings were fabricated.** `executeBookAppointment` always wrote "tomorrow 10:00, General Consultation" regardless of the request, with no availability check, and replied "✅ Your appointment has been confirmed". Reservations always assumed 2 guests, 48h out. Now finds a genuinely free slot in business hours, parses party size and service from the message, and states what it booked. |
| 34 | **Timezone bug in booking.** `setHours(10)` uses *server* local time; on a UTC container that is 11:00 in Lagos, then re-rendered as Lagos time — customers were told an hour later than was reserved. |
| 35 | **`createBooking` had no conflict check at all** — unlimited double-bookings, each confirmed by email. |
| 36 | **Quotations were invented.** A flat `₦35,000` "Official Price Quotation" for every business in every industry, linking to `/api/documents/quotation/<n>.pdf` — a route that has never existed. `getQuotationData` had a similar fallback (₦150,000, "Valued Customer", `+234 800 000 0000`). |
| 37 | **The WhatsApp SDK faked successful sends.** If the access token contained "placeholder", every failure returned a synthetic `wamid.mock.…`. Callers logged `reply_delivered` and counted broadcasts as sent. |
| 38 | **Broadcasts reported phantom delivery.** With WhatsApp unconfigured: `sentCount = recipients.length`. A fully green campaign to an audience that received nothing. |
| 39 | **Every telephony provider fabricated call IDs** (`CA_TW_…`, `PL_…`, `AT_…`, `NG_TELCO_…`) on failure or where no integration exists. The API wrote a CallLog and showed a real-looking call that was never placed. Telnyx sent `connection_id: 'default'`, which is a 422. |
| 40 | **`verifyCallerId` was `phoneNumber.length >= 10`** — accepts `"abcdefghij"`. |
| 41 | **The 24h SMS rule never fired.** `isPaid = notes.includes('[PAID]') \|\| status === 'CONFIRMED'` — and the query already filters `status: 'CONFIRMED'`, so it was constant `true`. |
| 42 | **SMS was never sent.** `sendSmsNotification` logged `sms_reminder_sent` and returned; no SMS provider is integrated anywhere. |
| 43 | **Booking emails asserted payment.** A hardcoded `Payment Status: CONFIRMED / PAID` on an "Official Booking Confirmation & Service Receipt" — a proof of payment for money that may never have changed hands. |
| 44 | **The reminder service created `new Resend('re_mock_key')`** and issued a real 401-generating request per reminder, four times per booking, every five minutes. |
| 45 | **`aiReplyRate` was always null.** `totalAiMessages` / `totalMessages` were declared and never assigned. `handoverRate` was `tickets / conversations` — unrelated populations, could exceed 100%. |
| 46 | **The dashboard invented data**: a hardcoded 68% conversion rate for accounts with no leads, a synthetic flat 7-day "trend" from all-time totals, and an unconditional "System Status: Optimal" — shown while the API was unreachable. |
| 47 | **Crawled pages and the inline-upload fallback wrote chunks with no embeddings**, then reported `INDEXED`. Semantic search could never find them. |
| 48 | **Deleted documents stayed searchable.** Vectors were left in Qdrant with a comment claiming the worker cleaned them up on re-index — it does not. The AI kept quoting deleted documents. |
| 49 | **PDFs and DOCX were decoded as UTF-8**, then chunked, embedded and stored as if the resulting binary noise were prose. |
| 50 | **WhatsApp templates were created `status: 'APPROVED'`** locally without ever being submitted to Meta. Every broadcast using one fails with error 132001. |
| 51 | **The Paystack `callback_url` pointed at `/api/billing/paystack/callback`** — a route that has never existed. Every paying customer landed on a 404 immediately after being charged. |
| 52 | **The widget embed snippet was unusable**: it showed the literal key `ace_live_demo_key_123` (`/organizations/me` never returns an `apiKey`), and pointed `src` at the API origin, where `widget.js` does not exist — it is served by the web app. `widget.js` itself defaulted to `http://localhost:4000`. |
| 53 | **The `Conversation` unique constraint the code depended on did not exist.** Both `upsertConversation` implementations catch Prisma `P2002` to resolve a race that could therefore never be caught — concurrent inbound messages split one customer's history across duplicate rows. |
| 54 | **`shared-types` enums had members the database did not** (`MESSENGER`, `MTN_ENTERPRISE_SIP`, `AIRTEL_BUSINESS_SIP`) — selecting them threw at insert. |
| 55 | **`organizationSettings` / `organization.planTier` were queried but do not exist** in the schema; wrapped in `try {} catch {}` so `voiceLanguage` was never configurable. |
| 56 | **`recordUsageAndCheckQuota` returned simulated usage** — `Math.floor(limit * 0.34)`. |
| 57 | **`executeWorkflowTrigger` executed nothing** — it counted matching workflows and returned. `WorkflowService`'s action handler was an empty `switch` with comments. |
| 58 | **No indexes on `organizationId`** anywhere, despite every query filtering on it. |

## Dead code removed

Registered in no module and reachable from nothing: `SubscriptionMeteringService`
(simulated usage), `AiEvaluationService` (fabricated confidence scores and a
hardcoded "Apex Care Service Catalog 2026 Page 3"), `WorkflowService` +
`WorkflowEvaluatorEngine` (hardcoded fake workflow list, no-op actions),
`QueueService` (in-memory queue that drops jobs on restart),
`MetricsTelemetryService` (P99 defaulting to a made-up 145ms),
`TenantContextMiddleware` (SQL injection), `ReservationEngineService` (hardcoded
tables, random room numbers, `available: true` always), and a duplicate
`auth/roles.guard.ts`.

`CrmTimelineService` was fully implemented but unregistered — it is now wired up at
`GET /api/crm/contacts/:id/timeline` rather than deleted.

## Tests

The suite passed 7/7 while registration was completely broken, because assertions
accepted ranges (`expect([200, 201, 400]).toContain(res.status)`). The package suites
had **no `test` script at all**, so `npm test` never ran them — and the telephony-sdk
suite had been failing for some time unnoticed.

Now **77 tests**, each with one acceptable outcome:
- `apps/api/test/api-integration.spec.ts` — 22 (auth enforcement, tenant isolation, payload contracts, webhook signatures)
- `apps/api/test/ssrf.spec.ts` — 23 (DNS-resolution bypasses, schemes, IPv6 forms)
- `packages/orchestrator/test/orchestrator.spec.ts` — 17 (AI disclosure, payment honesty, real slot booking, quotations)
- `packages/telephony-sdk/test/` — 12, `packages/whatsapp-sdk/test/` — 3

```bash
npm test          # everything
npm run typecheck # both apps
```

## Not fixed — flagged for a decision

- **`packages/voice-biometrics`** returns `verified: true, matchScore: 0.96` for any
  audio over 10 characters. It is imported by nothing. Do not wire it up as-is: it is
  an authentication bypass wearing a security feature's name.
- **`packages/omnichannel-adapters`** — Instagram / Messenger / Telegram / Email
  adapters whose `sendMessage` is `return true`. Unused.
- **`packages/scheduling-engine`** — real slot logic, unused; `SchedulingEngine`
  duplicates what the orchestrator now does.
- **`CalendarSyncService.syncToExternalCalendar`** returns a mock `gcal_…` id; no
  Google/Outlook OAuth exists. Unregistered.
- **`packages/pdf-generator`** produces HTML, not PDF, and advertises a `.pdf` URL.
  No route serves it.
- **Voice**: Plivo and Africa's Talking cannot do real-time AI (different streaming
  protocols); only Twilio is implemented. This is now explicit in the SDK rather than
  implied by fake success.

---

## Pass 3 additions (workflow engine, onboarding selfie)

### Workflow engine — built, not patched

The audit's original entry for the workflow module described an empty `switch` with
`// Trigger WhatsApp SDK message send` comments. The real defect was one layer down: the
stored graph had no executable content, so the switch had nothing to dispatch on. Nodes
now carry `kind` + `action` + typed `config`; legacy presentational nodes are parsed and
marked `UNCONFIGURED` with the reason, never guessed at.

New: `workflow.types.ts`, `workflow-actions.service.ts`, `workflow-executor.service.ts`,
`workflow-trigger.service.ts`, `workflow-runner.service.ts`, plus `workflow_runs` and
`workflow_run_steps`. Domain events fire from CRM, WhatsApp, the web widget, scheduling
and telephony via a `@Global()` trigger service — deliberately split from
`WorkflowsModule` so domain modules can emit without a circular module graph.

Three defects were found by running it, not by reading it: every step executed twice
(worker/sweeper race on an unconditional status update), conditions gated nothing
(unbranded edges were always followed), and the inline sweeper generated continuous
`P2024` pool timeouts while the queue was healthy. All three are described with their
measurements in `VALIDATION-REPORT.md` §P3.1.

### Onboarding selfie capture — new capability

`apps/api/src/onboarding/`, `apps/api/src/common/object-storage.ts`,
`apps/api/src/common/image-validation.ts`, `packages/database/src/selfie-request.ts`,
`apps/web/src/app/selfie/[token]/page.tsx`,
`apps/web/src/components/SelfieRequestPanel.tsx`.

The design choices worth knowing before changing anything here:

- The upload token is stored **only as a SHA-256 hash**, so a link cannot be recovered by
  anyone. "Resend the link" therefore has to mint a new request.
- A voice call cannot carry an image, so a `VOICE` request always sends a link over
  WhatsApp — and the AI only claims it was sent when the send returned success.
- Image type comes from **magic bytes**, never the declared Content-Type. SVG is refused:
  it is a script-capable document.
- `verifiedAt` is never set. This captures a photo; it does not verify an identity. Do
  not repurpose that column without an actual biometric provider behind it, and do not
  let any UI label a captured photo "verified".

### Two pre-existing defects this uncovered

- **Every Supabase Storage upload failed.** The uploader omitted the `apikey` header
  Supabase Storage requires; the resulting `403 Invalid Compact JWS` arrives wrapped in
  an HTTP 400 and reads like a bad request. The knowledge-base uploader had carried this
  from the start, and no test had ever completed a real upload — the knowledge suite
  covered rejection paths and the crawler only. Storage is now one shared module, and
  `KB-005` uploads a document and fetches it back.
- **`getDocumentDownloadUrl` had no route.** An uploaded document could be stored and
  never retrieved. `GET /api/knowledge/documents/:id/download` now exists.

### Deployment note

Two private Supabase Storage buckets must exist: `knowledge-documents` and
`onboarding-selfies` (the latter restricted to `image/jpeg|png|webp`, 8MB per object).
They were absent in this project — a consequence of the upload bug above, since nothing
had ever successfully written to one.

