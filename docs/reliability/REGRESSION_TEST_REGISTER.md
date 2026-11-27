# Regression Test Register — Plateau State Citizen Contact Centre

Every production bug fixed must have a corresponding automated test so the defect can never silently reappear. Disabling or skipping failing tests to achieve a green CI build is strictly prohibited.

---

## 1. Verified Regression Tests (Executed on `stabilisation/production-reliability`)

| Test ID | Protected Behaviour / Past Defect | Test File | Execution Status |
| :--- | :--- | :--- | :--- |
| **REG-01** | Anti-aliased 24 kHz → 8 kHz PCM resampler keeps 300–3400 Hz speech band within `±0.5 dB` and suppresses >4500 Hz aliasing by `<-60 dB` | `apps/api/test/voice-local-tts.spec.ts` | **PASS (Verified Locally)** |
| **REG-02** | Spitch TTS strips commas and sentence-final periods/colons so it never speaks `"comma"` or `"full stop"` aloud | `apps/api/test/voice-local-tts.spec.ts` | **PASS (Verified Locally)** |
| **REG-03** | Spitch concurrency semaphore queues parallel synthesis requests and retries HTTP 429 | `apps/api/test/voice-local-tts.spec.ts` | **PASS (Verified Locally)** |
| **REG-04** | **NEW:** Spitch circuit breaker opens after 3 consecutive failures and fails fast without calling `fetch` | `apps/api/test/voice-local-tts.spec.ts` | **PASS (Verified Locally)** |
| **REG-05** | **NEW:** `isCacheable()` never caches citizen personal names, phone numbers, or reference numbers in shared `tts-cache` | `apps/api/test/voice-local-tts.spec.ts` | **PASS (Verified Locally)** |
| **REG-06** | 200 Plateau State personas (100 male / 100 female) and gender-matched `jude`/`lucy` voice selection | `apps/api/test/voice-local-tts.spec.ts` | **PASS (Verified Locally)** |
| **REG-07** | Deepgram Nova-3 STT wiring & error handling | `apps/api/test/deepgram-wiring.spec.ts` | **PASS (Verified Locally)** |
| **REG-08** | ElevenLabs fallback contracts, voice settings & schema | `apps/api/test/elevenlabs-contracts.spec.ts` | **PASS (Verified Locally)** |
| **REG-09** | `deploy/single-server/server.env.example` accounts for all deploy env vars (including new `BACKUP_ENCRYPTION_KEY`) | `apps/api/test/deploy-env-accounting.spec.ts` | **PASS (Verified Locally)** |
| **REG-10** | `deploy/single-server/backup.sh` shell syntax validation | `bash -n deploy/single-server/backup.sh` | **PASS (Verified Locally)** |
| **REG-11** | Full NestJS TypeScript build (`@ace/api`) | `npm --workspace=@ace/api run build` | **PASS (Verified Locally)** |
| **REG-12** | Full PostgreSQL + Redis + Voice Session integration suite (`voice-local.spec.ts` + full 1,500+ test matrix) | GitHub Actions CI (`ci.yml`) | **Pending CI run on branch push** |

---

## 2. Verification Policy

- Local sandbox runs verify unit, contract, build, and script-syntax tests without network/database access.
- **GitHub Actions CI** runs the full database/Redis-backed integration suite (`voice-local.spec.ts` and the complete workspace test suite) against ephemeral PostgreSQL and Redis service containers.
- No branch may be merged to `main` or deployed to production until GitHub Actions CI reports **100% green**.
