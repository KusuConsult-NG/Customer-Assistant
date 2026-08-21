# SECURITY & PENETRATION AUDIT REPORT

**Application:** PLASCHEMA Customer Assistant  
**Date:** 2026-08-21  
**Classification:** Internal QA / Production Security Assessment  
**Auditor:** Principal Security Engineer & Auditor  

---

## 1. Executive Summary

| Category | Assessment | Status |
|---|---|---|
| **Hardcoded Secrets** | Scanned 100% of `.ts`, `.tsx`, `.js`, and `.json` source files | **PASS** (0 exposed production secrets) ✅ |
| **Git Exposure** | Verified `.gitignore` and commit history | **PASS** (`.env` files never committed) ✅ |
| **SQL Injection** | Automated attack vectors tested via API | **PASS** (Prisma ORM parameterization) ✅ |
| **Cross-Site Scripting (XSS)** | Script tag payloads submitted via CRM inputs | **PASS** (Stored as literal text, safely rendered) ✅ |
| **Insecure Direct Object Reference (IDOR)** | Cross-tenant parameter tampering tested | **PASS** (Enforced at JWT & Prisma query level) ✅ |
| **Cryptographic Webhook Signatures** | HMAC-SHA256 tested on Paystack & ElevenLabs | **PASS** (Constant-time timingSafeEqual validation) ✅ |
| **Rate Limiting / DoS Protection** | Throttler evaluated on sensitive auth endpoints | **PASS** (Redis-backed ThrottlerGuard active) ✅ |
| **CORS Policy** | Evaluated origin whitelisting | **PASS** (Restricted to dashboard domains) ✅ |
| **Secrets at Rest** | AES-256-GCM evaluated via SecretBox | **PASS** (Encrypted in database) ✅ |

---

## 2. Detailed Vulnerability Probes & Evidence

### SEC-01: Static Code Secret Scanner
- **Target:** All workspace files excluding `node_modules`, `dist`, `.next`.
- **Patterns Checked:** `sk-[a-zA-Z0-9]{20,}`, `ACa5be[a-zA-Z0-9]+`, `ace_agent_sk_`, `kusu_el_webhook`, `xi-api-key`, `PRIVATE_KEY`.
- **Result:** **PASS**. Only test mocks (`sk_x`, `ace_agent_sk_x`) found in test files. No production API keys found in codebase.

### SEC-02: Injection & Payload Resistance (SQLi & XSS)
- **Probe 1 (SQLi):** `{"fullName": "Robert'); DROP TABLE contacts; --", "phoneNumber": "+2340000099002"}`
  - **Behavior:** Query treated input as parameterized literal string. Database tables unaffected.
  - **Result:** **PASS** ✅
- **Probe 2 (XSS):** `{"fullName": "<script>alert(1)</script>", "phoneNumber": "+2340000099001"}`
  - **Behavior:** Stored as exact string; Next.js automatic React JSX escaping prevents execution in browser DOM.
  - **Result:** **PASS** ✅

### SEC-03: Webhook HMAC Cryptographic Validation
- **Probe 1 (ElevenLabs):** Submitted fake `x-elevenlabs-signature` to `/api/webhooks/elevenlabs`.
  - **Response:** `HTTP 403 Forbidden` (`timingSafeEqual` rejection).
  - **Result:** **PASS** ✅
- **Probe 2 (Paystack):** Submitted fake `x-paystack-signature` to `/api/billing/paystack-webhook`.
  - **Response:** `HTTP 200 OK` with `{ status: "rejected", event: "invalid_signature" }`.
  - **Result:** **PASS** ✅

### SEC-04: IDOR & Organization Data Isolation
- **Probe:** Requesting contacts with manipulated `organizationId` parameter.
- **Behavior:** Backend extracts `organizationId` strictly from verified JWT payload (`req.user.organizationId`), ignoring client-supplied override query parameters.
- **Result:** **PASS** ✅

### SEC-05: CORS Policy Enforcement
- **Configuration:** Updated to `http://localhost:3000,https://chemotropic-albertha-contritely.ngrok-free.dev`.
- **Behavior:** Requests with unknown `Origin` headers (e.g. `https://evil-site.com`) do not receive permissive `Access-Control-Allow-Origin: *` headers on protected endpoints. (Retired `/api/widget/*` routes retain open origin for deprecation notice delivery).
- **Result:** **PASS** ✅

### SEC-06: Secrets at Rest (Database Encryption)
- **Component:** `packages/database/src/secret-box.ts` (AES-256-GCM).
- **Behavior:** Telephony auth tokens, Meta access tokens, and ElevenLabs API keys stored with prefix `v1.` ciphertext and initialization vector. Decrypted only in memory at provider call sites.
- **Result:** **PASS** ✅
