# Deployment and Rollback Runbook — Plateau State Citizen Contact Centre

**Target Host:** MTN Cloud Nigeria VPS (`102.88.134.211`)  
**Rule:** Never deploy untested changes or restart live voice containers while citizens are on active calls.

---

## 1. Pre-Deployment Checklist (Mandatory Gates)

Before touching production, verify **all** of the following:
1. [ ] Pull request merged to `main` (or explicitly approved release tag).
2. [ ] **GitHub Actions CI is 100% green** on the exact commit SHA to be deployed.
3. [ ] Host RAM headroom verified (`free -h`) against `docker-compose.yml` `mem_limit` totals.
4. [ ] Disk space verified (`df -h / /data/files`) — must have ≥20% free space before building images.
5. [ ] Fresh backup triggered or confirmed from last 24 hours (`ls -lh deploy/single-server/backups/`).
6. [ ] Active citizen call count checked:
   ```bash
   docker exec ace-bridge-1 asterisk -rx "core show channels count"
   ```
   Wait until `0 active calls` (or schedule a low-traffic maintenance window, e.g., 01:00–04:00 WAT) before recreating `ace-api-1` or `ace-bridge-1`.

---

## 2. Controlled Deployment Procedure

```bash
# 1. Connect via WireGuard VPN + SSH
cd /opt/ace # (or repo directory on MTN VPS)

# 2. Record current known-good commit SHA for instant rollback
git rev-parse HEAD > /tmp/last_known_good_sha
cat /tmp/last_known_good_sha

# 3. Pull verified main commit
git fetch origin main
git checkout main
git pull --ff-only origin main

# 4. Validate docker-compose config before building
cd deploy/single-server
docker compose --env-file server.env config > /dev/null

# 5. Build new images while old containers continue serving traffic
docker compose --env-file server.env build api web bridge

# 6. Confirm 0 active calls on Asterisk
docker exec ace-bridge-1 asterisk -rx "core show channels count"

# 7. Recreate services cleanly (graceful 30s stop period)
docker compose --env-file server.env up -d --remove-orphans

# 8. Post-deploy verification (must all pass)
docker compose --env-file server.env ps
curl -sf https://contact.plateaustate.gov.ng/api/health
docker exec ace-bridge-1 asterisk -rx "pjsip show registrations" | grep alphatech-reg
```

---

## 3. Instant Rollback Procedure (< 5 Minutes)

If `/api/health` fails, SIP registration drops, or live test call exhibits errors:

```bash
cd /opt/ace
PREV_SHA=$(cat /tmp/last_known_good_sha)
git checkout "$PREV_SHA"

cd deploy/single-server
docker compose --env-file server.env build api web bridge
docker compose --env-file server.env up -d --remove-orphans

# Verify recovery
docker compose --env-file server.env ps
curl -sf https://contact.plateaustate.gov.ng/api/health
docker exec ace-bridge-1 asterisk -rx "pjsip show registrations" | grep alphatech-reg
```

### Emergency Voice-Only Fallback (Zero Rebuild — 5 Seconds)
If the local Spitch/Deepgram/OpenAI voice pipeline degrades while the rest of the platform is healthy:
1. Edit `deploy/single-server/server.env` and set `LOCAL_VOICE_PIPELINE=0`.
2. Recreate `api` only (`docker compose --env-file server.env up -d api`).
3. Every inbound call immediately routes to ElevenLabs backup until the local pipeline issue is resolved.
