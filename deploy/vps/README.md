# One server for everything (PICTDA VPS)

The whole platform on one Ubuntu server, in place of Render, Supabase and the
DigitalOcean SIP bridge:

| Was | Now, on this server |
|---|---|
| Render `ace-api` | `ace-api` (systemd), Node 20, port 4000, localhost only |
| Render `ace-web` | `ace-web` (systemd), Next.js, port 3000, localhost only |
| Supabase Postgres 17 | PostgreSQL **17**, localhost only |
| Supabase Storage | files on disk at `/srv/ace/storage`, served by the API through signed, expiring links |
| Upstash Redis | Redis 7, localhost only, password, no eviction |
| Qdrant | Qdrant (systemd), localhost only, API key |
| DigitalOcean Asterisk | Asterisk 20 (`infra/sip-bridge/setup.sh`), highest CPU priority |
| Render HTTPS | Caddy: one domain, automatic Let's Encrypt |

Only SSH, 80/443, SIP 5060 and RTP 10000–20000/UDP are open. Everything else
listens on 127.0.0.1.

**Why PostgreSQL 17 and not 16.** Production on Supabase runs 17.6. A dump
cannot be restored onto an older major version, so 17 is what the data can
move onto. `PG_VERSION` in `deploy.env` changes it.

## What the server needs

- Ubuntu **24.04** (or 22.04), x86-64, a fresh install.
- **4 vCPU, 8 GB RAM, 80 GB SSD** at the least. The build alone needs about
  3 GB of RAM. Calls are real-time, and the voice line runs inside the API.
- A DNS **A record** for the domain (e.g. `contact.plateaustate.gov.ng`)
  pointing at the server *before* install, or HTTPS cannot be issued.
- PICTDA's own firewall, if there is one in front of the VPS, open for:
  TCP 22, 80, 443; UDP 443; TCP+UDP 5060; UDP 10000–20000.
- Outbound HTTPS to: apt.postgresql.org, deb.nodesource.com,
  dl.cloudsmith.io, github.com, registry.npmjs.org, and the providers
  (api.openai.com, api.deepgram.com, api.elevenlabs.io,
  *.tts.speech.microsoft.com, graph.facebook.com, api.resend.com).

## Install

```bash
sudo git clone <repository URL> /srv/ace/app        # a deploy key or token: the repo is private
cd /srv/ace/app/deploy/vps
sudo cp deploy.env.example deploy.env && sudo nano deploy.env
sudo ./install.sh
```

`deploy.env` explains every value. Two matter more than the rest:

- **`ENCRYPTION_KEY` must be production's value**, copied from Render. Every
  stored provider credential is encrypted with it (WhatsApp tokens, the
  ElevenLabs key, the SIP password). The installer refuses anything that is
  not a 32-byte key, but it cannot tell a *different* key from the right one.
- `JWT_SECRET` / `JWT_REFRESH_SECRET`: the same values keep everyone signed
  in across the move. New values just sign everyone out once.

The installer generates and keeps its own secrets in
`/etc/ace/generated.env` (root only): the database, Redis and Qdrant
passwords, the file-link signing key and the voice-line secret. It writes the
app's settings to `/etc/ace/ace.env`. Re-running it is safe. Nothing is
dropped, secrets are kept, configs are re-rendered.
`sudo ./install.sh --skip-build` reconfigures without rebuilding.

Then the phone bridge:

```bash
cd /srv/ace/app/infra/sip-bridge
sudo cp bridge.env.example bridge.env && sudo nano bridge.env
#   LOCAL_VOICE=0 for now; LOCAL_VOICE_SECRET = the value in /etc/ace/generated.env
sudo ./setup.sh
```

`sudo ./check.sh` at any time lists every service and probes the app from
inside and outside.

## Moving production

Rehearse first, while Render still serves everyone. A rehearsal only *reads*
Supabase.

```bash
sudo ./migrate-from-supabase.sh            # report: rows and files on both sides
sudo ./migrate-from-supabase.sh --apply    # copy: database, then files; verifies every table's row count
```

Sign in on `https://<domain>` and look around. Then, for the real move:

1. **Freeze Render.** Suspend `ace-api` and `ace-web` in the Render
   dashboard, so nothing more is written to Supabase.
2. **Copy again.** `sudo ./migrate-from-supabase.sh --apply`. It asks before
   replacing the rehearsal's data, backs it up first, and stops if any
   table's row count differs from Supabase.
3. **Knowledge → Reindex**, signed in as each agency's administrator. This
   server's Qdrant is new, so until then answers use keyword search only.
4. **Point the outside world here.** Each of these has the old Render URL:
   - **ElevenLabs agent:** Settings → Hosted Agent → **Sync configuration**.
     Every tool URL is built from `API_BASE_URL`, which is now this domain.
   - **ElevenLabs post-call webhook:** Sync does NOT set this one. In the
     ElevenLabs workspace settings, set it to the URL shown at Agent
     Provisioning → Credentials
     (`https://<domain>/api/webhooks/elevenlabs/<organizationId>`). Calls are
     still recorded if it is missed: the platform pulls finished calls every
     two minutes. The webhook just makes them appear at once.
   - **ElevenLabs phone number → inbound allowed addresses:** add this
     server's IP (the bridge now runs here, not on DigitalOcean).
   - **Alphatech:** the extension now registers from this server's IP. Tell
     them if they filter by IP.
   - **Meta WhatsApp** (developers.facebook.com → the app → WhatsApp →
     Configuration): callback URL `https://<domain>/api/whatsapp/webhook`,
     with the same verify token.
   - **Twilio**, only if an agency still uses a Twilio number: Telephony →
     "Point number at platform".
5. **Call the toll-free line** and send a WhatsApp message. Check both show on
   the dashboard.
6. Keep Render and Supabase **suspended, not deleted**, for two weeks.

**Going back** before step 6 ends: resume Render, and point the webhooks
(step 4) back at the Render URL. Anything written on this server after the
move is not copied back. Note it, or re-enter it.

## Running it

| | |
|---|---|
| Deploy a new version | `sudo ./update.sh [branch-or-tag]`. Backs up first, builds, updates the schema, restarts both. If the server cannot reach GitHub, copy the release into `/srv/ace/app` (rsync/scp) and run `sudo ./update.sh --local`. |
| Logs | `journalctl -u ace-api -f`, `journalctl -u ace-web -f`, `asterisk -rvvv` |
| Backups | nightly at 02:30 to `/srv/ace/backups` (database + files), kept `BACKUP_KEEP_DAYS` |
| Restore | `sudo ./restore.sh /srv/ace/backups/<stamp>` (asks first) |
| Health | `sudo ./check.sh` |

**A backup on the same disk survives a bad deploy, not a lost server.** Set
`BACKUP_RSYNC_TARGET` in `deploy.env` (e.g. `backup@10.0.0.5:/backups/ace`, or
a PICTDA backup volume's mount point) and each night's backup is also copied
there.

## What is still Phase 2/3

The voice line still goes to ElevenLabs (`LOCAL_VOICE=0`). Answering on this
server (`LOCAL_VOICE_PIPELINE=1` in deploy.env + `LOCAL_VOICE=1` in
bridge.env) is switched on only after the live-call checks in
`PHASE3.md`, and ElevenLabs stays as the automatic fallback until then.
