# Security and Privacy Audit — Plateau State Citizen Contact Centre

**Audit Date:** 2026-11-27  
**Regulatory Context:** Nigeria Data Protection Act (NDPA) 2023 & Plateau State Government information security standards.

---

## 1. Honest Data Sovereignty & Cross-Border Data Flow Map

**Critical Clarification:** While the primary application, PostgreSQL 17 database, Qdrant vector store, Redis queues, and call recordings (`/data/files`) are hosted inside **Nigeria on MTN Cloud (`102.88.134.211`)**, real-time AI inference and messaging necessarily transmit transient citizen audio/text to external API providers. **The platform must NOT claim that 100% of data processing occurs solely within Nigeria** until provider data-processing agreements (DPAs) and NDPA cross-border transfer bases are formally approved by the Ministry's Data Protection Officer (DPO).

| Data Flow | Data Sent | Provider | Processing Jurisdiction | Stored Permanently? |
| :--- | :--- | :--- | :--- | :--- |
| Citizen records, tickets, transcripts, recordings | Name, phone, issue details, WAV audio | **MTN Cloud Nigeria VPS** | **Nigeria** | Yes (PostgreSQL + `/data/files`) |
| Real-time speech-to-text (STT) | Live 8 kHz caller audio stream | **Deepgram (Nova-3)** | US / EU cloud | Transient (verify zero-data-retention setting in Deepgram console) |
| Conversational reasoning & embeddings | Transcript text + KB snippets | **OpenAI (`gpt-4o-mini`)** | US cloud | API zero-training by default; verify ZDR/retention in OpenAI org settings |
| Primary voice synthesis (TTS) | Assistant reply text (no PII cached on disk) | **Spitch** | Nigeria / Cloud (confirm exact hosting region with Spitch) | Transient |
| Warm voice failover (backup only) | Live call audio + transcript (only during failover) | **ElevenLabs** | US / EU cloud | Verify retention / disable training in ElevenLabs workspace |
| Citizen WhatsApp messaging | Phone number + chat messages | **Meta WhatsApp Cloud API** | Global / US | Per Meta WhatsApp Business DPA |

---

## 2. Security Controls Verified & Hardened

| Control Area | Finding / State | Action Taken on Branch / Status |
| :--- | :--- | :--- |
| **Secrets in Git / Docker Context** | `deploy/single-server/server.env` and `deploy/single-server/backups` were not in `.dockerignore` | **Fixed:** Added both to `.dockerignore` so secrets and nightly dumps can never enter Docker build contexts. |
| **AudioSocket Authentication** | AudioSocket TCP (`9092`) carries unauthenticated raw PCM | **Verified Safe Topology:** Bound strictly to `127.0.0.1:9092` on host; registration requires timing-safe `LOCAL_VOICE_SECRET` (`timingSafeEqual`). |
| **Citizen PII in Shared TTS Cache** | Shared `/data/files/tts-cache` must never store personalised speech | **Verified & Guarded:** `isCacheable()` rejects names, phone numbers, and reference numbers; enforced by new regression test in `voice-local-tts.spec.ts`. |
| **Backup Encryption** | Nightly backup tarballs were previously unencrypted | **Fixed:** Added optional AES-256-CBC PBKDF2 encryption (`BACKUP_ENCRYPTION_KEY`) in `backup.sh` prior to off-server `rclone` upload. |
| **NDPA Call Disclosure** | Inbound callers must be informed of recording/AI processing | **Verified Live:** Pre-rendered NDPA disclosure plays automatically on every inbound call via `jude` / `lucy`. |
| **Least-Privilege API Keys** | Deepgram API key returned `403` on `/balances` | **Verified Good Practice:** Runtime voice key lacks billing/admin scope. |
| **TLS & Admin Access** | Caddy auto-TLS (Let's Encrypt YE1 valid to Feb 23, 2027) + WireGuard VPN | **Verified Live.** |
| **Internal URL Hygiene** | `tinyurl.com/accountabilityhub` previously appeared in scraped docs | **Resolved Live:** Scrubbed completely (`0` leaks in repo and Qdrant). |

---

## 3. Security Hardening Actions Still Required (Ops / User)

1. **NDPA Cross-Border Sign-Off:** Obtain formal DPO approval / DPAs for Deepgram, OpenAI, Spitch, Meta, and ElevenLabs, and verify zero-data-retention / opt-out-of-training toggles in each provider console.
2. **SSH & Firewall Audit on MTN VPS:** Confirm password SSH login is disabled once WireGuard SSH keys are verified for all authorised administrators, and verify UFW/iptables exposes only `80/tcp`, `443/tcp`, WireGuard UDP, and AlphaTech SIP/RTP IP ranges.
3. **Secret Rotation Policy:** Schedule periodic rotation of `LOCAL_VOICE_SECRET`, `SIP_BRIDGE_SECRET`, `JWT_SECRET`, and `QDRANT_API_KEY` (never rotate `ENCRYPTION_KEY` without an encrypted-column migration plan).
4. **Recording Retention Policy:** Define and automate a formal retention window (e.g., 90 or 180 days) for citizen WAV recordings in `/data/files` to comply with NDPA data minimisation and prevent disk exhaustion.
