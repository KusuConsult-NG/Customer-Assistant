# The whole platform on one server

Everything runs on one Ubuntu server: the database, Redis, Qdrant, the API,
the staff dashboard, HTTPS, the call bridge, uploaded files and the nightly
backups. Nothing depends on Render or Supabase once the move is done.

```
Internet ──443/80──▶ Caddy (HTTPS, automatic certificate)
                       ├─ /api/*, /socket.io/*, /telephony/stream/*  ──▶ API
                       └─ everything else                             ──▶ dashboard
                     API ──▶ PostgreSQL · Redis · Qdrant · files volume   (internal only)
Alphatech PBX ──5060 + UDP 10000–20000──▶ call bridge (Asterisk) ──▶ ElevenLabs
```

Only ports 80 and 443 (Caddy) and the call ports (5060, UDP 10000–20000) are
open to the internet. The database, Redis, Qdrant, the API and the dashboard
have no public port at all.

## The server

| | Minimum |
|---|---|
| CPU / memory / disk | 4 vCPU, 8 GB RAM, 100 GB SSD |
| System | Ubuntu 24.04 (22.04 also works) |
| Address | A **fixed** public IPv4 address (ElevenLabs only accepts calls from addresses you list) |
| Bandwidth | About 20 Mbit/s each way for 100 simultaneous calls |

The bandwidth figure is arithmetic, not a measurement: a G.711 call is about
87 kbit/s each way including packet overhead, and every call crosses the server
twice (PBX → bridge → ElevenLabs), so 100 calls ≈ 17.4 Mbit/s each way.

The call bridge gets four times the CPU share of everything else, so a busy
dashboard or a large upload cannot make a call stutter.

## First-time setup

1. **DNS.** Create an A record for the domain the platform will use (for
   example `care.example.gov.ng`) pointing at the server's public IP. Caddy cannot
   obtain the HTTPS certificate until this resolves.

2. **Get the code and prepare the server** (as root):

   ```bash
   git clone https://github.com/KusuConsult-NG/Customer-Assistant.git /opt/customer-assistant
   ```

   ```bash
   cd /opt/customer-assistant/deploy/single-server && sudo ./install.sh
   ```

   This installs Docker, rclone and the firewall rules, and schedules the
   nightly backup (02:30, Nigerian time).

3. **Settings.** Copy the template and fill it in:

   ```bash
   cp server.env.example server.env && chmod 600 server.env && nano server.env
   ```

   Copy every value from Render (your dashboard → `ace-api` → Environment)
   **unchanged**. `ENCRYPTION_KEY` matters most: every stored WhatsApp and
   phone-line credential is encrypted with it, and a different key leaves
   every line unable to authenticate.

4. **Call bridge settings** (only if this server will also carry the
   toll-free line):

   ```bash
   cp ../../infra/sip-bridge/bridge.env.example ../../infra/sip-bridge/bridge.env && chmod 600 ../../infra/sip-bridge/bridge.env
   ```

   Fill it in exactly as on the current bridge server. While this file exists
   the bridge runs; without it, it does not.

5. **Start it:**

   ```bash
   ./deploy.sh
   ```

   It builds everything, updates the database schema, adds the booking
   overlap constraint, starts all services and checks
   `https://YOUR-DOMAIN/api/health` through Caddy. It stops with the reason
   if any step fails.

6. **The first platform operator** (on a fresh database; skip when moving
   existing data, which brings its operators with it):

   ```bash
   docker compose --env-file server.env exec api node scripts/grant-platform-admin.js someone@agency.gov.ng --apply
   ```

## Moving from Supabase and Render

Do a **rehearsal first** on the new server while the old system keeps
serving. The move only ever READS from Supabase, so a rehearsal is safe and
can be repeated.

### Rehearsal

1. Give the new server a temporary name (for example
   `new.care.example.gov.ng`) in DNS and as `DOMAIN` in `server.env`, and
   run `./deploy.sh`.
2. Fill in `migrate.env`:

   ```bash
   cp migrate.env.example migrate.env && chmod 600 migrate.env && nano migrate.env
   ```

   Use Supabase's **Session pooler** connection string (Supabase → Project
   Settings → Database → Connection string → Session pooler, port 5432).
3. See what would move, changing nothing:

   ```bash
   ./migrate-from-supabase.sh
   ```

   It prints the row counts, any difference between the live database and the
   schema this code expects, and how many files are in each storage bucket.
4. Move it:

   ```bash
   ./migrate-from-supabase.sh --apply
   ```

   This replaces the new server's database with a copy of Supabase's: it
   creates the schema from the code, copies every table's rows, **compares the
   row count of every table** and stops if any differs, copies every uploaded
   file, lists any database row whose file was missing even in Supabase, then
   runs `./deploy.sh`.
5. Sign in at the temporary address and check: contacts, cases, call history,
   a knowledge document's download, a selfie.
6. In the dashboard, open **Knowledge & FAQs** and press **Rebuild search
   index**, once for each agency.
   Qdrant starts empty on a new server; until it is reindexed, knowledge
   search still answers, by keyword matching only.

### Cut-over (pick a quiet hour; about 30 minutes)

