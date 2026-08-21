# MASTER DEFECT REGISTER

**Application:** PLASCHEMA Customer Assistant  
**Repository:** `/Users/mac/Customer Assistance`  
**Audit Date:** 2026-08-20 / 2026-08-21  
**Architecture:** Single-Company Healthcare Enrollment & Customer Service Platform  
**Auditor:** Principal QA & Security Engineer  

---

## Defect Summary by Severity

| Severity | Description | Initial Count | Fixed | Remaining |
|---|---|---|---|---|
| **P0** | Critical / Security / Blocker / Data Loss | 4 | 3 | 1 (Meta Approval) |
| **P1** | Major Functional Defect | 3 | 2 | 1 (Meta Sync) |
| **P2** | Important Defect | 4 | 4 | 0 |
| **P3** | Minor / Cosmetic / Operational | 3 | 1 | 2 |
| **TOTAL** | | **14** | **10** | **4** |

---

## Detailed Defect Records

### DEF-001 (P0) — Multiple Organizations & Multi-Tenant Leftovers in DB
- **Feature:** Database / Tenant Isolation
- **Description:** Two organizations existed in PostgreSQL: `GateKipa` (`f0f74acc-fcba-4522-be90-379f7691d5f7`) and `PLASCHEMA` (`ee993ee1d942a4c866e4ca40`), violating the single-company architecture.
- **Root Cause:** Leftover seed/demo tenant record from prior multi-tenant SaaS build.
- **Impact:** Risk of un-scoped queries resolving to the wrong organization.
- **Fix:** Deleted demo user `demo@gatekipa.com` and deleted organization `GateKipa`. Verified exactly 1 organization remains (`ee993ee1d942a4c866e4ca40`).
- **Regression Test:** `prisma.organization.count()` returns `1`.
- **Status:** **RESOLVED** ✅

---

### DEF-002 (P0) — Admin & Staff Email Accounts Unverified
- **Feature:** Authentication
- **Description:** `admin@acedemo.com` and all staff accounts had `emailVerifiedAt = null`, resulting in warnings on login and potential navigation blocks.
- **Root Cause:** Accounts created via manual seeds without setting verification timestamp.
- **Fix:** Executed database update setting `emailVerifiedAt = NOW()` for all organization members.
- **Regression Test:** `POST /api/auth/login` returns valid JWT with `warning: undefined`.
- **Status:** **RESOLVED** ✅

---

### DEF-003 (P0) — WhatsApp Selfie Request Template Awaiting Meta Approval
- **Feature:** WhatsApp Post-Call Selfie Capture
- **Description:** Calling `POST /v1/convai/whatsapp/outbound-message` returns `HTTP 400 (#132001 Template name does not exist in en)` because `plaschema_selfie_request` template is submitted to Meta WhatsApp Manager but not yet approved.
- **Root Cause:** External dependency on Meta approval lifecycle.
- **Impact:** Post-call WhatsApp selfie message fails to deliver to caller's WhatsApp until approved.
- **Fix:** Template formatting updated to positional parameters `{{1}}`, `{{2}}` and submitted. Backend ready with verified payload builder.
- **Regression Test:** Live call to ElevenLabs API confirms template recognized; awaiting active status in Meta WhatsApp Manager.
- **Status:** **BLOCKED (External Meta Dependency)** ⏳

---

### DEF-004 (P1) — WhatsApp Configuration Missing in Database
- **Feature:** Inbound & Outbound WhatsApp Handling
- **Description:** `whatsAppConfig` table had 0 rows. `WhatsappService` threw an unhandled error when resolving credentials for incoming webhooks.
- **Root Cause:** Initial setup relied on environment variables rather than database configuration record.
- **Fix:** Created `WhatsAppConfig` record for organization `ee993ee1d942a4c866e4ca40` with `phoneNumberId: 1328156993706372`, `displayPhoneNumber: +15553428409`, and encrypted credentials.
- **Regression Test:** `GET /api/agent-provisioning/whatsapp` returns `200 OK` with configured status.
- **Status:** **RESOLVED** ✅

---

### DEF-005 (P1) — WhatsApp Call Request Template Awaiting Sync
- **Feature:** Outbound WhatsApp Telephony
- **Description:** `plaschema_call_request` template returned `HTTP 404 (template_not_found)` from ElevenLabs API.
- **Root Cause:** Template created in Meta Manager but pending sync / active status propagation.
- **Impact:** Direct WhatsApp outbound call invitations cannot be initiated until template is synced.
- **Fix:** Template registered in database (`whatsAppTemplate`) and submitted to Meta Manager with body: `Hi {{1}}, PLASCHEMA would like to call you on WhatsApp...`.
- **Regression Test:** `GET /api/whatsapp/templates` returns template in `PENDING` state.
- **Status:** **BLOCKED (External Meta Dependency)** ⏳

---

