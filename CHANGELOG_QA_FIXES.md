# CHANGELOG: QA REMEDIATION & FIXES

**Application:** PLASCHEMA Customer Assistant  
**Date:** 2026-08-20 / 2026-08-21  
**Audit Cycle:** Production Certification & Security Hardening  

---

## 1. Architecture & Database Migration to Single-Company

- **Removed Stale Demo Tenant:** Deleted `GateKipa` (`f0f74acc-fcba-4522-be90-379f7691d5f7`) organization and its associated demo user (`demo@gatekipa.com`). Exactly 1 company record (`PLASCHEMA`, `ee993ee1d942a4c866e4ca40`) remains in PostgreSQL.
- **Email Verification Update:** Set `emailVerifiedAt` timestamp on all 4 organization member accounts (`admin@acedemo.com`, `sarah.adebayo`, `chidi.ezekiel`, `amaka.nwosu`), eliminating login warnings and guard redirections.
- **Created WhatsApp Database Configuration:** Seeded `whatsAppConfig` row with `phoneNumberId: 1328156993706372`, `displayPhoneNumber: +15553428409`, and encrypted credentials, fixing webhook resolution crashes.
- **Knowledge Base Cleanup:** Purged 3 legacy non-PLASCHEMA demo documents ("Apex Care Service Catalog", "Corporate Telemedicine Refund Policy", "ApexCare Official Website Sync"). 5 official PLASCHEMA documents remain with indexed search chunks.
- **Seeded WhatsApp Template Cache:** Added local records for `plaschema_selfie_request` and `plaschema_call_request` in `whatsAppTemplate` table.

---

## 2. Reverse Proxy & Public Mobile Upload Fixes

- **Next.js Static Asset Streaming Proxy:** Added Express reverse-proxy middleware in `apps/api/src/main.ts` for all `/_next/*` and `/icon.svg` requests before `app.listen()`. Fixes missing CSS/JS 404s when mobile devices load the selfie capture page via the public ngrok tunnel.
- **Environment URL Realignment:** Updated `NEXT_PUBLIC_API_URL=https://chemotropic-albertha-contritely.ngrok-free.dev` in `apps/web/.env.local` and rebuilt web bundle to prevent mobile browsers from making cross-origin requests to `localhost:4000`.

---

## 3. Security & Gateway Hardening

- **CORS Lockdown:** Changed `CORS_ORIGIN` from wildcard `*` to strict whitelist `http://localhost:3000,https://chemotropic-albertha-contritely.ngrok-free.dev`.
- **Encrypted ElevenLabs Workspace Store:** Encrypted ElevenLabs API key and webhook secret in database using `SecretBox` (AES-256-GCM) via `POST /api/agent-provisioning/credentials`.
- **Twilio Carrier Safeguard:** Implemented `isNigerian` phone number check in `sendPostCallLink()` to gracefully handle trial SMS delivery constraints on `+234` numbers.

---

## 4. Process Reliability & DevOps

- **PM2 Ecosystem Configuration:** Created `ecosystem.config.js` and registered `plaschema-api` (port 4000) and `plaschema-web` (port 3000) with memory thresholds and auto-restart policies.
- **Startup Script:** Created `start-plaschema.sh` to initialize Redis, ngrok tunnel, and PM2 process resurrection in one automated command.
