# Remediation Report — Production Stabilisation Branch

**Branch:** `stabilisation/production-reliability` (branched from `main` at `ad65857`)  
**Production Impact:** Zero disruption to live MTN Cloud production during authoring; all changes staged on branch pending CI verification and user deployment approval.

---

## 1. Completed Code & Infrastructure Remediations

### 1.1 Spitch TTS Circuit Breaker & Fast-Failover to ElevenLabs
- **Files:** `apps/api/src/voice-local/tts.ts`, `apps/api/src/voice-local/local-voice.service.ts`
- **What changed:**
  - Added a stateful circuit breaker to `SpitchTts` (`SPITCH_CB_THRESHOLD = 3` consecutive failures, `SPITCH_CB_COOLDOWN_MS = 30_000` ms) with exported `spitchCircuitState()` and `resetSpitchCircuit()` helpers.
  - Wired `spitchCircuitState().open` into `LocalVoiceService.register()`: when Spitch is the active engine and its circuit is open, new inbound calls immediately return `fallback spitch-circuit-open` in 0 ms so Asterisk routes the caller straight to ElevenLabs without opening a dead AudioSocket leg or waiting for timeouts.
- **Verification:** New unit tests in `apps/api/test/voice-local-tts.spec.ts` confirm the circuit opens after 3 consecutive failures, fails fast without calling `fetch`, and resets cleanly.

### 1.2 Citizen PII Cache-Isolation Regression Guard
- **Files:** `apps/api/test/voice-local-tts.spec.ts`
- **What changed:** Added an automated regression test verifying `isCacheable()` rejects utterances containing citizen names, phone numbers, and reference numbers so personalised speech is never written to the shared `tts-cache` directory.

### 1.3 Docker Container Isolation, Healthchecks & Graceful Shutdown
- **Files:** `deploy/single-server/docker-compose.yml`
- **What changed:**
  - Added explicit `mem_limit`, `pids_limit`, and `stop_grace_period: 30s` across `postgres`, `redis`, `qdrant`, `api`, `web`, and `bridge` so a runaway process cannot OOM-kill the entire host.
  - Added native `healthcheck` definitions for `qdrant` (`/healthz`) and `web`.
  - Upgraded `api.depends_on.qdrant` to `condition: service_healthy` so the API never accepts traffic before vector search is ready.

### 1.4 Docker Build Context Hardening
- **Files:** `.dockerignore`
- **What changed:** Added `deploy/single-server/backups` and `deploy/single-server/server.env` to `.dockerignore`. This eliminates recurring `permission denied` Docker build failures caused by nightly `root:root 0700` backup folders and prevents production secrets from ever entering the Docker build context.

### 1.5 Backup Completeness (Qdrant Snapshot) & Optional Encryption
- **Files:** `deploy/single-server/backup.sh`, `deploy/single-server/server.env.example`
- **What changed:**
  - Added automated Qdrant collection snapshot capture (`qdrant.snapshot`) verified in `SHA256SUMS` alongside PostgreSQL and `/data/files`.
  - Added optional AES-256-CBC PBKDF2 encryption (`BACKUP_ENCRYPTION_KEY`) applied before `rclone copy` to `BACKUP_REMOTE`, and documented `BACKUP_ENCRYPTION_KEY` in `server.env.example`.

### 1.6 Enduring Repository Engineering Rules & Reliability Documentation
- **Files:** `AGENTS.md`, `CLAUDE.md`, `docs/reliability/*.md` (all 15 mandate documents)
- **What changed:** Codified all architectural invariants, prohibited providers, testing requirements, runbooks, and honest readiness gates directly in the repository.

---

## 2. Previously Completed Remediations Already Live on `main` (`ad65857`)

- Knowledge base ingestion of all 545 Accountability Hub projects + `tinyurl.com/accountabilityhub` scrub (`729a6a6`, `c6b7925`).
- LLM cost optimisation (`gpt-4o` → `gpt-4o-mini`) across local pipeline and ElevenLabs backup (`50093e7`).
- Spitch primary TTS migration + 200 Plateau State personas (100M / 100F, `jude` / `lucy`) + studio Governor voice clone + pre-rendered time-of-day greetings (`3d0d8ae`, `cd69f6d`, `e65d710`, `eb5ef01`).
- Hard 30-call concurrent ceiling in Asterisk (`04c493b`), Spitch Tier 1 semaphore (`80ff112`), anti-aliased 24kHz→8kHz resampler (`3a07271`), adaptive jitter buffer, punctuation sanitisation, and elimination of synthetic fillers (`2ef88c2`, `4b527c1`, `a7fb5cf`, `ad65857`).

---

## 3. Remaining External / User-Owned Remediations

Engineering code changes alone cannot resolve vendor account caps or single-host physical failure. See `docs/reliability/USER_ACTIONS_REQUIRED.md` for the exact user actions needed to achieve full 30-call production sign-off:
1. Upgrade Spitch API concurrency tier above Tier 1 (`3` concurrent limit).
2. Configure off-server encrypted backup target (`BACKUP_REMOTE` + `BACKUP_ENCRYPTION_KEY`).
3. Provision a second MTN Cloud Nigeria standby server for disaster recovery / staging.
4. Escalate Hop 9 (`197.253.11.119`) UDP packet loss and confirm 30+ SIP trunk channels with AlphaTech.
5. Decide ElevenLabs warm backup concurrency tier (`Creator` 10-call cap vs. `Scale` 30-call cap).
