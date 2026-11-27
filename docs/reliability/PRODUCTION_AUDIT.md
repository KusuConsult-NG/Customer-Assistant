# Production Audit — Plateau State Citizen Contact Centre

**Audit Date:** 2026-11-27  
**Audited Baseline Commit (Live Production):** `ad65857` (branch `main`, GitHub Actions CI run `45989351889` — green)  
**Stabilisation Branch:** `stabilisation/production-reliability`  
**Production URL:** `https://contact.plateaustate.gov.ng`  
**Toll-Free Line:** `+2348000000456`  
**Primary Host:** MTN Cloud Nigeria VPS (`102.88.134.211`)

---

## 1. Executive Summary

The Plateau State Citizen Contact Centre is **operational on live traffic** for single/low-concurrency calls, WhatsApp messaging, and administrative dashboard workflows, with core containers healthy and TLS valid through February 23, 2027.

However, forensic inspection of the live MTN Cloud host, application code, Docker Compose configuration, backup scripts, carrier network path, and third-party provider tiers confirms **five structural reliability blockers** that prevent certifying the platform as fault-tolerant at its **30 simultaneous call** design target:

1. **Single-server SPOF:** All services (Caddy, Next.js, NestJS, Asterisk, PostgreSQL 17, Redis 7.4, Qdrant, `/data/files`) run on one MTN Cloud VPS with no standby server.
2. **No off-server backups configured:** `BACKUP_REMOTE` is currently empty on production; nightly backups are written only to local disk (`deploy/single-server/backups/`), so host or disk loss destroys both production data and backups simultaneously.
3. **Spitch Tier 1 concurrency cap (`3 concurrent requests`):** Live `HTTP 429 concurrency_limit_exceeded` responses proved the current Spitch account is Tier 1. Application-level gating (2 in-flight + retry + circuit breaker) protects against 429 storms on low traffic, but **30 simultaneous calls cannot be served on Tier 1**.
4. **ElevenLabs warm backup capacity cap (`10 concurrent calls`):** Live account inspection confirmed the `Creator` plan (`$22/month`, `166,998 / 231,000` credits used, 10 concurrent call limit). Full failover of 30 concurrent calls will hit concurrency exhaustion on ElevenLabs.
5. **AlphaTech carrier UDP packet loss (`6.7%–30%`):** `mtr` diagnostics from the MTN VPS recorded packet loss at intermediate hop `197.253.11.119`, directly corroborated by audible word clipping in recorded calls (`latest-call-3.wav` at `0:37`).

---

## 2. Live Asset Reconciliation

| Asset | Expected Baseline | Verified Production State | Status |
| :--- | :--- | :--- | :--- |
| Caller-facing personas | 200 (Plateau State) | 100 male (`PLATEAU_MALE_NAMES`) + 100 female (`PLATEAU_FEMALE_NAMES`) with 50/50 gender/voice matching (`jude` / `lucy`) | **Verified** |
| Official indexed documents | 82 | 82 documents indexed in PostgreSQL + Qdrant (`0` pending) | **Verified** |
| Qdrant vector chunks | 369 | 369 chunks indexed; internal `tinyurl.com/accountabilityhub` scrubbed (`0` leaks) | **Verified** |
| Tracked government projects | 545 | 545 projects across 16 Accountability Hub Markdown documents | **Verified** |
| Database tables | 39 | PostgreSQL 17 running (`ace-postgres-1`), Prisma schema intact | **Verified** |
| Concurrent call hard ceiling | 30 | Enforced in Asterisk (`GROUP_COUNT(inbound) > 30`) and `LocalVoiceService` (`LOCAL_VOICE_MAX_CALLS=30`) | **Verified** |
| TLS certificate | Valid HTTPS | Let's Encrypt YE1 valid `2026-11-25` → `2027-02-23` via Caddy | **Verified** |
| SIP trunk registration | Registered | `alphatech-reg Registered` on `ace-bridge-1` (Asterisk 20.6) | **Verified** |
| API health endpoint | `200 OK` | `/api/health` returning `{"status":"ok"}` | **Verified** |

---

## 3. Infrastructure & Container Inventory (Live MTN VPS)

