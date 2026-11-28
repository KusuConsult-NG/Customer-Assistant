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
| **REG-11** | 26 Nov: the agent could not hear callers. Root cause: `JITTERBUFFER(adaptive)` on the AudioSocket path (caller audio 0.4 s of 52 s). Removed. | `apps/api/test/sip-bridge-template.spec.ts` | **PASS (CI)** |
| **REG-12** | 27 Nov: a summary was invented for a call in which the caller said nothing. | `apps/api/test/voice-local-conversation-flow.spec.ts` | **PASS (CI)** |
| **REG-13** | 28 Nov: a pause between "Dr." and the name. Root cause: the sentence splitter ended a sentence at a title's full stop. | `apps/api/test/voice-local.spec.ts` | **PASS (CI)** |
| **REG-14** | 28 Nov: 1.8 s of dead air before a ready reply. Root cause: playback waited for 4.5 s of audio or the 2 s deadline. | `apps/api/test/voice-local-conversation-flow.spec.ts` | **PASS (CI)** |
| **REG-15** | A single "Wait" or "Stop" did not stop the agent (two words were required, judged at one instant of loudness). Proven through real Asterisk. | `voice-local-conversation-flow.spec.ts`, `voice-local-asterisk.spec.ts` (ASTERISK_E2E) | **PASS (CI / sandbox Asterisk)** |
| **REG-16** | A callback was booked, or a hidden caller's number or a changed location was saved, before the caller heard it read back. | `apps/api/test/voice-local-guards.spec.ts` | **PASS (CI)** |
| **REG-17** | A number read out in groups ("0803 … 123") was cut into several turns. | `apps/api/test/voice-local-guards.spec.ts` | **PASS (CI)** |
| **REG-18** | **28 Nov: every ENCRYPTED nightly backup stopped before the off-site copy.** Root cause: tar read the folder the encrypted file was being written into ("file changed as we read it", exit 1). The off-site copy also carried the unencrypted dump. Superseded REG-10, a syntax check that passed throughout. | `deploy/single-server/tests/dr-drill.sh` (CI job `disaster-recovery-drill`) | **PASS (sandbox; CI)**. The same drill fails on the old scripts. |
| **REG-19** | **28 Nov: the knowledge base could not be restored.** Root cause: backups held Qdrant's whole-storage snapshot, which the Qdrant 1.12.6 API refuses (`missing field params`). Now one snapshot per collection, restored by `restore.sh`. | `deploy/single-server/tests/dr-drill.sh` | **PASS (sandbox: 369 + 11 vectors restored onto an empty server)** |
| **REG-20** | A deploy could not be rolled back and the running release was not recorded. Deploy now keeps `:previous` images, `rollback.sh` restores them, and every deploy is logged with its commit and image IDs. | `deploy/single-server/tests/release-test.sh` (CI) | **PASS (real Docker engine)** |
| **REG-21** | 2 critical and 13 high-severity vulnerabilities in production dependencies (`proxy-addr` IP spoofing, `next`, and others). Non-breaking fixes applied: now 0 critical, 8 high (NestJS 10→12 and Next 15→16 majors outstanding). | `npm audit --omit=dev` | **PARTIAL**: see `PRODUCTION_SIGNOFF.md` §9 |
| **REG-22** | A caller beyond the 30-call limit heard a busy tone and was lost. Now: answered, held in order of calling, admitted when a line is free, and after 3 minutes (or a full waiting room) a callback is booked. | `voice-local-queue-asterisk.spec.ts` (ASTERISK_E2E + ASTERISK_QUEUE_E2E, real Asterisk); `sip-bridge-template.spec.ts`, `voice-local.spec.ts`, `monitoring.spec.ts`, `queue-sounds.spec.ts` (CI) | **PASS (sandbox Asterisk; CI for the rest)** |
| **REG-23** | Found while building REG-22: a `dialplan reload` reset the waiting room's ticket counters but kept the "caller left" marks, so a new caller could be skipped as if they had hung up. The counters are no longer in `[globals]`, a new ticket clears any old mark, and a passed ticket counts as next. | `voice-local-queue-asterisk.spec.ts` (reload and stale-mark tests); `sip-bridge-template.spec.ts` (CI) | **PASS (sandbox Asterisk)** |
| **REG-11** | Full NestJS TypeScript build (`@ace/api`) | `npm --workspace=@ace/api run build` | **PASS (Verified Locally)** |
| **REG-12** | Full PostgreSQL + Redis + Voice Session integration suite (`voice-local.spec.ts` + full 1,500+ test matrix) | GitHub Actions CI (`ci.yml`) | **Pending CI run on branch push** |

---

## 2. Verification Policy

- Local sandbox runs verify unit, contract, build, and script-syntax tests without network/database access.
- **GitHub Actions CI** runs the full database/Redis-backed integration suite (`voice-local.spec.ts` and the complete workspace test suite) against ephemeral PostgreSQL and Redis service containers.
- No branch may be merged to `main` or deployed to production until GitHub Actions CI reports **100% green**.
