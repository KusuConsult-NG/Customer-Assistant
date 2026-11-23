# Handoff: where the work stands (23 November 2026)

For whoever continues this work, human or agent. Read `CLAUDE.md` first: it is
the project's rulebook, and its later sections describe everything below in
depth. This file is the state of play: what is live, what is waiting, and
what the owner decided.

## Ground rules the owner set

- **Do not push to production** without being told to: no merge to `main`
  (Render deploys from it), and no Render, ElevenLabs, bridge-server or
  Supabase changes, unless the owner asks.
- **Merge only when asked**, and only with CI green.
- **Report facts, not assumptions.** Verify before claiming. When something
  could not be proven, say so.
- Never ask for secrets in chat; never commit them; keep the owner's email private.
- Work on a branch; no force-push.

## What is LIVE in production (Render + Supabase + DigitalOcean bridge)

`main` at PR #127 (`dc515a5`, merged 23 Nov), deployed on Render. It runs on:
- **Render:** `ace-api`, `ace-web`. Free plan: the API sleeps when idle.
- **Supabase:** project `xnicrtzlqgnnivdzmbvw`, PostgreSQL 17.6. The booking
  guard is the current one (`COALESCE("staffName", '')`), read back from production.
- **ElevenLabs:** agent `agent_3901m78tm8rvests15zh9z4akzef`.
- **Asterisk bridge:** on DigitalOcean (`infra/sip-bridge`), receiving calls
  from Alphatech on the toll-free line +2348000000456.

PR #127 brought:
1. **Returning callers welcomed by name.** The bridge asks
   `POST /api/sip-bridge/caller` (`SIP_BRIDGE_SECRET`) as a call arrives and
   sends the answer as `X-` SIP headers; ElevenLabs exposes them as
   `{{sip_…}}` variables, and the first message ends with `{{sip_welcome}}`.
   **Deployed but NOT switched on.** To switch it on (owner-approved steps):
   1. Set `SIP_BRIDGE_SECRET` on Render (and in the server's `server.env`).
   2. Settings → Hosted Agent → **Sync configuration**.
   3. On the bridge: `git pull`, set `SIP_BRIDGE_SECRET` and `BRIDGE_API_URL`
      in `bridge.env`, then `sudo ./setup.sh`.

   Not yet proven on a real call. It fails safe: callers hear "How may I help
   you today?", as before. Rollback: empty `SIP_BRIDGE_SECRET` in `bridge.env`
   and re-run `setup.sh`.
2. **Phone-handoff callback reference**: callers are read the same five
   digits officers see.
3. **The server's own voice line** (`apps/api/src/voice-local`): OFF unless
   `LOCAL_VOICE_PIPELINE=1`. Never tested on a real call
   (`deploy/vps/PHASE3.md` is the checklist).

## The MTN Cloud server (102.88.134.211): running, NOT serving citizens

- Runs the Docker kit **`deploy/single-server`** from `/opt/customer-assistant`
  (SSH user `datong`), at the latest `main`, updated with
  `git pull && sudo ./deploy.sh`. **Never delete that folder**: the server's
  next pull would remove its own compose file and Caddyfile.
- **Inbound TCP 80/443 are blocked UPSTREAM of the server.** The server's own
  `ufw` allows 22, 80, 443, UDP 443, 5060 and UDP 10000–20000, but from the
  internet port 80 times out and Let's Encrypt cannot issue a certificate.
  MTN Cloud's own firewall or security group must open them.
- Until then it is reached through a temporary Cloudflare quick tunnel
  (container `ace-tunnel`, on network `ace_default`, to Caddy's internal
  `:8080`). The quick-tunnel address changes whenever that container restarts,
  and it is not a production address.
- Checked through the tunnel after the last deploy: `/api/health/ready` 200;
  `/api/sip-bridge/caller` 403 without the secret; the dashboard JS holds no
  compiled API address; booking guard current.

### To make it production (owner decisions, in order)

1. **A permanent address.** Either MTN opens TCP 80/443 (plus UDP 443, 5060,
   UDP 10000–20000 for the phone line) and a DNS A record points at the
   server, or a NAMED Cloudflare tunnel on a domain the owner controls.
2. **Data migration** from Supabase (rehearse first; see `deploy/vps/README.md`
   "Moving production" for the order: freeze Render, copy, reindex).
3. **Repoint the outside world**: Sync configuration (agent tools), the
   ElevenLabs post-call webhook, Meta's WhatsApp callback URL, the ElevenLabs
   number's allowed inbound addresses, and Alphatech if they filter by IP.
4. `SIP_BRIDGE_SECRET` in `server.env` and `bridge.env`, then Sync configuration.

## Open questions for the owner

- **"VoiceStudio"** (https://github.com/debpalash/VoiceStudio, identified 23 Nov): a local voice app (cloning, design, dubbing, transcription), AGPL-3.0. It is voices only, not a phone agent: its "Calls" feature dials out from the desktop app through the user's own Twilio number, has no SIP connection and none of our tools. So it could only be a `SpeechEngine` in `voice-local/tts.ts`, in place of Azure. Before that: its default model (OmniVoice) is NON-COMMERCIAL, in both forms (Apache-2.0/MIT engines exist in its catalogue); it publishes no CPU speed figures, and a phone call needs speech faster than real time; it would run on the PICTDA server. Not built; the Phase 2 plan uses Azure `en-NG`. Ask the owner whether it should replace Azure.
- **Server address**: MTN to open the ports above, or a named Cloudflare tunnel (see "To make it production").
- **Housekeeping**: branch `kusu/caddy-tunnel-client-ip` is redundant and must be deleted in the GitHub UI (the session's proxy refuses branch deletion).
- **Phase 3** needs an Azure Speech key and region, entered on the server.
- **Pronunciation corrections** for the voice wait on the owner's reviewed CSV and ElevenLabs connector permission.
- The **leaked Upstash Redis password** should be rotated, and the Redis plan decided (or `REDIS_URL` removed).

## How to check the state yourself

```bash
git log --oneline -5 origin/main
./.claude/hooks/wait-for-ready.sh && cd apps/api && npx jest --forceExit   # full suite
```

- Production database: read-only queries through the Supabase connector.
- Live agent and calls: the ElevenLabs connector (`agents_list_conversations` for the agent above). The tool names on each call show whether `lookup-customer` ran.
