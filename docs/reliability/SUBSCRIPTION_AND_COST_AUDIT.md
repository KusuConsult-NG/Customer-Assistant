# Subscription and Cost Audit — Plateau State Citizen Contact Centre

**Audit Date:** 2026-11-27  
**Baseline Verified Savings:** Migrating default LLM from `gpt-4o` to `gpt-4o-mini` and shifting primary calls from ElevenLabs (`$0.1964/min` verified baseline) to the local Deepgram + OpenAI + Spitch pipeline reduces per-minute voice cost by **~80–88%**.

---

## 1. Current Provider & Subscription Classification

| Provider / Service | Role | Verified Current Status | Classification | Action Required |
| :--- | :--- | :--- | :--- | :--- |
| **MTN Cloud Nigeria VPS #1** | Primary production host (`102.88.134.211`) | Active, hosting all containers | **Mandatory** | Retain; verify RAM/disk headroom |
| **MTN Cloud Nigeria VPS #2** | Warm standby + isolated staging | **Not yet provisioned** | **Mandatory** (for DR & safe staging) | User to provision |
| **Off-Server Backup Storage (Nigeria)** | Nightly encrypted `rclone` target (`BACKUP_REMOTE`) | **Not yet configured** | **Mandatory** | User to provision S3-compatible / SFTP target |
| **AlphaTech SIP Trunk** | Toll-free `+2348000000456` carrier | Active (`alphatech-reg Registered`); Hop 9 packet loss observed | **Mandatory** | Confirm ≥30 channels & fix packet loss |
| **Spitch API** | Primary Nigerian TTS (`jude`, `lucy`, Governor clone) | Active on **Tier 1 (`3 concurrent requests` max)** | **Mandatory** | **Upgrade tier** before 30-call production |
| **Deepgram Nova-3** | Real-time Speech-to-Text (STT) | Active (key lacks `billing:read`, balance unverified via API) | **Mandatory** | Check balance & set low-credit alert in console |
| **OpenAI (`gpt-4o-mini` + embeddings)** | Conversational LLM + knowledge embeddings | Active | **Mandatory** | Set hard monthly budget cap & alert in console |
| **Meta WhatsApp Cloud API** | Citizen WhatsApp channel | Active | **Mandatory** | Monitor webhook token & Meta business verification |
| **Galaxy Backbone DNS** | Public `.gov.ng` DNS | Active | **Mandatory** | Confirm TTL ≤ 300s for DR cutover |
| **ElevenLabs** | Warm voice failover backup | Active on **Creator (`$22/mo`, `166,998/231,000` credits used, `10` concurrent cap)** | **Recommended** (Mandatory if zero-outage voice fallback required) | Decide: stay Creator (covers ≤10 failover calls) or upgrade to Scale (`$299/mo`, 30 concurrent) |
| **External Uptime Monitor** | Independent health/TLS/SIP alerting | **Not yet configured** | **Recommended** | Deploy Uptime Kuma / external monitor outside MTN VPS |
| **DigitalOcean / Render / Supabase** | Retired legacy hosting | Retired from production | **Unnecessary** | Confirm all billing cancelled; do not reintroduce |
| **Microsoft Azure / Africa's Talking** | Not used | Prohibited by mandate | **Unnecessary** | Do not procure |

---

## 2. Estimated Monthly Variable Voice Cost Scenarios (Primary Local Pipeline)

*Assumptions based on published pay-as-you-go API rates as of audit date (Deepgram Nova-3 streaming ~$0.0043–$0.0077/min; OpenAI `gpt-4o-mini` ~$0.002–$0.004/min; Spitch TTS estimated ~$0.01–$0.02/min depending on contracted Nigerian tier; average blended local pipeline ~$0.020–$0.032/min vs. previous ElevenLabs+`gpt-4o` baseline of `$0.1964/min`). Exact Spitch enterprise pricing must be confirmed with Spitch sales.*

| Monthly Call Volume | Previous ElevenLabs (`gpt-4o`) Baseline | Local Pipeline (`Deepgram + gpt-4o-mini + Spitch`) Estimate | Estimated Monthly Savings |
| :--- | :--- | :--- | :--- |
| **1,000 min / month** (~333 3-min calls) | ~$196 / mo | **~$20 – $32 / mo** (+ fixed VPS/backup/ElevenLabs standby) | ~$164 – $176 / mo (~84%) |
| **10,000 min / month** (~3,333 3-min calls) | ~$1,964 / mo | **~$200 – $320 / mo** (+ fixed VPS/backup/ElevenLabs standby) | ~$1,644 – $1,764 / mo (~84%) |
| **50,000 min / month** (~16,667 3-min calls) | ~$9,820 / mo | **~$1,000 – $1,600 / mo** (+ fixed VPS/backup/ElevenLabs standby) | ~$8,220 – $8,820 / mo (~84%) |

---

## 3. Credit Exhaustion & Rate-Limit Safeguards

1. **No Auto-Spend Surprises:** No subscriptions or upgrades are purchased automatically.
2. **Pre-Rendered Disk Cache:** All 3 time-of-day Governor greetings and `jude`/`lucy` NDPA clips are cached on `/data/files/tts-cache`, eliminating thousands of repetitive TTS API calls per month.
3. **Alerting Thresholds Required (User Action):**
   - **OpenAI:** Set soft alert at 75% and hard monthly limit in OpenAI Billing.
   - **Deepgram:** Set low-balance email alert in Deepgram Console (and confirm auto-recharge or manual top-up policy).
   - **Spitch:** Confirm contracted concurrency limit (≥30 simultaneous synthesis requests or ≥15 with verified queue latency <400ms) and credit-balance alerts.
   - **ElevenLabs:** Monitor remaining monthly credits (`64,002` credits remaining on Creator at audit time) so failover never lands on an empty wallet.
