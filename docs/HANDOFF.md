# Handoff: where the work stands (23 November 2026)

For whoever continues this work, human or agent. Read `CLAUDE.md` first: it is
the project's rulebook, and its later sections describe everything below in
depth. This file is the state of play: what is live, what is waiting, and
what the owner decided.

## Ground rules the owner set

- **Do not push to production** without being told to. That means no merge to
  `main` (Render deploys from it), no Render, ElevenLabs or bridge-server
  changes, and no writes to the Supabase database.
- **Merge only when asked.** PR #127 is deliberately a DRAFT.
- **Report facts, not assumptions.** Verify before claiming. When something
  could not be proven, say so.
- Never ask for secrets in chat; never commit them; keep the owner's email private.
- Work on branch `kusu/youthful-tesla-07z35r`.

## What is LIVE in production

| What | Where | Proof |
|---|---|---|
| Booking guard covers bookings with no staff name (`COALESCE("staffName", '')`) | Supabase `bookings_no_staff_overlap`, applied 23 Nov at the owner's request; 0 bookings existed, nothing cancelled | Definition read back from production; on an identical local copy, 8 simultaneous direct inserts gave 8 confirmed (old guard) vs 1 confirmed + 7 refused (new guard) |

Production is otherwise as `main` (last merge: PR #126, 21 Nov). It runs on:
- **Render:** `ace-api`, `ace-web`.
- **Supabase:** project `xnicrtzlqgnnivdzmbvw`, PostgreSQL 17.6.
- **ElevenLabs:** agent `agent_3901m78tm8rvests15zh9z4akzef`.
- **Asterisk bridge:** on DigitalOcean (`infra/sip-bridge`), receiving calls from Alphatech on the toll-free line +2348000000456.

## Waiting in PR #127 (draft, not merged)

https://github.com/KusuConsult-NG/Customer-Assistant/pull/127. Four commits on top of `main`:

1. **Returning callers welcomed by name** (`16cdf9f`). The main reason for the PR.
   - **The problem:** on 13 of 15 live calls the model never called `lookup-customer`, so profiled callers (one had called 27 times) were greeted as strangers. The conversation-start webhook is OFF because it made the line refuse calls.
   - **The fix:** the bridge asks `POST /api/sip-bridge/caller` (`SIP_BRIDGE_SECRET`) as a call arrives and sends the answer as `X-` SIP headers. ElevenLabs exposes those as `{{sip_…}}` variables, and the stored first message ends with `{{sip_welcome}}`.
   - **Tests:** `sip-bridge-caller.spec.ts`; `sip-bridge-asterisk.spec.ts` (real Asterisk, gated by `SIP_BRIDGE_E2E=1`).
   - **NOT yet proven:** that ElevenLabs puts the header value into the first message on our number. It needs one real call. It fails safe: callers hear "How may I help you today?", as today.
   - **To go live, all owner-approved:**
     1. Merge.
     2. Set `SIP_BRIDGE_SECRET` on Render.
     3. Settings → Hosted Agent → **Sync configuration**.
     4. On the bridge: `git pull`, set `SIP_BRIDGE_SECRET` and `BRIDGE_API_URL` (the Render API URL) in `bridge.env`, then `sudo ./setup.sh`.
   - **Rollback:** empty `SIP_BRIDGE_SECRET` in `bridge.env`, re-run `setup.sh`.
2. **Phone-handoff callback reference** (`ac73b73`). Callers were read "CB-…" while officers saw "90188". Fixed; a pre-existing bug.
3. **Single-server kit for the PICTDA VPS** (`1116729`, `deploy/vps/`). Not run anywhere.
   - Rehearsed on Ubuntu 24.04 + systemd: install, re-install, migration from a stand-in Supabase, backup → damage → restore, `update.sh --local`, browser sign-in through Caddy.
   - Uses PostgreSQL **17**, not 16: production is 17.6 and data cannot move down a version.
   - `deploy/vps/README.md` is the runbook.
4. **Server's own voice line** (`a14be84`, `apps/api/src/voice-local/`). OFF unless `LOCAL_VOICE_PIPELINE=1`.
   - The path: Asterisk AudioSocket → Deepgram → GPT-4o with the same prompt and tools as the ElevenLabs agent → Azure `en-NG` voice, with an SSD speech cache. ElevenLabs is the automatic fallback.
   - Tested with providers faked and on a real Asterisk, but never on a real call. `deploy/vps/PHASE3.md` is the live-call checklist.
   - The same commit includes the storage drivers: Supabase on Render, server disk on the VPS, no silent fallback.

Last full API suite (after merging `main`, 23 Nov): 1,436 passed, 0 failed; both apps typecheck.

## Resolved: PR #127 against `main` (merge of `main` into this branch, 23 Nov)

Another session's PR #126 ("Run the whole platform on one server", merged
21 Nov, so on Render) overlapped commits `a14be84` and `1116729` here and
made this PR unmergeable. `main` was merged into this branch (no rebase, no
force-push). What was kept:

