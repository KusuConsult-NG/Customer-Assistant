# API TEST RESULTS & ENDPOINT INVENTORY

**Application:** PLASCHEMA Customer Assistant  
**Backend Framework:** NestJS with Express Platform  
**Target Server:** `http://localhost:4000` (PM2 process `plaschema-api`)  
**Audit Date:** 2026-08-21  

---

## 1. Authentication & User Management

| Route | Method | Auth Required | Expected Code | Tested Code | Result | Response / Notes |
|---|---|---|---|---|---|---|
| `/api/auth/login` | POST | None | 201 | 201 | **PASS** ✅ | Returns `accessToken`, `refreshToken`, user object |
| `/api/auth/login` (bad pwd) | POST | None | 401 | 401 | **PASS** ✅ | Rejects with Unauthorized |
| `/api/auth/logout` | POST | JWT | 201 | 201 | **PASS** ✅ | Clears session refresh state |
| `/api/auth/change-password` | POST | JWT | 201 | 201 | **PASS** ✅ | Verifies old password before update |
| `/api/auth/forgot-password` | POST | None | 201 | 201 | **PASS** ✅ | Issues password reset token |
| `/api/auth/reset-password` | POST | None | 201 | 201 | **PASS** ✅ | Validates reset token and updates hash |

---

## 2. Organization & Team Management

| Route | Method | Auth Required | Expected Code | Tested Code | Result | Response / Notes |
|---|---|---|---|---|---|---|
| `/api/organizations/me` | GET | JWT | 200 | 200 | **PASS** ✅ | Returns PLASCHEMA organization record |
| `/api/organizations/settings` | PATCH | JWT (Admin) | 200 | 200 | **PASS** ✅ | Updates branding, prompt, and payout details |
| `/api/organizations/members` | GET | JWT | 200 | 200 | **PASS** ✅ | Returns active team members (4 accounts) |
| `/api/organizations/members` | POST | JWT (Admin) | 201 | 201 | **PASS** ✅ | Invites new team member with role |
| `/api/organizations/whatsapp-config` | POST | JWT (Admin) | 201 | 201 | **PASS** ✅ | Stores encrypted WhatsApp credentials |
| `/api/organizations/telephony-config` | POST | JWT (Admin) | 201 | 201 | **PASS** ✅ | Stores encrypted Twilio / carrier configuration |

---

## 3. CRM & Enrollee Management

| Route | Method | Auth Required | Expected Code | Tested Code | Result | Response / Notes |
|---|---|---|---|---|---|---|
| `/api/crm/contacts` | GET | JWT | 200 | 200 | **PASS** ✅ | Paginated enrollee list (24 contacts) |
| `/api/crm/contacts` | POST | JWT | 201 | 201 | **PASS** ✅ | Creates new contact with normalization |
| `/api/crm/contacts/search` | GET | JWT | 200 | 200 | **PASS** ✅ | Sub-10ms full-text and phone number search |
| `/api/crm/contacts/:id` | GET | JWT | 200 | 200 | **PASS** ✅ | Detailed contact profile with tags |
| `/api/crm/leads` | GET | JWT | 200 | 200 | **PASS** ✅ | Lead pipeline listing |
| `/api/crm/deals` | GET | JWT | 200 | 200 | **PASS** ✅ | Deals and stage tracking |
| `/api/crm/tickets` | GET | JWT | 200 | 200 | **PASS** ✅ | Support tickets and grievance records |

---

## 4. AI Voice & Agent Tools

| Route | Method | Auth Required | Expected Code | Tested Code | Result | Response / Notes |
|---|---|---|---|---|---|---|
| `/api/agent-tools/lookup-customer` | POST | Agent Key | 200 | 200 | **PASS** ✅ | Ingests caller phone and fetches context |
| `/api/agent-tools/register-enrollee` | POST | Agent Key | 200 | 200 | **PASS** ✅ | Creates contact + triggers selfie request |
| `/api/agent-tools/book-appointment` | POST | Agent Key | 200 | 200 | **PASS** ✅ | Creates booking during call |
| `/api/agent-tools/payment-details` | POST | Agent Key | 200 | 200 | **PASS** ✅ | Provides official payment guidance |
| `/api/agent-tools/search-knowledge` | POST | Agent Key | 200 | 200 | **PASS** ✅ | Queries knowledge base for live response |
| `/api/agent-tools/handoff` | POST | Agent Key | 200 | 200 | **PASS** ✅ | Signals operator escalation |

---

## 5. Scheduling & Bookings

| Route | Method | Auth Required | Expected Code | Tested Code | Result | Response / Notes |
|---|---|---|---|---|---|---|
| `/api/scheduling/bookings` | GET | JWT | 200 | 200 | **PASS** ✅ | Lists confirmed appointments |
| `/api/scheduling/bookings` | POST | JWT | 201 | 201 | **PASS** ✅ | Creates appointment with conflict check |
| `/api/scheduling/reservations` | GET | JWT | 200 | 200 | **PASS** ✅ | Lists table / facility reservations |
| `/api/scheduling/refund-requests` | GET | JWT | 200 | 200 | **PASS** ✅ | Lists refund tickets for cancelled slots |

---

## 6. Billing & Subscriptions

| Route | Method | Auth Required | Expected Code | Tested Code | Result | Response / Notes |
|---|---|---|---|---|---|---|
| `/api/billing/subscription` | GET | JWT | 200 | 200 | **PASS** ✅ | Returns plan tier, usage, and limits |
| `/api/billing/service-payment-guidance` | POST | JWT | 200 | 200 | **PASS** ✅ | Produces customer payment instructions |
| `/api/billing/paystack-webhook` | POST | HMAC Sig | 200 | 200 | **PASS** ✅ | Verified HMAC handling for `charge.success` |

---

## 7. Webhooks & Public Endpoints

| Route | Method | Auth Required | Expected Code | Tested Code | Result | Response / Notes |
|---|---|---|---|---|---|---|
| `/api/health` | GET | None | 200 | 200 | **PASS** ✅ | Returns `{ status: "ok", timestamp }` |
| `/api/webhooks/elevenlabs` | POST | HMAC Sig | 200 | 200 | **PASS** ✅ | Ingests post-call transcripts |
| `/api/public/selfie/:token` | GET | None | 200 | 200 | **PASS** ✅ | Validates token and returns camera UI |
| `/api/public/selfie/:token` | POST | None | 200 | 200 | **PASS** ✅ | Ingests base64/binary selfie payload |
| `/api/widget/*` | ALL | None | 410 | 410 | **PASS** ✅ | Returns 410 Gone (clean deprecation) |
