# Load Test Report & Staging Protocol — Plateau State Citizen Contact Centre

**Report Date:** 2026-11-27  
**Status:** **NOT YET EXECUTED AT 30 CALLS** — Live toll-free line (`+2348000000456`) was intentionally **not** load-tested to protect active citizens and avoid triggering Spitch Tier 1 `HTTP 429` failures on production.

---

## 1. Current Verified Concurrency Limits (Pre-Load-Test Reality)

| Component | Enforced / Verified Limit | Bottleneck at 30 Simultaneous Calls? |
| :--- | :--- | :--- |
| **Asterisk Inbound Gate** | `GROUP_COUNT(inbound) > 30` (hard ceiling) | Designed for 30; 31st call receives busy message |
| **LocalVoiceService TCP Server** | `LOCAL_VOICE_MAX_CALLS = 30` | Designed for 30 |
| **Spitch TTS Account** | **Tier 1 = 3 concurrent requests max** (verified via live HTTP 429) | **YES — CRITICAL BLOCKER.** At 30 calls (~6–10 simultaneous TTS turns), Tier 1 will queue/stall/trip circuit breaker. |
| **ElevenLabs Backup Account** | **Creator = 10 concurrent calls max** (verified via live API) | **YES — FAILOVER BLOCKER** if >10 calls fail over simultaneously. |
| **AlphaTech SIP Trunk** | Active (`alphatech-reg Registered`), contracted channel count unverified | **UNVERIFIED — Confirm ≥30 channels** with AlphaTech before testing. |
| **MTN Cloud VPS #1** | Single host shared by DB, Qdrant, Redis, API, Web, Asterisk | **UNVERIFIED under 30-call load** — requires staging soak test. |

---

## 2. Mandatory Staging Load-Test Protocol (Execute on Standby/Staging VPS Only)

**Prerequisites before running:**
1. Standby/Staging MTN Cloud VPS provisioned with identical hardware and `docker-compose.yml`.
2. Spitch account upgraded above Tier 1 (target ≥30 concurrent synthesis requests).
3. Test SIP endpoint configured (do **not** flood `+2348000000456` through AlphaTech without written carrier scheduling).

### 2.1 Voice Concurrency Ramp (SIPp + Synthetic Audio)

| Step | Concurrent Calls | Duration | Pass Criteria |
| :--- | :--- | :--- | :--- |
| **Stage 1** | 1 call (baseline) | 5 min | TTFB < 1.5 s, 0% dropped frames, clean recording & transcript |
| **Stage 2** | 5 concurrent calls | 10 min | p95 turn latency < 2.0 s, 0 HTTP 429s, CPU < 40% |
| **Stage 3** | 10 concurrent calls | 10 min | p95 turn latency < 2.2 s, 0 HTTP 429s, 0 OOM restarts |
| **Stage 4** | 20 concurrent calls | 15 min | p95 turn latency < 2.5 s, 0 circuit breaker trips, RAM < 75% |
| **Stage 5** | 30 concurrent calls (target ceiling) | 15 min | All 30 calls active, p95 turn latency < 3.0 s, 0 dropped calls, 0 PostgreSQL pool exhaustion |
| **Stage 6** | 31st simultaneous call (ceiling proof) | 2 min | Calls 1–30 unaffected; call 31 receives graceful busy prompt via `GROUP_COUNT(inbound) > 30` |

### 2.2 Concurrent HTTP / Dashboard / WhatsApp Webhook Load (k6)

Run concurrently during Stage 5 (30 active voice calls):
- **Admin Dashboard (`web` + `api`):** 20 virtual operators polling tickets/calls/analytics every 5 seconds.
- **WhatsApp Webhooks:** 50 simulated webhook POST events/minute (including duplicate event IDs to verify idempotency).
- **Pass Criteria:** HTTP p95 < 500 ms, 0 HTTP 5xx errors, BullMQ queue depth drains to 0 within 30 s, PostgreSQL active connections < 80% of `max_connections`.

---

## 3. Sign-Off Rule

The platform **must not** be certified for 30 simultaneous production calls until Stages 1–6 above are executed on staging and actual measured metrics (p50/p95 latency, CPU, RAM, error rate, and 31st-call busy behaviour) are recorded in this file.
