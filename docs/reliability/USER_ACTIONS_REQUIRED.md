# User Actions Required — Plateau State Citizen Contact Centre

All engineering fixes that could be safely implemented in code and configuration are complete on branch `stabilisation/production-reliability`. The items below **cannot** be completed by coding agents because they require **vendor account access, billing approval, infrastructure procurement, or government legal sign-off**.

They are ordered strictly by **urgency**.

---

## Action 1 — CRITICAL (Before High-Volume Public Launch): Upgrade Spitch API Concurrency Tier
- **Why:** Live production errors (`HTTP 429 concurrency_limit_exceeded`) proved the current Spitch account is **Tier 1 (`3 concurrent requests` max)**. Our code now prevents 429 crashes and trips a circuit breaker to ElevenLabs, **but 30 simultaneous citizens cannot be served on Tier 1**.
- **Where:** Spitch dashboard / enterprise sales (`https://spitch.app`).
- **What to do:** Request an upgrade to a concurrency tier supporting **at least 30 simultaneous TTS requests** (or confirm contracted rate limits in writing) and enable low-credit alerts.
- **What succeeds once done:** Primary Nigerian voice pipeline (`jude`, `lucy`, Governor greeting) can safely handle up to 30 concurrent calls without queuing or tripping failover.

---

## Action 2 — CRITICAL (Immediate — Data Loss Risk): Configure Off-Server Encrypted Backups (`BACKUP_REMOTE`)
- **Why:** Right now, nightly backups are saved **only on the same MTN server disk** as the live database and recordings. If that server or disk fails, both live data and backups are lost together.
- **Where:** MTN Cloud Nigeria object storage (or S3-compatible Nigerian storage / Standby VPS SFTP).
- **What to do:**
  1. Provision an off-server storage bucket/location in Nigeria (≥200 GB).
  2. Generate an encryption passphrase: `openssl rand -hex 32` and store it **offline** in the Ministry's password manager.
  3. On the MTN VPS, run `rclone config` to add the remote, then set `BACKUP_REMOTE=` and `BACKUP_ENCRYPTION_KEY=` in `deploy/single-server/server.env`.
- **What succeeds once done:** Nightly PostgreSQL + Qdrant + `/data/files` backups are AES-256 encrypted and safely copied off-server every night.

---

## Action 3 — CRITICAL (Disaster Recovery & Safe Testing): Provision MTN Cloud Nigeria Standby / Staging VPS #2
- **Why:** Everything currently runs on one MTN VPS (`102.88.134.211`) — a single hardware/network failure takes down voice, WhatsApp, and the admin dashboard simultaneously, and there is no safe isolated staging server for 30-call load testing or Asterisk 22 LTS upgrades.
- **Where:** MTN Cloud Nigeria portal.
- **What to do:** Provision a second VPS in MTN Cloud Nigeria (recommended: 4–8 vCPU, 8–16 GB RAM, 200 GB SSD) and grant engineering SSH/WireGuard access.
- **What succeeds once done:** Enables isolated 30-call SIPp load testing, monthly backup restore drills, Asterisk 22 LTS staging validation, and 1–2 hour disaster recovery cutover.

---

## Action 4 — HIGH (Call Clarity & 30-Call Capacity): Escalate to AlphaTech Telecoms
- **Why:** Network diagnostics (`mtr`) from the MTN VPS measured **6.7%–30% UDP packet loss** on Hop 9 (`197.253.11.119`), which directly caused audible word clipping in recorded calls (e.g., `"Governor's"` clipped to `"nurse"`). Contracted simultaneous channel count on `+2348000000456` is also unconfirmed.
- **Where:** AlphaTech NOC / Account Manager.
- **What to do:**
  1. Share the Hop 9 (`197.253.11.119`) UDP packet-loss report and request peering/routing remediation to `<1%` loss.
  2. Request written confirmation that toll-free trunk `+2348000000456` supports **≥30 simultaneous inbound channels**.
  3. Ask whether AlphaTech supports a **secondary SIP failover IP** (for Standby VPS #2).
- **What succeeds once done:** Eliminates carrier-induced word clipping and confirms telephony capacity for 30 concurrent callers.

---

## Action 5 — HIGH (Failover Capacity Decision): Confirm ElevenLabs Warm Backup Plan
- **Why:** Live account inspection confirmed ElevenLabs is on **Creator (`$22/month`, `10` concurrent calls max, `166,998 / 231,000` credits used)**.
- **Where:** ElevenLabs Billing (`https://elevenlabs.io/app/subscription`).
- **What to do:** Choose one of two policy options:
  - **Option A (Full 30-Call Failover):** Upgrade to **Scale (`$299/month`, 30 concurrent calls)** so all 30 calls can fail over simultaneously if Spitch goes down.
  - **Option B (Cost-Controlled Degraded Failover):** Stay on **Creator (`$22/month`)**, accepting that during a Spitch outage up to **10** simultaneous calls are served by ElevenLabs while calls 11–30 receive busy/callback guidance, and monitor remaining monthly credits.
- **What succeeds once done:** Removes ambiguity over backup capacity during a primary TTS outage.

---

## Action 6 — MEDIUM (Prevent Silent Outages): Set Billing Alerts & External Uptime Monitor
- **Deepgram Console (`https://console.deepgram.com`):** Check credit balance (runtime API key rightly lacks billing read access) and enable low-balance email alerts.
- **OpenAI Billing (`https://platform.openai.com/settings/organization/billing`):** Set soft (75%) and hard monthly budget alerts.
- **External Monitor:** Deploy an independent uptime monitor outside the MTN VPS (e.g., Uptime Kuma on Standby VPS #2 or a managed ping monitor) checking `https://contact.plateaustate.gov.ng/api/health` and TLS certificate expiry every 60 seconds with WhatsApp/email/SMS alerts.
- **Retired Cloud Accounts:** Confirm **DigitalOcean, Render, and Supabase** billing accounts are fully cancelled/deleted to prevent unnecessary recurring charges.

---

## Action 7 — MEDIUM (Governance): NDPA Data Protection Officer (DPO) Sign-Off
- **Why:** Citizen records and recordings stay in Nigeria (MTN Cloud), but live AI inference traverses **Deepgram (US/EU)**, **OpenAI (US)**, **Meta WhatsApp (Global/US)**, and **ElevenLabs backup (US/EU)**.
- **What to do:** Have the Ministry's DPO review `docs/reliability/SECURITY_AND_PRIVACY_AUDIT.md`, approve the cross-border processing basis/DPAs under NDPA 2023, confirm zero-data-retention / no-training toggles in Deepgram, OpenAI, and ElevenLabs consoles, and approve a recording retention window (e.g., 90 or 180 days).

---

## Action 8 — CRITICAL (Calls fail over without it): OpenAI Account Limits and Budget for the Phone Line
- **Why:** The local phone line sends the call script with every reply, about 10,000–12,000 tokens. On 28 Nov 2026, an account with no credit, and then an account capped at 10,000 tokens per minute, made every model request fail. Calls went to the fallback line, with HTTP 429 errors in `voice_local_call_ended`.
- **What to do:** In `https://platform.openai.com/settings/organization/limits`, confirm that the gpt-4o / gpt-4.1 tokens-per-minute limit covers the simultaneous calls expected (about 75,000 per busy call). Turn on auto-recharge, or a low-balance alert, under Billing. Then choose the model with `docs/reliability/PHONE_LINE_SIGN_OFF.md` §2.2.
- **What succeeds once done:** Calls are answered by the agent, with no `failed_over`, and the conversation check completes.