| Container | Role | Healthcheck Before Audit | Resource Limits Before Audit | Remediation on Stabilisation Branch |
| :--- | :--- | :--- | :--- | :--- |
| `ace-caddy-1` | Reverse proxy + ACME TLS | N/A (host/port 80,443) | Unbounded | Retain Caddy TLS; external uptime monitor required |
| `ace-web-1` | Next.js admin dashboard | **Missing** | **Missing** | Added `healthcheck`, `mem_limit`, `pids_limit`, `stop_grace_period: 30s` |
| `ace-api-1` | NestJS API + AudioSocket voice engine | Present (`/api/health`) | **Missing** | Added `mem_limit`, `pids_limit`, `stop_grace_period: 30s`; depends on `qdrant: service_healthy` |
| `ace-bridge-1` | Asterisk 20.6 SIP/AudioSocket bridge | Present (`asterisk -rx`) | **Missing** | Added `mem_limit`, `pids_limit`, `stop_grace_period: 30s` |
| `ace-postgres-1` | PostgreSQL 17 primary DB | Present (`pg_isready`) | **Missing** | Added `mem_limit`, `pids_limit`, `stop_grace_period: 30s` |
| `ace-redis-1` | Redis 7.4 + BullMQ queues | Present (`redis-cli ping`) | **Missing** | Added `mem_limit`, `pids_limit`, `stop_grace_period: 30s` |
| `ace-qdrant-1` | Qdrant vector store | **Missing** | **Missing** | Added `healthcheck` (`/healthz`), `mem_limit`, `pids_limit`, `stop_grace_period: 30s` |

---

## 4. Confirmed Risks by Severity

| Severity | Finding | Evidence | Owner |
| :--- | :--- | :--- | :--- |
| **Critical** | Single MTN VPS hosts all compute, DB, vectors, and storage | Live topology on `102.88.134.211` | User (procure standby VPS) + Engineering (DR runbook) |
| **Critical** | Local-only backups (`BACKUP_REMOTE` empty) + Qdrant previously excluded from `backup.sh` | Inspected `deploy/single-server/backup.sh` and live server env | **Code fixed** (Qdrant snapshot + optional encryption); User must set `BACKUP_REMOTE` |
| **Critical** | Spitch Tier 1 allows max `3` concurrent requests | Live `HTTP 429 concurrency_limit_exceeded` error | **Code hardened** (semaphore + circuit breaker); User must upgrade Spitch tier |
| **Critical** | ElevenLabs backup capped at `10` concurrent calls (`Creator` plan) | Live ElevenLabs API subscription audit | User must decide backup concurrency tier |
| **High** | AlphaTech SIP path exhibits `6.7%–30%` UDP packet loss at Hop 9 (`197.253.11.119`) | `mtr` trace + `latest-call-3.wav` audio audit | **Mitigated** (`JITTERBUFFER(adaptive)=300,60,40`); User must escalate to AlphaTech |
| **High** | Nightly `ace-backup.timer` wrote `root:root 0700` files inside build context, breaking `docker build` | Observed `permission denied` during prior deploy | **Fixed** on branch (`.dockerignore` excludes `deploy/single-server/backups` and `server.env`) |
| **High** | No external uptime/alerting outside the MTN VPS | Only GitHub Actions `keep-warm.yml` (30-min ping) exists | User / Ops (deploy external monitor) |
| **Medium** | Asterisk 20.6 reached end of full upstream support Oct 2026 (security-only until Oct 2027) | Ubuntu 24.04 package version `20.6` | Planned staged migration to Asterisk 22 LTS |
| **Medium** | Cross-border AI data flow (Deepgram, OpenAI, Meta, ElevenLabs) needs explicit NDPA DPO documentation | Code & network flow audit | Documented in `SECURITY_AND_PRIVACY_AUDIT.md`; User DPO sign-off required |

---

## 5. Verification Boundary

- **Directly verified in this audit:** Live container status, health endpoints, TLS validity, SIP registration, Qdrant/KB document counts, ElevenLabs account tier/credits, Spitch Tier 1 429 behaviour, `mtr` carrier packet loss, audio recordings, source code, and automated Jest tests.
- **Not verified (requires vendor/user action or isolated staging):** 30-call live load test (unsafe on live toll-free line), Deepgram credit balance (API key rightly lacks `billing:read`), AlphaTech SIP trunk contracted channel limit, and off-server backup restore drill (blocked until `BACKUP_REMOTE` is configured).
