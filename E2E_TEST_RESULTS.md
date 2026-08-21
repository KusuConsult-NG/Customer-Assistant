# END-TO-END (E2E) TEST RESULTS

**Application:** PLASCHEMA Customer Assistant  
**Execution Timestamp:** 2026-08-21T07:05:00Z  
**Target Stack:** Next.js (Web :3000), NestJS (API :4000), PostgreSQL (:5432), Redis (:6379), Static ngrok Gateway  
**Auditor:** Principal QA / Production Readiness Auditor  

---

## 1. Automated Playwright Frontend E2E Suite

**Suite Status: 22 / 22 PASSED (100%)** 🚀  
**Execution Time:** 14.6 seconds  
**Browser Engine:** Chromium (Headless Shell 151.0.7922.34)  

| Test Spec File | Test Case | Status | Duration |
|---|---|---|---|
| `e2e/customer-journeys.spec.ts` | J1 & J9: the web chat widget is retired, and the dashboard does not offer it | **PASS** ✅ | 2.3s |
| `e2e/customer-journeys.spec.ts` | J2: Telephony Dashboard & Voice Simulator | **PASS** ✅ | 2.2s |
| `e2e/customer-journeys.spec.ts` | J3: CRM Pipeline & Contacts Board | **PASS** ✅ | 4.3s |
| `e2e/customer-journeys.spec.ts` | J5 & J6: Scheduling & Refund Request Management | **PASS** ✅ | 2.2s |
| `e2e/customer-journeys.spec.ts` | J7: Settings & Team Management | **PASS** ✅ | 4.4s |
| `e2e/customer-journeys.spec.ts` | J8: Billing & Plan Comparison | **PASS** ✅ | 946ms |
| `e2e/customer-journeys.spec.ts` | J10: Workflows Automation Engine | **PASS** ✅ | 942ms |
| `e2e/customer-journeys.spec.ts` | Auth guard: unauthenticated visitor is redirected to login | **PASS** ✅ | 4.4s |
| `e2e/hosted-agent-settings.spec.ts` | displays dedicated workspace status and masked key fingerprint | **PASS** ✅ | 5.6s |
| `e2e/hosted-agent-settings.spec.ts` | renders webhook URL matching current ngrok endpoint | **PASS** ✅ | 6.1s |
| `e2e/hosted-agent-settings.spec.ts` | leaves credential input empty so masks cannot be saved as secrets | **PASS** ✅ | 5.0s |
| `e2e/hosted-agent-settings.spec.ts` | offers no credential change form to viewers | **PASS** ✅ | 5.0s |
| `e2e/live-console.spec.ts` | shows a call the AI is handling right now | **PASS** ✅ | 2.7s |
| `e2e/live-console.spec.ts` | shows the transcript so far when the call is opened | **PASS** ✅ | 1.9s |
| `e2e/live-console.spec.ts` | offers no reply box for a live call | **PASS** ✅ | 4.5s |
| `e2e/live-console.spec.ts` | offers a transfer, and says where the call goes | **PASS** ✅ | 4.2s |
| `e2e/live-console.spec.ts` | shows the server refusal verbatim rather than a cheerier version | **PASS** ✅ | 862ms |
| `e2e/live-console.spec.ts` | confirms only what actually happened | **PASS** ✅ | 4.3s |
| `e2e/live-console.spec.ts` | offers no transfer button for a WhatsApp conversation | **PASS** ✅ | 725ms |
| `e2e/live-console.spec.ts` | says how stale the view is rather than claiming to be live | **PASS** ✅ | 733ms |
| `e2e/live-console.spec.ts` | hides the live section entirely when no call is in progress | **PASS** ✅ | 643ms |
| `e2e/live-console.spec.ts` | does not present a live call as a stored conversation | **PASS** ✅ | 549ms |

---

## 2. Mandatory Business Journey Suite (10 Live Workflows)

| Journey # | Description | Live Verification Path | Result | Evidence & Metrics |
|---|---|---|---|---|
| **TEST 01** | Inbound Inquiry & RAG Knowledge Retrieval | Client → `/api/knowledge/faqs` & `/api/knowledge/search` → Postgres RAG Chunks → Response | **PASS** ✅ | 20 FAQs loaded; 5 official PLASCHEMA guides indexed; 4 actual call transcripts verified in DB |
| **TEST 02** | Voice AI Appointment Booking | Contact lookup → `POST /api/scheduling/bookings` → Postgres Conflict Guard → Confirmation | **PASS** ✅ | Booking created (`e1e8a739-7b76...`) for contact Comfort Pam Badung with conflict prevention |
| **TEST 03** | AI-Guided Service Payment Workflow | `POST /api/billing/service-payment-guidance` → Payout Account Resolution → Structured Instructions | **PASS** ✅ | Generates secure reference (`ACE_SVC_ee993e_287D4CAE`, ₦12,000) linked to official agency payout account |
| **TEST 04** | WhatsApp Message Ingestion to CRM | Inbound Webhook → HMAC Verify → Contact Match → Conversation Store → CRM Update | **PASS** ✅ | WhatsApp conversations correctly indexed in CRM with message history and contact links |
| **TEST 05** | WhatsApp Patient Appointment Scheduling | WhatsApp Inbound → Orchestrator Slot Filling → Booking Engine → WhatsApp Confirmation | **BLOCKED** ⏳ | Pending active Meta template approval (`plaschema_selfie_request`) for live mobile handset verification |
| **TEST 06** | Web Chat Channel Deprecation Safety | Client request to `/api/widget/chat` & `/widget.js` | **PASS** ✅ | Returns HTTP 410 Gone with deprecation notice; prevents unmonitored chat leaks |
| **TEST 07** | Human Agent Escalation / Live Takeover | `PATCH /api/conversations/:id/handoff` with `{ handoff: true }` | **PASS** ✅ | Successfully toggles `isHumanHandoffActive`, reassigns operator, and restores AI state |
| **TEST 08** | Out-of-Scope Query & Anti-Hallucination Guard | Search query with irrelevant input ("crypto token airdrop") against knowledge engine | **PASS** ✅ | Strict boundary matching; 0 irrelevant matches, triggers escalation guidance |
| **TEST 09** | Outbound Call Telephony Dispatch | `POST /api/agent-provisioning/numbers` & Outbound Call API | **BLOCKED** ⏳ | Outbound requires carrier DID assignment; Agent configuration verified (`agent_3801m0c9terzf58tskm00cp3d008`) |
| **TEST 10** | Paystack Webhook Verification & Plan Provisioning | HMAC-SHA256 Signed Webhook (`charge.success`) → Raw Body Hash Match → Plan Upgrade | **PASS** ✅ | Validated signature match, idempotency check, and organization plan activation |

---

## 3. Mobile Camera & Public Selfie Upload Validation

- **Test Path:** `https://chemotropic-albertha-contritely.ngrok-free.dev/selfie/:token`
- **Asset Reverse Proxy:** Tested via external tunnel; CSS bundles and JavaScript chunks return `200 OK` (0 missing chunks).
- **Client API Resolution:** Mobile JavaScript uses public ngrok domain rather than `localhost:4000`.
- **Photo Capture:** Native camera input (`capture="user"`) prompts phone camera interface.
