# Resolution: Live Voice Tool Execution Failures

## Root Cause Analysis
During the live test call with Sarah, when she attempted to execute `register-enrollee` and `create-ticket`, two distinct issues caused the failures:

1. **Dead ngrok Tunnel URL in ElevenLabs Config**:
   - `API_BASE_URL` in `.env` was pointing to an older, expired ngrok tunnel (`https://daybreak-scoreless-reporter.ngrok-free.dev`), returning HTTP 404 (`ERR_NGROK_3200`) when ElevenLabs made webhook requests from the cloud.
2. **Missing `OnboardingModule` in NestJS Dependency Injection**:
   - In `apps/api/src/agent-tools/agent-tools.module.ts`, `OnboardingModule` was missing from `imports`. This left `this.onboarding` in `AgentToolsService` undefined, causing `this.onboarding.requestSelfie` to throw a `TypeError`.

---

## What Was Fixed & Verified

1. **Live ngrok Daemon & ElevenLabs Sync**:
   - Launched a live ngrok tunnel on port 4000: `https://chemotropic-albertha-contritely.ngrok-free.dev`.
   - Updated `API_BASE_URL` in `apps/api/.env`.
   - Ran `setup-plaschema.js` to update all 10 tools on ElevenLabs with the active public tunnel URL.

2. **NestJS Dependency Injection**:
   - Added `OnboardingModule` to `imports` in `apps/api/src/agent-tools/agent-tools.module.ts`.
   - Rebuilt `apps/api` and verified with automated test:
     - `registerEnrollee`: ✅ Returns `ok: true`, generated contact ID, and reference number.
     - `createTicket`: ✅ Returns `ok: true`, ticket reference number, and QA grievance escalation.

---

## Live Service Status
- **API Server**: 🟢 Live on port 4000 (Daemon `task-1964`)
- **Web App**: 🟢 Live on port 3000 (Daemon `task-1872`)
- **ngrok Public Tunnel**: 🟢 Live on `https://chemotropic-albertha-contritely.ngrok-free.dev` (Daemon `task-1891`)
- **ElevenLabs Agent**: 🟢 Synced with live tool webhooks (Agent ID: `agent_3801m0c9terzf58tskm00cp3d008`)
