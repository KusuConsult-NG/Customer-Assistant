# PRODUCTION SIGN-OFF — Plateau State Government Citizen Contact Centre

**Release assessed:** branch `claude/kind-darwin-bcrtsn`, on top of `main` at `bb8b0f8` (PR #159). The exact commit is the head of the PR that adds this file. After merge and deploy, `deploy/single-server/releases.log` records the commit and image IDs running on the server.
**Assessed:** 28 Nov 2026, by Claude Code (lead implementation engineer).
**Assessment environment:** an isolated engineering container holding the source code, the full test suites, a real Asterisk 20 for call-path tests, and a Docker engine running the production Postgres 17 and Qdrant v1.12.6 images.
**Not reachable by the assessor:** the MTN Cloud production server, the AlphaTech trunk, the provider accounts, and any staging server. None exists yet (`USER_ACTIONS_REQUIRED.md` Action 3).

> **Evidence rule used throughout.** A gate is **PASSED** only on evidence examined in this assessment: CI, a sandbox drill against real software, or live server output the owner supplied. Code that merely exists is **NOT VERIFIED**. Anything needing the live server, a real phone, an account owner or a responsible officer is marked as such, with how to verify it. Mock services were used only inside unit tests, and are never the evidence for a gate.

---

## 1. Release decision

# NO-GO — PRODUCTION APPROVAL WITHHELD

Essential capabilities are unverified, and capacity is known to be insufficient for the target load:

1. **Thirty simultaneous calls have never been demonstrated.** No staging server exists to test on. The speech account (Spitch) is on Tier 1, which allows 3 requests at once; the line itself is limited to 2 (`SPITCH_MAX_CONCURRENCY`). At 30 calls, speech would queue, and the 3-second response target cannot be met.
2. **Disaster recovery has not been proven on production infrastructure.** This assessment found and fixed two defects that made production backups unrecoverable (§5), and the restore now passes a drill against real software. But whether production copies backups off the server (`BACKUP_REMOTE`) is unknown, and no restore has been run onto a standby server.
3. **No failure-injection, endurance (24 h) or post-deployment stability (72 h) testing has been done**, because there is no staging environment.
4. **8 high-severity dependency vulnerabilities remain**, all needing a framework major-version upgrade (§9).
5. **No independent monitoring or alerting** is operational (§12).
6. **Main is not protected** and deploys are not gated on CI. PRs #156–#159 were merged through the API with no review.

**This is not a shutdown.** The line is live and has carried test calls. Withholding approval means controlled operations continue: low call volume, no 30-call publicity, deploys only from green CI, and §14 completed before re-assessment.

---

## 2. Executive technical assessment

The voice line works end to end on live calls. The owner's server logs on 28 Nov show caller audio received, speech recognised, replies generated and spoken, a pre-recorded reply after about 2.0 s of silence (`endpoint_ms` 744 + `first_audio_ms` 1240), and interruption logged.

Over 26–28 Nov the line's recurring failures were traced to root causes:
- a jitter buffer that hid the caller's audio;
- invented summaries;
- a 1.8 s playback hold;
- pauses after titles;
- a model allowed to save details without a read-back.

Each has been fixed with a regression test (REG-11 to REG-17).

The recurring "outages" of 28 Nov were **commercial, not software**:
- The OpenAI account had no credit (HTTP 429, "no credits remaining").
- A replacement account was capped at 10,000 tokens per minute, while a single request is about 12,800.

Both were resolved by the owner. The current key shows 450,000 tokens per minute.

The platform's weaknesses are now **capacity, recovery and operations**, not the conversation logic: Spitch tier, no staging, no proven restore on production infrastructure, no monitoring, and unprotected deploys.

---

## 3. Mandatory release gates (30)

Legend: **PASSED** (evidence examined) · **PARTIAL** (part proven; the remainder stated) · **NOT VERIFIED** (no evidence available to the assessor) · **FAILED** (evidence shows it does not meet the gate).

### Voice and telecommunications

| # | Gate | Status | Evidence / what remains |
|---|---|---|---|
| 1 | AlphaTech incoming calls | **PARTIAL** | Live calls reached the agent on 28 Nov (owner's `voice_local_call_ended` logs, caller audio 34–106 s). Channel count, and SIP/RTP under load, not verified (`LOAD_TEST_REPORT.md`). |
| 2 | Governor welcome and voice authorisation | **PARTIAL** | The 3 approved greetings are on disk (`prerender.js`: 3 Governor lines, 0 failed). **Written authorisation to use the Governor's voice was not seen.** |
| 3 | Spitch speech generation | **FAILED for capacity** | Works live: probe 0.6–1.1 s per sentence, and live calls. Tier 1 allows 3 concurrent requests, which is far below 30 calls. |
| 4 | Deepgram transcription | **PASSED (live)** | Live calls transcribed; `endpoint_ms`, `ended_by` and `silence_heard_ms` logged (28 Nov). |
| 5 | OpenAI reasoning and tool calling | **PARTIAL** | Live and conversation-check runs: 12/17 scenarios on gpt-4.1 and gpt-4.1-mini in one run each, before the REG-16 fixes. The model choice and the re-run after this release are owner steps (`PHONE_LINE_SIGN_OFF.md` §2.2). |
| 6 | ElevenLabs failover | **PARTIAL** | The dialplan hands a failed local leg to ElevenLabs: passed against a real Asterisk in the sandbox (`voice-local-asterisk.spec.ts`). No live failover drill. ElevenLabs Creator caps the backup at 10 calls (`FAILOVER_TEST_REPORT.md`). |
| 7 | 30 simultaneous calls | **NOT VERIFIED / blocked** | Never run. Blocked by the Spitch tier, the unconfirmed AlphaTech channel count and the missing staging server. |
| 8 | Overflow and interrupted-call recovery | **NOT VERIFIED** | `GROUP_COUNT(inbound) > 30` and `LOCAL_VOICE_MAX_CALLS=30` exist in code. The 31st-call test has not been run. |

### Functional and business

| # | Gate | Status | Evidence / what remains |
|---|---|---|---|
| 9 | WhatsApp end to end | **NOT VERIFIED** | Automated webhook and signature suites pass in CI (`webhook-*.spec.ts`). No live WhatsApp verification in this assessment. |
| 10 | Human officer takeover | **NOT VERIFIED** | Code and tests exist. Not exercised live. |
| 11 | Citizen CRM and privacy | **PARTIAL** | `crm-authorization.spec.ts` and the profile and read-back guards pass in CI. Live shared-phone privacy not exercised. |
| 12 | Case creation and tracking references | **PARTIAL** | The conversation check shows a summary read-back, then `create-ticket`, then the reference. The ticket-before-reference ordering is covered by the API suite. Not exercised live with dashboard confirmation (`PHONE_LINE_SIGN_OFF.md` C1). |
| 13 | MDA routing and escalation | **NOT VERIFIED** | Not exercised. |
| 14 | Callbacks and appointments | **PARTIAL** | A booking now requires a heard read-back (REG-16; G1 passes on gpt-4.1 and gpt-4.1-mini). Desk-officer assignment and notification not exercised. |
| 15 | Emergency workflows | **NOT VERIFIED** | 112, Operation Rainbow, OPEP, Police, Fire and SEMA flows were not exercised with simulated destinations. A test of "never claims dispatch" during an AI outage has not been run. |
| 16 | Knowledge base accuracy and coverage | **NOT VERIFIED** | The claims of 58 MDAs, 82 documents, 369 chunks and 545 projects were **not** independently counted on production. Run the counts in §14. |
| 17 | Administrative dashboard | **PARTIAL** | The Playwright e2e suite runs in CI against the booted stack. The full page, role, export and accessibility matrix was not executed. |

### Infrastructure and security

| # | Gate | Status | Evidence / what remains |
|---|---|---|---|
| 18 | MTN server capacity | **NOT VERIFIED** | No access. One VPS carries the database, vector store, API, web and Asterisk (single point of failure). |
| 19 | Container recovery and health checks | **PARTIAL** | Health checks are configured and observed `healthy` in the owner's deploy output. A crash and restart drill has not been run. |
| 20 | Database integrity | **NOT VERIFIED** | Not checked on production. |
| 21 | Independent backups and restoration | **PARTIAL (2 defects fixed)** | See §5. The drill passes against the production images; production `BACKUP_REMOTE`, and a restore onto production-class infrastructure, are still to be proven. |
| 22 | Disaster recovery | **NOT VERIFIED** | No standby server. RTO and RPO are unmeasured. |
| 23 | Security and access-control audit | **FAILED (partial remediation)** | 2 critical vulnerabilities fixed; 8 high remain. No secrets found in tracked files. Webhook signature verification is tested. No penetration test. See §9. |
| 24 | Data protection assessment | **NOT VERIFIED** | Needs the Ministry DPO (`USER_ACTIONS_REQUIRED.md` Action 7). The recording disclosure is in the opening script; the DPO must approve it. |

### Operational and commercial

| # | Gate | Status | Evidence / what remains |
|---|---|---|---|
| 25 | Provider subscriptions and capacity | **PARTIAL** | OpenAI: 450,000 TPM and 5,000 RPM (owner output, 28 Nov). **Spitch Tier 1: insufficient.** AlphaTech channels and the ElevenLabs tier are unconfirmed. Balances other than OpenAI were not seen. |
| 26 | Independent monitoring and alerting | **FAILED** | Only `keep-warm.yml` pings `/api/health` every 30 minutes, with no alerting to administrators. |
| 27 | Regression tests passed | **PASSED (this release)** | CI, plus locally: API 1,609 passed and 9 skipped (gated Asterisk suites, run separately: 5/5); packages 561 passed; build of 9 packages; DR drill passed; release test passed. |
| 28 | Deployment and rollback | **PARTIAL** | New: a backup before every deploy, `:previous` images, `rollback.sh`, `releases.log` (REG-20, tested on a real Docker engine). Not exercised on production. **Main is unprotected, and deploys are not gated on CI.** |
| 29 | 72-hour production stability | **NOT VERIFIED** | Not started. Requires deployment of this release and monitoring (gate 26). |
| 30 | Independent QA review | **NOT VERIFIED** | The assessor is also the implementer, so this cannot be self-certified. |

**Gates passed: 2 of 30** (4, 27). **Partial: 14. Not verified: 11. Failed: 3** (3, 23, 26). A gate counts as complete only when fully PASSED.

---

## 4. Root-cause and remediation register

See `docs/reliability/REGRESSION_TEST_REGISTER.md`, REG-11 to REG-21. Each entry gives the defect, its root cause, the fix, its automated test, and the result. Defects found and fixed in this assessment:

| Defect | Root cause | Fix | Test | Verified |
|---|---|---|---|---|
| **Encrypted backups never left the server** | `tar` packed the folder the encrypted file was being written into. It exited 1 ("file changed as we read it"), and `set -e` stopped the script before `rclone`. | Write the encrypted archive outside the folder; read it back before upload. | `tests/dr-drill.sh` | Reproduced on the old script (it stops at `tar`); the new script passes. |
| **The off-site copy carried the unencrypted database** | `rclone copy "$dir"` copied the plaintext dump alongside the encrypted archive. | Only the encrypted archive and its checksum leave the server. | `tests/dr-drill.sh` (asserts the off-site contents) | PASS |
| **The knowledge base was unrestorable** | Backups held a whole-storage Qdrant snapshot, which the Qdrant 1.12.6 API refuses (`missing field params`). `restore.sh` never restored Qdrant at all. | One snapshot per collection; `restore.sh` uploads each. | `tests/dr-drill.sh` | PASS: 369 + 11 vectors restored onto an empty Qdrant |
| No rollback, and no release record | Deploys overwrote `:latest`. | `:previous` tags, `rollback.sh`, `releases.log`, and a backup before each deploy. | `tests/release-test.sh` | PASS (real Docker) |
| Backups not git-ignored | `deploy/single-server/backups/` was missing from `.gitignore`. | Added. | `git check-ignore` | PASS |
| 2 critical and 13 high vulnerabilities | Out-of-date transitive dependencies. | Non-breaking `npm audit fix`. | `npm audit --omit=dev`; full build and tests | 0 critical, 8 high |
| Callback, number and location saved without a read-back (models) | The model marked confirmations itself. | `readBackGuard` in the session. | `voice-local-guards.spec.ts` | PASS; mutation-checked |
| Seven earlier voice defects | See REG-11 to REG-17. | | | PASS |

---

## 5. Backup restoration report

**Drill:** `deploy/single-server/tests/dr-drill.sh`. It runs in CI as `disaster-recovery-drill` on every change.

**Software:** the repository's real `backup.sh` and `restore.sh`; Postgres 17 and Qdrant v1.12.6, the production images; real rclone and OpenSSL. Synthetic data only. Only `docker compose` is re-pointed at the drill containers.

**Steps:**
1. Seed 200 citizens, 545 tickets, 369 + 11 vectors and 10 recordings.
2. Back up: encrypted, copied off-server, verified by `rclone check`.
3. **Destroy everything** and start an empty server.
4. Restore **from the off-site copy only**.
5. Compare.

**Result:** `RESTORE MATCHES THE ORIGINAL`. Citizens, tickets (references PLT-00001 to PLT-00545), vectors in both collections, and file checksums are all identical.

**Same drill on the old scripts:** the backup stops at `tar: .: file changed as we read it`.

**Still required on production (owner):**
- Set `BACKUP_REMOTE` and `BACKUP_ENCRYPTION_KEY`.
- Confirm `systemctl status ace-backup` shows a success.
- Run one restore onto a standby or staging server, and record RTO and RPO.

---

## 6. Voice and telephony test report

See `docs/reliability/PHONE_LINE_SIGN_OFF.md`: the automated proofs (§1), the live steps with pass marks (§2), and the owner's account items (§3).

Live measurements, 28 Nov:
- **Silence after the caller:** about 2.0 s on a pre-recorded reply, against 3.3–4.2 s before this week's fixes.
- **Spitch:** 0.6–1.1 s per sentence.
- **Model's first words:** gpt-4.1 0.86–0.90 s; gpt-4o 1.03–1.45 s.

The full scripted call matrix (C1–C10) is still to be run by the owner.

**Callers beyond the call limit (added 28 Nov):** a caller beyond `MAX_CONCURRENT_CALLS` (30) no longer hears a busy tone. They are answered and hear "Thank you for calling the Plateau State Government Citizen Contact Centre. All our lines are busy at the moment. Please hold, and you will be answered shortly." They are then held and let in strictly in the order they called. Every 60 s they hear that they are still in the queue.

After 3 minutes (`QUEUE_MAX_WAIT`), or straight away when 60 are already waiting (`QUEUE_MAX_CALLS`), a callback request is booked for their number and they are told a desk officer will call them back. A withheld number is asked to call again instead. At the defaults, 30 active + 60 waiting = 90, below AlphaTech's 100 channels (as reported by the owner; written confirmation is §14 item 4).

- **Proven on a real Asterisk running the real dialplan, at a limit of 1 call** (`voice-local-queue-asterisk.spec.ts`, 7 tests, 3 consecutive passes):
  - held, then answered as soon as the line is free, and the waiting caller hears sound throughout (recorded on their side);
  - first come, first served, with nobody let in out of turn, even with a free line;
  - a caller who hangs up does not hold up those behind;
  - a dialplan reload while callers wait keeps their places;
  - a time-out books one callback for the +234 number;
  - a full room books the callback at once.
- **Every dialplan fault tried was caught** (9 deliberate breakages), except one that changes nothing a caller sees: the callback code normalises the number itself.
- **With the waiting room switched off** (`QUEUE_MAX_CALLS=0`), the caller gets `BUSY`, exactly as before.
- **Not yet verified:** the waiting room on the live line, and the recordings in the assistant's own voice (§14 item 13). The sandbox has no Spitch key; until the recordings are made, Asterisk's stock English prompts play.

## 7. Thirty-call concurrency report and 8. Endurance report

**Not performed.** There is no staging server, and the Spitch Tier 1 limit makes a pass impossible today. The test plan stands in `docs/reliability/LOAD_TEST_REPORT.md` (1 → 5 → 10 → 20 → 30 → 31 calls, then 24 h). **Do not claim 30-call capability.**

## 9. Security assessment

**Fixed in this release:** all critical production-dependency vulnerabilities, including `proxy-addr` (IP spoofing when trusting a proxy; the API runs behind Caddy with `TRUST_PROXY`) and `next`.

**Remaining high-severity issues:**

| Package | Issue | Exposure | Fix |
|---|---|---|---|
| `@nestjs/platform-express` → `body-parser`, `multer` | Denial of service | Request-facing | NestJS 10 → 12 major upgrade |
| `postcss` (via `next`) | XSS / file read | Build time only | Next 15 → 16 |
| `prisma`, `@prisma/config` → `deepmerge-ts`, `effect` | DoS / ReDoS | CLI at deploy time only | Prisma update |

**Plan:** a dedicated NestJS 12 upgrade with the full suite, as its own PR.

**Verified:**
- No API keys or private keys in tracked files (pattern scan).
- `server.env` and backups are ignored by git and Docker.
- Webhook signatures are verified, with tests: WhatsApp, ElevenLabs, telephony.
- Authorisation suites pass in CI.
- Citizen data is never cached in shared speech clips (`isCacheable`, REG-05).

**Not performed:** a penetration test, SIP security review, firewall rule audit on the server, and recording-access audit on production.

## 10. Data protection assessment

Not certified; it requires the Ministry DPO.

External processing of citizen data on the voice line:
- **Deepgram:** caller audio, for transcription.
- **OpenAI:** the transcript and profile details, for reasoning.
- **Spitch:** the agent's spoken text, which can include a caller's name.
- **ElevenLabs:** the backup line.
- **Meta:** WhatsApp.

Recordings and records are stored on MTN Cloud in Nigeria. See `docs/reliability/SECURITY_AND_PRIVACY_AUDIT.md` and `USER_ACTIONS_REQUIRED.md` Action 7.

## 11. Failover test report

`docs/reliability/FAILOVER_TEST_REPORT.md`:
- Failover for new calls is unit-tested.
- The mid-call handoff to ElevenLabs is verified against a real Asterisk in the sandbox.
- No live drills: these need staging.

## 12. Production monitoring report

**Not operational.** Required: an external uptime and TLS monitor, plus alerts on `failed_over` calls, provider 429/402 errors, backup failure, disk, and database. See `USER_ACTIONS_REQUIRED.md` Action 6.

## 13. Subscription and financial requirements

| Service | Finding | Classification |
|---|---|---|
| OpenAI | No credit on 28 Nov, then a 10k TPM cap, both causing failed calls. Now 450k TPM. About $0.08 per call on gpt-4.1 against $0.17 on gpt-4o (published prices; check the current page). | **Mandatory:** a funded account with auto-recharge and alerts |
| Spitch | Tier 1, 3 concurrent requests. | **Mandatory before 30-call approval:** a higher tier |
| AlphaTech | Channel count unconfirmed. | **Mandatory:** confirm at least 30 channels |
| ElevenLabs | Backup capped at 10 calls on Creator. | **Recommended**, or accept a 10-call backup in writing |
| Off-site backup storage | Needed for `BACKUP_REMOTE`. | **Mandatory** |
| Staging VPS (MTN) | Needed for the load, failover and endurance gates. | **Mandatory** for certification |
| Monitoring service | External uptime and alerts. | **Mandatory** |
| Deepgram, Meta, GitHub Actions | Balances and plans not seen. | Verify (§14) |

Current official prices were **not** retrieved in this assessment; the owner must confirm them on each vendor's pricing page. Nothing was purchased.

## 14. Outstanding actions requiring the owner (numbered)

1. **Merge and deploy this release.** Confirm `releases.log` shows its commit.
2. **Backups.** Set `BACKUP_REMOTE` and `BACKUP_ENCRYPTION_KEY` in `server.env`. Run `sudo ./backup.sh`, and confirm it ends with "copied off the server".
3. **Spitch.** Request a tier that supports at least 30 simultaneous requests, and record the new limit.
4. **AlphaTech.** Confirm the contracted channel count in writing (the owner reports 100; the waiting room's defaults assume it: 30 + 60 = 90).
5. **Staging.** Provision the standby/staging VPS (Action 3), so restore, load, failover and endurance tests can be run there.
6. **Monitoring.** Set up an external uptime and TLS monitor with alerts to named administrators (Action 6).
7. **GitHub.** Protect `main` (require a PR, a passing CI, one review), and deploy only from green `main`.
8. **Model.** Re-run the conversation check on gpt-4.1 after this deploy (one run), and set `LOCAL_VOICE_LLM_MODEL` to the cheapest model that passes.
9. **Phone sign-off sheet.** Run C1–C10 (`PHONE_LINE_SIGN_OFF.md`) and record the results.
10. **Knowledge counts on production.** Count the documents, chunks, MDAs and projects, and compare them with the claimed 82 / 369 / 58 / 545.
11. **DPO.** Review §10 and `SECURITY_AND_PRIVACY_AUDIT.md`, and approve or require changes. Obtain written authorisation for the Governor's voice.
12. **NestJS 12 upgrade.** Schedule it, to close the remaining high vulnerabilities.
13. **Waiting room.**
    - After deploying, make the five recordings (`deploy/single-server/bridge/sounds/README.md`) and listen to each.
    - Check none is empty, then restart the bridge (`--env-file server.env --profile bridge`; the commands are in that README).
    - With two phones and `MAX_CONCURRENT_CALLS=1` set briefly, call twice. Confirm the second caller hears the hold message and is answered when the first hangs up, then set the limit back to 30.

## 15. Known limitations and residual risks

- A single VPS: total loss of it means downtime until a restore elsewhere.
- Spitch capacity limits how many calls can be answered at once. Callers beyond the limit now wait (up to 3 minutes), then get a callback; they are no longer turned away.
- An ElevenLabs takeover starts a fresh conversation: no mid-call context transfer.
- Speech is not streamed: about 0.6–1.1 s per sentence.
- The model can still miss script steps; the code guards cover confirmations, not every behaviour.

## 16. Final production readiness scorecard

| Category | Max | Score | Basis |
|---|---|---|---|
| Core application functionality | 15 | 9 | The conversation flow works live; several business workflows were not exercised. |
| Voice and telecommunications | 15 | 8 | Works live with root-caused fixes; no load proof; Spitch tier. |
| WhatsApp and external integrations | 10 | 4 | Automated tests only. |
| Infrastructure and reliability | 10 | 3 | Single VPS; health checks only. |
| Performance and scalability | 10 | 1 | Not tested; capacity known to be short. |
| Security and data protection | 10 | 4 | Criticals fixed; 8 high remain; no DPO review. |
| Database integrity | 5 | 2 | Not verified on production. |
| Failover and disaster recovery | 10 | 4 | Restore proven in a drill; nothing live. |
| Automated testing and regression prevention | 5 | 4 | Strong suites plus new DR and release jobs; not every gate is automated. |
| Monitoring and maintenance | 5 | 0 | None operational. |
| Subscription and commercial readiness | 5 | 2 | OpenAI resolved; Spitch, AlphaTech and others open. |
| **Total** | **100** | **41** | **Below 80: production approval rejected.** Critical gaps also block approval regardless of the score. |

## 17. Formal technical sign-off recommendation

**NO-GO: production approval withheld for release `claude/kind-darwin-bcrtsn` (PR head).** Continue controlled live operation at low volume.

Re-assess for **CONDITIONAL GO** once all of the following are done, with their evidence attached here:
- §14 items 1–7;
- the restore drill run on the staging server;
- a 10-call staging test passing at p95 under 3 s;
- C1–C10 passed.

**FULL GO** additionally requires all of the following:
- the 30- and 31-call tests;
- 24 hours of endurance testing;
- the failover drills;
- DPO approval;
- 72 hours of monitored stability.