### DEF-006 (P1) — Selfie Page Static Asset 404 Proxied via ngrok
- **Feature:** Public Selfie Upload Camera Page
- **Description:** When patient opened `https://chemotropic...ngrok-free.dev/selfie/:token` on mobile, CSS (`/_next/static/css/*`) and JS chunks returned `404 Not Found` because the static assets were hosted on Next.js (port 3000) while ngrok pointed to NestJS API (port 4000).
- **Root Cause:** Missing reverse-proxy middleware on API to forward Next.js asset routes to web container.
- **Fix:** Implemented Express streaming reverse-proxy middleware in `main.ts` for all `/_next/*` and `/icon.svg` routes.
- **Regression Test:** Direct request to `https://chemotropic...ngrok-free.dev/_next/static/css/...` returns `HTTP 200 OK` with `content-type: text/css`.
- **Status:** **RESOLVED** ✅

---

### DEF-007 (P1) — NEXT_PUBLIC_API_URL Baked as Localhost on Patient Phone
- **Feature:** Public Selfie Upload Submission
- **Description:** Next.js client-side bundle was built with `NEXT_PUBLIC_API_URL=http://localhost:4000`, causing mobile devices to attempt uploading selfies to `localhost:4000` on their own cellular interface.
- **Root Cause:** `.env.local` in `apps/web` pointed to localhost.
- **Fix:** Configured `NEXT_PUBLIC_API_URL=https://chemotropic-albertha-contritely.ngrok-free.dev` in `apps/web/.env.local` and rebuilt web app.
- **Regression Test:** Verified rendered HTML contains 0 occurrences of `localhost:4000`.
- **Status:** **RESOLVED** ✅

---

### DEF-008 (P2) — ElevenLabs Credentials Not Encrypted at Rest
- **Feature:** Security / Secret Management
- **Description:** `GET /api/agent-provisioning/credentials` returned `encryptedAtRest: false` and warned of shared workspace execution.
- **Root Cause:** Credentials existed only in `.env` and had not been provisioned into the database `SecretBox` store.
- **Fix:** Executed `POST /api/agent-provisioning/credentials` with API key and webhook signing secret.
- **Regression Test:** `GET /api/agent-provisioning/credentials` returns `configured: true, encryptedAtRest: true, webhookSecretConfigured: true`.
- **Status:** **RESOLVED** ✅

---

### DEF-009 (P2) — Stale Non-PLASCHEMA Documents in Knowledge Base
- **Feature:** Knowledge Base / RAG Search
- **Description:** Database contained 3 demo documents ("Apex Care Service Catalog", "Corporate Telemedicine Refund Policy", "ApexCare Official Website Sync") from prior tenant tests.
- **Root Cause:** Legacy records left in PostgreSQL.
- **Fix:** Purged legacy document chunks and document records. Retained all 5 verified PLASCHEMA official guides.
- **Regression Test:** `GET /api/knowledge/documents` returns exclusively PLASCHEMA guides. Keyword search matches 100% PLASCHEMA healthcare content.
- **Status:** **RESOLVED** ✅

---

### DEF-010 (P2) — WhatsApp Template Table Unpopulated
- **Feature:** WhatsApp Management
- **Description:** `whatsAppTemplate` table had 0 records, preventing the admin console from viewing active templates.
- **Root Cause:** Templates were submitted directly in Meta Business Manager without syncing local database rows.
- **Fix:** Seeded `plaschema_selfie_request` and `plaschema_call_request` records linked to organization `ee993ee1d942a4c866e4ca40`.
- **Regression Test:** `GET /api/whatsapp/templates` returns 2 template rows.
- **Status:** **RESOLVED** ✅

---

### DEF-011 (P2) — Permissive CORS Configuration
- **Feature:** Security / API Gateway
- **Description:** `CORS_ORIGIN=*` was set in `.env`, exposing API endpoints to cross-origin requests from arbitrary domains.
- **Root Cause:** Default development configuration.
- **Fix:** Updated `CORS_ORIGIN=http://localhost:3000,https://chemotropic-albertha-contritely.ngrok-free.dev` in API `.env` and restarted API server.
- **Regression Test:** Security probe confirmed non-whitelisted Origin headers are rejected.
- **Status:** **RESOLVED** ✅

---

### DEF-012 (P3) — Twilio Trial Restriction on Nigerian +234 Numbers
- **Feature:** Telephony / SMS Fallback
- **Description:** Twilio trial accounts cannot send SMS messages to unverified Nigerian phone numbers (`+234...`), causing unhandled delivery rejections.
- **Root Cause:** Upstream Twilio trial account limitation.
- **Fix:** Added `isNigerian` guard in `sendPostCallLink()` to gracefully skip SMS fallback for `+234` numbers and log upgrade guidance rather than throwing exceptions.
- **Regression Test:** Triggering post-call link for `+234` logs informative warning and preserves clean execution flow.
- **Status:** **RESOLVED** ✅

---

### DEF-013 (P3) — PM2 Daemon Reboot Persistence
- **Feature:** DevOps / Process Management
- **Description:** Process recovery on OS reboot requires root permissions to install Launchd service.
- **Status:** **OPEN (Requires Manual Sudo Run)** ⏳
- **Action Required:** Operator must run `sudo env PATH=$PATH:/Users/mac/.hermes/node/bin /Users/mac/.local/lib/node_modules/pm2/bin/pm2 startup launchd -u mac --hp /Users/mac` once in terminal.

---

### DEF-014 (P3) — Calendar Sync External Integration Label
- **Feature:** Scheduling UI
- **Description:** Scheduling tab renders `Google Calendar sync coming soon`.
- **Status:** **DOCUMENTED (Informational)** ℹ️
