# Production Readiness Scorecard — Plateau State Citizen Contact Centre

**Assessment Date:** 2026-11-27  
**Branch Evaluated:** `stabilisation/production-reliability` (code remediations complete; external infrastructure/vendor actions pending)

---

## Overall Verdict: **CONDITIONAL GO (Low-Volume Live Traffic) / NO-GO (30 Simultaneous Calls & Full DR Sign-Off)**

The application codebase, voice quality fixes, circuit breaker, container resource guards, and encrypted Qdrant-inclusive backup script are ready for CI verification and controlled staging/production rollout. **However, full 30-simultaneous-call production readiness and disaster recovery compliance CANNOT be signed off until the four external Critical Blockers below are resolved by the Ministry / Account Owner.**

---

## Scored Rubric (Out of 100)

| Domain | Weight | Score | Status | Evidence / Remaining Gap |
| :--- | :---: | :---: | :--- | :--- |
| **1. Core Voice Quality & Conversational Stability** | 15 | **13 / 15** | Ready (Carrier Fix Pending) | Punctuation, fillers, Governor greeting, resampler, jitter buffer all fixed. `-2` for AlphaTech Hop 9 UDP packet loss (`6.7%–30%`). |
| **2. Knowledge Accuracy & Anti-Hallucination** | 10 | **10 / 10** | Ready | 82 docs / 369 chunks / 545 projects indexed; `tinyurl.com` scrubbed (`0` leaks); KB-or-callback enforced. |
| **3. Concurrency & Scale (30 Simultaneous Calls)** | 15 | **4 / 15** | **BLOCKED** | Asterisk `GROUP_COUNT(inbound) > 30` & `LOCAL_VOICE_MAX_CALLS=30` enforced, **but** Spitch is Tier 1 (`3` concurrent max), AlphaTech channel count unconfirmed, and 30-call staging load test not yet run. |
| **4. Provider Failover & Fault Tolerance** | 15 | **9 / 15** | Partially Ready | Spitch circuit breaker + 0 ms fast-fail to ElevenLabs implemented & unit-tested; **but** ElevenLabs `Creator` caps backup at `10` calls and live staging failover drill pending. |
| **5. Infrastructure Redundancy (SPOF)** | 10 | **2 / 10** | **BLOCKED** | Single MTN Cloud VPS (`102.88.134.211`) hosts all services; Standby MTN VPS #2 not yet provisioned. |
| **6. Backup, Encryption & Disaster Recovery** | 10 | **5 / 10** | **BLOCKED** | `backup.sh` now includes Qdrant snapshot + AES-256 encryption + `.dockerignore` fix, **but** `BACKUP_REMOTE` is still empty on live server (local disk only!) and restore drill not yet run. |
| **7. Security, Privacy & NDPA Compliance** | 10 | **7 / 10** | Partially Ready | PII cache-isolation test, secret `.dockerignore`, AudioSocket `127.0.0.1` binding, NDPA clip all verified. `-3` pending formal DPO cross-border DPA sign-off & recording retention automation. |
| **8. Observability & External Alerting** | 5 | **2 / 5** | Needs Work | Container healthchecks added for `qdrant` & `web`; no external uptime monitor outside MTN VPS yet. |
| **9. Change Control, CI & Documentation** | 10 | **10 / 10** | Ready | `AGENTS.md`, `CLAUDE.md`, all 15 `docs/reliability/` docs, rollback runbook, and regression guards complete. |
| **TOTAL SCORE** | **100** | **62 / 100** | **NO-GO for 30-Call Sign-Off** | Reaches **90+ / 100 (GO)** once User Actions #1–#5 are completed and staging drills pass. |

---

## Hard Go/No-Go Blockers for 30-Call Full Production Certification

1. **BLOCKER 1:** Upgrade Spitch API from Tier 1 (`3` concurrent) to a tier supporting **≥30 simultaneous calls**.
2. **BLOCKER 2:** Configure off-server Nigerian backup target (`BACKUP_REMOTE` + `BACKUP_ENCRYPTION_KEY`) and pass a restore drill.
3. **BLOCKER 3:** Provision **Standby / Staging MTN Cloud Nigeria VPS #2** and execute the 1→30→31 call staging load test.
4. **BLOCKER 4:** Obtain AlphaTech confirmation of **≥30 SIP trunk channels** and resolution of Hop 9 (`197.253.11.119`) UDP packet loss.
