# Infrastructure Requirements — Plateau State Citizen Contact Centre

This document defines the minimum and recommended infrastructure required to operate the Plateau State Citizen Contact Centre reliably at **30 simultaneous voice calls**, alongside Meta WhatsApp Cloud API traffic and the administrative dashboard, while keeping citizen data hosted in Nigeria.

---

## 1. Target Reliability Architecture

```
Citizens (Toll-Free +2348000000456)          Citizens (WhatsApp)           Admin Staff (WireGuard VPN / HTTPS)
            │                                        │                                    │
            ▼                                        ▼                                    ▼
   AlphaTech SIP Trunk                     Meta WhatsApp Cloud API             Galaxy Backbone DNS
   (30+ concurrent channels,                                                              │
    <1% UDP packet loss)                                                                  ▼
            │                                                                   Caddy Reverse Proxy
            ▼                                                                   (Let's Encrypt TLS)
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ PRIMARY NODE — MTN Cloud Nigeria VPS (102.88.134.211)                                           │
│  ├── ace-bridge-1   (Asterisk 20.6 → planned 22 LTS, AudioSocket 127.0.0.1:9092, cap=30)        │
│  ├── ace-api-1      (NestJS API + Local Voice Engine + BullMQ workers)                          │
│  ├── ace-web-1      (Next.js Admin Dashboard)                                                   │
│  ├── ace-postgres-1 (PostgreSQL 17 — 39 tables, citizen records, tickets, transcripts)          │
│  ├── ace-redis-1    (Redis 7.4 — BullMQ queues, rate limits, session state)                     │
│  ├── ace-qdrant-1   (Qdrant — 82 docs / 369 vector chunks)                                      │
│  └── /data/files    (Call recordings + static tts-cache clips)                                  │
└───────────────────────────────────────┬─────────────────────────────────────────────────────────┘
                                        │ Nightly Encrypted rclone Sync (AES-256 + SHA256SUMS)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ OFF-SERVER STORAGE (Nigeria) + STANDBY / STAGING NODE (MTN Cloud Nigeria VPS #2)                │
│  ├── Encrypted nightly backups: PostgreSQL dump + Qdrant snapshot + /data/files                 │
│  └── Warm standby / isolated staging environment for pre-deploy & load testing                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Compute & Memory Sizing (30 Simultaneous Calls)

Each active AudioSocket call consumes:
- Asterisk RTP + AudioSocket leg + adaptive jitter buffer (~3–5 MB RAM, low CPU).
- NestJS `VoiceSession` (Deepgram WebSocket, OpenAI streaming SSE, Spitch HTTP + 24kHz→8kHz FIR resampler, PCM recording buffer: ~15–25 MB RAM).
- Concurrent PostgreSQL + Qdrant + Redis operations.

| Component | Recommended Minimum (Single Primary Node) | Container `mem_limit` on Branch |
| :--- | :--- | :--- |
| **MTN Cloud Primary VPS** | 8 vCPU, 16 GB RAM, 200 GB NVMe SSD, 1 Gbps NIC | Enforced per-service limits in `docker-compose.yml` |
| `ace-postgres-1` | Dedicated WAL + shared buffers | `2g` (`pids_limit: 256`) |
| `ace-api-1` | Voice engine + API + BullMQ | `3g` (`pids_limit: 512`) |
| `ace-qdrant-1` | Vector search (369+ chunks, room for 10x growth) | `1g` (`pids_limit: 256`) |
| `ace-web-1` | Next.js SSR dashboard | `1g` (`pids_limit: 256`) |
| `ace-redis-1` | BullMQ + volatile cache | `512m` (`pids_limit: 128`) |
| `ace-bridge-1` | Asterisk SIP + 30 RTP/AudioSocket legs | `1g` (`pids_limit: 512`) |
| **MTN Cloud Standby / Staging VPS** | 4–8 vCPU, 8–16 GB RAM, 200 GB SSD (same Nigeria region) | Mirrors `docker-compose.yml` |

*Note: If the current MTN VPS has less than 16 GB RAM, review actual host RAM via `free -h` before deploying the branch `mem_limit` values so total limits remain safely below physical RAM.*

---

## 3. Network, Telephony & DNS Requirements

| Requirement | Current State | Target State |
| :--- | :--- | :--- |
| **AlphaTech SIP Trunk Channels** | Active (`alphatech-reg Registered`), channel cap unconfirmed | Written confirmation of **≥30 simultaneous channels** on `+2348000000456` |
| **Carrier UDP Path Quality** | `6.7%–30%` loss observed at Hop 9 (`197.253.11.119`) | `<1%` packet loss, `<30 ms` jitter end-to-end |
| **Public DNS** | Galaxy Backbone DNS → `102.88.134.211` | TTL ≤ 300s to enable fast failover to Standby VPS |
| **TLS Certificates** | Caddy Let's Encrypt YE1 (auto-renewing) | Validated via external TLS expiry monitor (alert at <14 days) |
| **Admin Access** | WireGuard VPN | Maintain WireGuard + SSH key-only auth; restrict SSH port to VPN/bastion |
| **External Monitoring** | None (only 30-min GitHub Actions ping) | Independent external uptime monitor (1-min checks on `/api/health`, TLS, disk, SIP) |

---

## 4. Storage & Off-Server Backup Requirements

- **Local Disk:** `/data/files` must maintain ≥30% free disk space with automated alerting at 75% (warning) and 85% (critical).
- **Off-Server Backup Target (`BACKUP_REMOTE`):** S3-compatible object storage hosted in Nigeria (or encrypted SFTP to Standby MTN VPS) with ≥30 days retention.
- **Encryption:** `BACKUP_ENCRYPTION_KEY` stored offline in the Ministry's password manager (never in Git).
- **Prohibited Hosts:** DigitalOcean, Render, Supabase, Microsoft Azure, and Africa's Talking are explicitly excluded.
