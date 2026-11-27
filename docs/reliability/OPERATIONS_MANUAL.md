# Operations Manual — Plateau State Citizen Contact Centre

**Production URL:** `https://contact.plateaustate.gov.ng`  
**Toll-Free Number:** `+2348000000456`  
**Scope:** Day-to-day health checks, incident triage, log inspection, and preventive maintenance.

---

## 1. Daily Health Checks (5-Minute Routine)

Run via WireGuard VPN + SSH on MTN Cloud VPS (`102.88.134.211`):

```bash
# 1. Container health & restart counts
docker ps --format "table {{.Names}}\t{{.Status}}"

# 2. Public API health
curl -sf https://contact.plateaustate.gov.ng/api/health

# 3. AlphaTech SIP trunk registration & active calls
docker exec ace-bridge-1 asterisk -rx "pjsip show registrations"
docker exec ace-bridge-1 asterisk -rx "core show channels count"

# 4. Disk & memory headroom (alert if >75% disk or <2 GB available RAM)
df -h / /data/files
free -h

# 5. Nightly backup verification
systemctl status ace-backup.timer --no-pager
ls -lht /opt/ace/deploy/single-server/backups | head -n 5
```

---

## 2. Incident Triage Playbooks

### Playbook A: Citizens Report Silence, Busy Signal, or Dropped Calls
1. Check `ace-bridge-1` SIP registration:
   `docker exec ace-bridge-1 asterisk -rx "pjsip show registrations"`
   - If `Rejected` / `Unregistered`: check AlphaTech reachability (`ping` / `mtr` to SIP host) and escalate to AlphaTech NOC.
2. Check active call count:
   `docker exec ace-bridge-1 asterisk -rx "core show channels count"`
   - If at `30`: hard ceiling is working as designed; check call durations for stuck channels.
3. Check `ace-api-1` voice logs for Spitch 429s or circuit breaker trips:
   `docker logs --since 15m ace-api-1 | grep -E "voice_local_|spitch|circuit|429|error"`
   - If `voice_local_spitch_circuit_open` appears repeatedly: Spitch is down or hitting Tier 1 concurrency limits. Calls are auto-routing to ElevenLabs (up to ElevenLabs plan cap). Confirm ElevenLabs credits and escalate to Spitch.

### Playbook B: Garbled Words or Choppy Audio
1. Run a 100-packet `mtr` toward the AlphaTech SIP gateway to measure UDP packet loss.
2. If packet loss exceeds `1%`, capture the `mtr` report and escalate immediately to AlphaTech + MTN Cloud peering support.
3. Confirm `JITTERBUFFER(adaptive)` is active in Asterisk dialplan.

### Playbook C: WhatsApp Messages Not Arriving or Duplicating
1. Check `ace-api-1` logs for Meta webhook signature/401/403 errors.
2. Check Redis & BullMQ queue health:
   `docker exec ace-redis-1 redis-cli ping`
   `docker exec ace-redis-1 redis-cli info memory | grep used_memory_human`
3. Verify Meta WhatsApp permanent access token validity in the Meta Business Dashboard.

### Playbook D: Incorrect or Missing Government Information
1. Verify Qdrant health and chunk count (`369+` chunks across `82+` documents):
   `docker exec ace-qdrant-1 wget -qO- http://127.0.0.1:6333/healthz`
2. Do **not** manually edit live vectors; update the authoritative Markdown document in `data/mda-knowledge/`, commit via PR, and reindex cleanly.

---

## 3. Scheduled Preventive Maintenance

- **Daily:** Automated nightly backup (`ace-backup.timer`) + verify off-server `rclone` sync succeeded.
- **Weekly:** Review API balances (Spitch, Deepgram, OpenAI, ElevenLabs), disk usage on `/data/files`, and container restart counts.
- **Monthly:** Execute off-server backup restore drill on Staging/Standby VPS; review TLS expiry (`<14 days` alert); audit WireGuard peer keys.
- **Quarterly:** Review Asterisk 20.6 → 22 LTS migration readiness and security patch levels across Ubuntu/Docker images.
