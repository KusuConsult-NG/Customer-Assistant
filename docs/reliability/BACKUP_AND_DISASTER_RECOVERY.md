# Backup and Disaster Recovery — Plateau State Citizen Contact Centre

**Document Date:** 2026-11-27  
**Backup Script:** `deploy/single-server/backup.sh` (triggered nightly by `ace-backup.timer`)

---

## 1. Current State vs. Target State

| Capability | Live Production (`main`) | Stabilisation Branch (`stabilisation/production-reliability`) | Remaining User Action |
| :--- | :--- | :--- | :--- |
| PostgreSQL 17 dump (`pg_dump`) | Included | Included + `SHA256SUMS` | None |
| `/data/files` (recordings + tts-cache) | Included | Included + `SHA256SUMS` | None |
| **Qdrant vector snapshot (`369` chunks)** | **Missing** | **Added** (`qdrant.snapshot` + `SHA256SUMS`) | Deploy branch |
| **Encryption at rest before off-server upload** | **Missing** | **Added** (AES-256-CBC PBKDF2 via `BACKUP_ENCRYPTION_KEY`) | Set `BACKUP_ENCRYPTION_KEY` in `server.env` & store offline |
| **Off-server copy (`BACKUP_REMOTE`)** | **Empty (Local disk only!)** | Supported via `rclone copy` | **CRITICAL:** Configure `rclone` remote in Nigeria & set `BACKUP_REMOTE` |
| **Docker build isolation** | Nightly `root:root` backups broke `docker build` | **Fixed** (`.dockerignore` excludes `deploy/single-server/backups`) | Deploy branch |
| **Standby VPS for DR restore** | **None (Single VPS SPOF)** | Architecture & runbook ready | **CRITICAL:** Provision Standby MTN VPS #2 |

---

## 2. Recovery Objectives (RPO / RTO)

| Scenario | Current Achievable (Single VPS, No Off-Server Backup) | Target (With `BACKUP_REMOTE` + Standby MTN VPS #2) |
| :--- | :--- | :--- |
| **Container crash / bad deploy** | RPO: 0 min, RTO: 5–15 min (rollback image/commit) | RPO: 0 min, RTO: < 5 min |
| **Database corruption (host intact)** | RPO: ≤ 24 hours (local nightly dump), RTO: ~30 min | RPO: ≤ 24 hours (or ≤ 15 min with WAL archiving), RTO: ~20 min |
| **Complete MTN VPS / disk loss** | **CATASTROPHIC (Total data loss — backups on same disk!)** | **RPO: ≤ 24 hours, RTO: 1–2 hours** (restore encrypted backup onto Standby VPS + DNS/SIP cutover) |

---

## 3. Encryption & Decryption Procedure

When `BACKUP_ENCRYPTION_KEY` is set in `deploy/single-server/server.env`:
- `backup.sh` encrypts the verified archive before uploading to `BACKUP_REMOTE`:
  ```bash
  openssl enc -aes-256-cbc -pbkdf2 -salt -in backup.tar.gz -out backup.tar.gz.enc -pass env:BACKUP_ENCRYPTION_KEY
  ```
- **To decrypt during a restore drill:**
  ```bash
  BACKUP_ENCRYPTION_KEY="<from-offline-vault>" \
    openssl enc -d -aes-256-cbc -pbkdf2 -in backup.tar.gz.enc -out backup.tar.gz -pass env:BACKUP_ENCRYPTION_KEY
  ```
- **Warning:** Never commit `BACKUP_ENCRYPTION_KEY` to Git or store it solely on the primary VPS. Keep an offline copy in the Ministry's password manager.

---

## 4. Mandatory Monthly Restore Drill (On Standby/Staging VPS Only)

Never test restores against live production. Once Standby VPS #2 and `BACKUP_REMOTE` are active, execute monthly:
1. Pull latest backup from `BACKUP_REMOTE` using `rclone copy`.
2. Decrypt (if `.enc`) and verify `sha256sum -c SHA256SUMS`.
3. Restore PostgreSQL dump into staging `ace-postgres-1` and verify row counts across `Organization`, `Conversation`, `Ticket`, `KnowledgeDocument`.
4. Restore `qdrant.snapshot` into staging `ace-qdrant-1` via Qdrant snapshot recover API and verify `369+` vector chunks.
5. Restore `/data/files` and verify sample WAV recordings and pre-rendered Governor greetings play cleanly.
6. Record actual restore duration (RTO) and sign off in the operations log.
