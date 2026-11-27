# Repository Engineering Rules — Plateau State Citizen Contact Centre

This repository powers the live **Plateau State Government Citizen Contact Centre** (`https://contact.plateaustate.gov.ng`, toll-free `+2348000000456`), operated for the **Plateau State Ministry of Information** covering all **58 MDAs** and **17 LGAs**.

Treat this codebase as **critical government production infrastructure**, not an experimental prototype. Every change must preserve service continuity, citizen privacy, and previously verified behaviour.

---

## 1. Non-Negotiable Architecture & Provider Invariants

1. **Approved Production Stack (Retain Unless Explicitly Authorised):**
   - **Host:** MTN Cloud Nigeria VPS (Docker Compose: Caddy, Next.js `web`, NestJS `api`, Asterisk 20 `bridge`, PostgreSQL 17, Redis 7.4 + BullMQ, Qdrant).
   - **Telephony:** AlphaTech PBX & SIP trunk (`+2348000000456`) → Asterisk 20 → local AudioSocket (`127.0.0.1:9092`).
   - **Primary Voice AI Pipeline (`LOCAL_VOICE_PIPELINE=1`):** Deepgram Nova-3 (STT) → OpenAI `gpt-4o-mini` (LLM + embeddings) → Spitch (primary Nigerian TTS, `jude` / `lucy` + cloned Governor greeting `SPITCH_GOVERNOR_VOICE`).
   - **Warm Voice Backup:** ElevenLabs Conversational AI (automatic failover when local registration returns `fallback <reason>` or an AudioSocket leg fails).
   - **Messaging:** Meta WhatsApp Cloud API.
   - **Networking:** Galaxy Backbone DNS + Caddy TLS + WireGuard administrative VPN.
2. **Prohibited Providers (Do NOT Introduce Without Explicit Written Approval):**
   - **Do NOT** reintroduce retired hosting providers: **DigitalOcean**, **Render**, or **Supabase**.
   - **Do NOT** introduce **Microsoft Azure** or **Africa's Talking**.
3. **Hard Capacity Ceiling:**
   - Asterisk enforces `GROUP_COUNT(inbound) > 30` and `LocalVoiceService` enforces `LOCAL_VOICE_MAX_CALLS=30`. Do not remove or bypass this ceiling without verified load-test evidence and upgraded upstream concurrency limits.
4. **Asset Preservation:**
   - Do **not** silently delete, truncate, or replace citizen records, call recordings (`/data/files`), transcripts, tickets, the 200 configured Plateau State caller personas (100 male, 100 female), the 82 indexed official documents (369 Qdrant vector chunks), or the 545 tracked government projects.
   - Never run destructive database migrations (`DROP TABLE`, `TRUNCATE`, irreversible column drops) without a verified backup and rollback plan.

---

## 2. Voice & Knowledge Base Invariants

1. **No Synthetic Fillers or Robotic Punctuation:**
   - `SpitchTts.synthesize()` strips commas and sentence-final periods/colons so Spitch never speaks `"comma"` or `"full stop"` aloud.
   - Keep `LOCAL_VOICE_ACK_AFTER_MS=0` in production and do not add `"Let me check"` / `"One second, please"` lookup-bridge instructions to `agent-tool-catalog.ts`.
2. **Anti-Hallucination & Grounded Knowledge:**
   - The assistant must answer Plateau State government questions **strictly from verified knowledge base retrieval** (`search_knowledge`). If the knowledge base does not contain the verified answer, offer an official callback or ticket — never fabricate names, dates, fees, or office addresses.
   - Never leak internal URLs (such as `tinyurl.com/accountabilityhub`) into knowledge docs or prompts.
3. **Citizen Privacy & TTS Cache Isolation:**
   - `isCacheable()` in `apps/api/src/voice-local/tts.ts` MUST prevent caching any utterance containing citizen names, phone numbers, reference numbers, or personalised text in the shared `tts-cache` directory. Only static generic prompts (greetings, NDPA disclosure, busy/fallback clips) may be cached on disk.
4. **NDPA Disclosure & Data Sovereignty Honesty:**
   - Every inbound call must play the NDPA recording/privacy disclosure before conversational capture.
   - Never claim that all AI inference occurs inside Nigeria when live audio/text traverses Deepgram, OpenAI, Meta, or ElevenLabs backup. Document cross-border data flows honestly in `docs/reliability/SECURITY_AND_PRIVACY_AUDIT.md`.

---

## 3. Change Control, Testing & Deployment Discipline

1. **Branching & Parallel Agents:**
   - Never allow two coding agents to modify the same production server or branch simultaneously.
   - Perform all stabilisation and feature work on dedicated branches (e.g. `stabilisation/*`, `fix/*`) and merge via reviewed pull requests.
2. **Mandatory Pre-Deploy Verification:**
   - Every change MUST pass `npm --workspace=@ace/api run build`, all relevant Jest unit/regression suites, and **100% green GitHub Actions CI** before any production deployment or live call recommendation.
   - Never disable or skip failing tests merely to achieve a green CI build.
   - Never replace real integration checks with mocks and claim live production verification.
3. **Production Deployment Safety:**
   - Do **not** restart production containers (`ace-api-1`, `ace-bridge-1`, `ace-postgres-1`) indiscriminately during active citizen call hours.
   - Check active calls (`asterisk -rx "core show channels count"`) before restarting `bridge` or `api`.
   - Always follow `docs/reliability/DEPLOYMENT_AND_ROLLBACK_RUNBOOK.md`.
4. **Secrets & Logs:**
   - Never commit `server.env`, `bridge.env`, API keys, passwords, JWT secrets, or citizen PII to Git, documentation, or build contexts (`.dockerignore` must exclude `deploy/single-server/server.env` and `deploy/single-server/backups`).
   - Never fabricate test results, uptime metrics, or vendor capacity claims. State clearly what was directly verified vs. what requires external vendor/account confirmation.