- **One storage driver: `main`'s** (`common/object-storage.ts`, live on
  Render), with this branch's three real improvements added: the
  `call-recordings` bucket for the voice line, files written 0640 (folders
  0750) whatever the umask, and every path segment checked as a plain name.
  Links are served by `main`'s `GET /api/files/:bucket/*`
  (`files/files.controller.ts`); the secret is `STORAGE_LINK_SECRET` (the
  installer generates it; unset, a key derived from `JWT_SECRET`).
- **This branch did not build anywhere but the machine that wrote it.**
  `app.module.ts` imported `./storage/storage.controller`, which was never
  committed: `.gitignore` ignores every `storage/` folder. PR #126 hit the
  same trap and moved its controller to `files/`, which this branch now uses.
- **One storage-copy script: `scripts/copy-supabase-storage.js`.** It writes
  through the API's own storage module. This branch's copy recorded each
  file's type under a different key than the server reads, so copied images
  would have downloaded as unknown files instead of displaying.
  `migrate-from-supabase.sh` runs the shared script with the app's settings.
- **One install kit: `deploy/vps`.** PR #126's Docker kit
  (`deploy/single-server`) is removed: the PICTDA server installs natively,
  and the voice line needs Asterisk and the API on the same host. Its bridge
  renderer (`infra/sip-bridge/render.sh`) went with it; `setup.sh` is this
  branch's, which knows the voice-line and caller-lookup settings.
- Two duplicates the automatic merge had kept were removed: `STORAGE_DIR`
  declared twice in `env.validation.ts`, and a second, unreachable copy of
  the local-disk health check.

Checked after the merge: API suite 1,436 passed, 0 failed (the 6 skipped are
the two real-Asterisk suites, run separately below); package suites 561 of
561; both apps typecheck; and on a real Asterisk 20.6 with the dialplan
rendered from these templates, `voice-local-asterisk.spec.ts` 3/3 and
`sip-bridge-asterisk.spec.ts` 3/3. Still never tested on a real call.

PR #127 stays a DRAFT. Merging is the owner's call.

## Open questions for the owner

- **"VoiceStudio"** (https://github.com/debpalash/VoiceStudio, identified 23 Nov): a local voice app (cloning, design, dubbing, transcription), AGPL-3.0. It is voices only, not a phone agent: its "Calls" feature dials out from the desktop app through the user's own Twilio number, has no SIP connection and none of our tools. So it could only be a `SpeechEngine` in `voice-local/tts.ts`, in place of Azure. Before that: its default model (OmniVoice) is NON-COMMERCIAL, in both forms (Apache-2.0/MIT engines exist in its catalogue); it publishes no CPU speed figures, and a phone call needs speech faster than real time; it would run on the PICTDA server. Not built; the Phase 2 plan uses Azure `en-NG`. Ask the owner whether it should replace Azure.
- **PICTDA server** (`102.88.134.211`): not reachable from the cloud sandbox. Installing needs:
  - SSH access;
  - a DNS name pointing at the server;
  - PICTDA firewall openings (TCP 22/80/443, TCP+UDP 5060, UDP 10000–20000);
  - the Render secrets copied into `deploy/vps/deploy.env`. `ENCRYPTION_KEY` must be production's own.
- **Phase 3** needs an Azure Speech key and region, entered on the server.
- **Pronunciation corrections** for the voice wait on the owner's reviewed CSV and ElevenLabs connector permission.
- The **leaked Upstash Redis password** should be rotated, and the Redis plan decided (or `REDIS_URL` removed).

## How to check the state yourself

```bash
git log --oneline origin/main..kusu/youthful-tesla-07z35r      # the four commits above
./.claude/hooks/wait-for-ready.sh && cd apps/api && npx jest --forceExit   # full suite
```

- Production database: read-only queries through the Supabase connector.
- Live agent and calls: the ElevenLabs connector (`agents_list_conversations` for the agent above). The tool names on each call show whether `lookup-customer` ran.