1. **Stop the old system writing.** In Render, suspend `ace-api` (your Render
   dashboard → `ace-api` → Settings → Suspend). Calls and WhatsApp messages
   that arrive between here and step 4 are not answered, so keep this short.
2. **Final copy:** `./migrate-from-supabase.sh --apply` again, so the new
   server has everything up to the moment Render stopped.
3. **Final name.** Point the real domain's DNS at the new server, set it as
   `DOMAIN` in `server.env`, and run `./deploy.sh` (the dashboard is rebuilt
   for its address).
4. **Point the outside services at the new address:**
   - **Meta (WhatsApp):** developers.facebook.com → your app → WhatsApp →
     Configuration → Webhook → callback URL
     `https://YOUR-DOMAIN/api/whatsapp/webhook`, same verify token.
   - **ElevenLabs agent tools:** in the dashboard, the Agent Provisioning
     page → **Sync configuration**. The tools are rewritten to call the new
     address.
   - **ElevenLabs post-call webhook:** in the dashboard, Settings → Hosted
     Agent shows the "Post-call webhook URL"; paste it into your ElevenLabs
     workspace's webhook settings in place of the old one.
   - **ElevenLabs phone number:** add this server's public IP to the toll-free
     number's inbound allowed addresses.
   - **Call bridge:** on the OLD bridge server, run
     `sudo systemctl disable --now asterisk` **before** starting the new one.
     Two bridges registered as extension 1000 split the calls between them
     unpredictably. Then on this server: `./deploy.sh` (it starts the bridge
     because `bridge.env` exists).
   - **Twilio (only if used):** the dashboard's Telephone Service page →
     **Point the number at this platform**.
5. **Test:** call the toll-free number; send a WhatsApp message; sign in;
   download a knowledge document.
6. **Keep the old system for two weeks**, suspended, not deleted. To roll
   back: resume `ace-api` on Render and point the services in step 4 back.
   Anything recorded on the new server after the switch is not in Supabase,
   so roll back only if the new server cannot be fixed.
7. Afterwards, delete `migrate.env`, then rotate or revoke the Supabase
   database password and service-role key.

## Day to day

| Task | Command (in `deploy/single-server`) |
|---|---|
| Deploy an update | `git pull && ./deploy.sh` |
| What is running | `docker compose --env-file server.env ps` |
| Logs | `docker compose --env-file server.env logs -f api` (or `web`, `caddy`, `bridge`) |
| Bridge status | `docker compose --env-file server.env exec bridge /opt/bridge/check.sh` |
| Back up now | `./backup.sh` |
| Last night's backup | `systemctl status ace-backup` |
| Restore a backup | `./restore.sh backups/STAMP --replace-everything` |
| Reset an officer's password | `docker compose --env-file server.env exec api node scripts/set-user-password.js` |

**Backups** hold the database (`database.dump`) and every uploaded file
(`files.tar.gz`), each read back after it is written, with checksums. They are
kept for `BACKUP_KEEP_DAYS` on the server and copied to `BACKUP_REMOTE`, an
rclone destination configured once with `rclone config` (S3-compatible
storage, Google Drive, or another server over SFTP). Without `BACKUP_REMOTE`
every backup says, in its log, that it exists only on this server. Qdrant is
not backed up: Knowledge & FAQs → Rebuild search index rebuilds it from the
database.

**A recorded greeting before the assistant** (for example the Governor's
welcome): put an 8 kHz mono WAV in `bridge/sounds/`, for example
`governor-welcome.wav`, set `INTRO_SOUND=/opt/bridge/sounds/governor-welcome`
in `infra/sip-bridge/bridge.env`, and run `./deploy.sh`.

**A network that inspects TLS.** If the build fails with
`SELF_SIGNED_CERT_IN_CHAIN`, set `EXTRA_CA_CERT` in `server.env` to the
network's CA certificate. It is used for the build and by the running API, and
certificate checking stays on.

**The server's own voice line** (answering calls here instead of ElevenLabs)
is off until it has passed the live-call checks. How to switch it on and test
it on this setup: `PHASE3.md` in this folder.

## What has and has not been proven

Tested on a trial run of this exact setup (Docker, `trial.localhost`):
the build, `./deploy.sh` from nothing and again on top of itself, sign-in and
the dashboard in a browser through Caddy (API calls and live sockets on the
one HTTPS address), Twilio's media-stream path reaching the API, uploading and
downloading a document through a signed link, a tampered link refused, the
document worker reading the file from disk, backup → deliberate deletion →
restore, a failed off-server copy reported as a failure, and the call bridge
taking a simulated inbound call (answered, greeting played, ElevenLabs dialled,
the fallback message played when that failed). The move from Supabase was
rehearsed against a stand-in: PostgreSQL 15 with Supabase's roles, a policy, a
leftover column and table, and a stand-in storage API. Every table's rows and
every file arrived; checksums of message, case, contact, call and password
data matched; the migrated user signed in.

Not yet proven, and only provable on the real server: a real call through the
containerised bridge to ElevenLabs, a real Let's Encrypt certificate (the
trial used Caddy's own), `install.sh` on a fresh server, and the move against
the real Supabase project (run the report first).
