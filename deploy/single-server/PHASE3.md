# Phase 3 on the Docker server: proving the server's own voice line

This is `deploy/vps/PHASE3.md` for the Docker setup in this folder, which is
what the MTN Cloud server runs. **The calls to make (section 2) and the
conditions before ElevenLabs is cancelled (section 3) are in that file and
are the same here**: one list, so the two cannot drift apart. What differs is
how the line is switched on and where its logs are, below.

ElevenLabs stays the automatic fallback throughout. If the server's own line
fails, the call is handed to the ElevenLabs agent, not dropped.

All commands run in `/opt/customer-assistant/deploy/single-server`.

## Before you start

- The phone bridge runs on this server (`../../infra/sip-bridge/bridge.env`
  exists) and calls already reach the ElevenLabs agent through it.
- MTN has opened SIP (TCP+UDP 5060) and the call audio (UDP 10000–20000) to
  this server. Without them no call reaches it, whatever is switched on.
- An Azure Speech resource: its key and region (Azure portal → the Speech
  resource → Keys and Endpoint).

## 1. Switch it on (and off)

1. Make the shared secret. It is shown in your terminal only. Never paste
   it into chat or a ticket:

   ```bash
   openssl rand -hex 24
   ```

2. In `server.env` (`sudo nano server.env`), in the "server's own voice
   line" section:

   ```
   LOCAL_VOICE_PIPELINE=1
   LOCAL_VOICE_SECRET=<the value>
   LOCAL_VOICE_ORGANIZATION_SLUG=<the toll-free line's agency>
   AZURE_SPEECH_KEY=<from Azure>
   AZURE_SPEECH_REGION=<e.g. westeurope>
   ```

   `DEEPGRAM_API_KEY` and `OPENAI_API_KEY` must be set too.

3. In `../../infra/sip-bridge/bridge.env` (`sudo nano ../../infra/sip-bridge/bridge.env`):

   ```
   LOCAL_VOICE=1
   LOCAL_VOICE_SECRET=<the same value>
   ```

   Leave `API_PORT` and `AUDIOSOCKET_PORT` empty: the defaults (4000, 9092)
   are the API's ports on this server's localhost.

4. Apply both. Compose re-creates the two containers because their settings
   changed. No rebuild:

   ```bash
   sudo docker compose --env-file server.env --profile bridge up -d api bridge
   ```

5. Check the API took it. It should log `voice_local_listening 0.0.0.0:9092`:

   ```bash
   sudo docker compose --env-file server.env logs --since 5m api | grep voice_local
   ```

   A missing setting does not stop the API. It shows on the first call as
   `voice_local_not_ready missing=…`, and that call goes to ElevenLabs.

**Off again in one step:** `LOCAL_VOICE=0` in `bridge.env`, then

```bash
sudo docker compose --env-file server.env --profile bridge up -d bridge
```

Every call goes straight to ElevenLabs again, exactly as before. The API side
can stay on: with the bridge not sending calls to it, it does nothing.

`AZURE_TTS_RATE` (speaking speed, default `-5%`), `AZURE_TTS_VOICE` and
`LOCAL_VOICE_LLM_MODEL` change the same way: edit `server.env`, then
`sudo docker compose --env-file server.env up -d api`.

## Logs

Each call logs one line, with the outcome, the length, and the reason if it
was handed to ElevenLabs:

```bash
sudo docker compose --env-file server.env logs api | grep voice_local_call_ended
```

What the bridge did with a call (registrations, the hand-off to the API or to
ElevenLabs):

```bash
sudo docker compose --env-file server.env logs --since 30m bridge
```

```bash
sudo docker compose --env-file server.env exec bridge /opt/bridge/check.sh
```

## 2. The calls to make

The table in `deploy/vps/PHASE3.md`, section 2. Two rows read differently here:

- **Row 10 (force a hand-off):** put a wrong `DEEPGRAM_API_KEY` in `server.env`,
  run `sudo docker compose --env-file server.env up -d api`, call, then put
  the real key back and run the same command.
- **Row 12 (five calls at once):** watch `sudo docker stats ace-bridge-1 ace-api-1`
  during the calls. The bridge has four times everyone else's CPU share, so
  it should stay responsive.

## 3. Before ElevenLabs is cancelled

The list in `deploy/vps/PHASE3.md`, section 3, with these commands in place
of the native ones:

- **Fallbacks under 2% over a week.** The API's log keeps the last 100 MB
  (five 20 MB files), which on a busy line can be less than a week, so take
  the count every day and add the days up:

  ```bash
  sudo docker compose --env-file server.env logs --since 24h api | grep -c 'outcome=fallback'
  ```

  ```bash
  sudo docker compose --env-file server.env logs --since 24h api | grep -c voice_local_call_ended
  ```

- **The Governor's greeting rendered in advance**, for every assistant name
  and time of day, while ElevenLabs is still available. This first reports
  what is missing. Add `--apply` to render it (one ElevenLabs request each,
  about 300 for the Plateau roster). The files are kept in the `files`
  volume, which is backed up nightly:

  ```bash
  sudo docker compose --env-file server.env exec api node apps/api/dist/voice-local/prerender.js <agency-slug>
  ```

  Re-run it after any change to the welcome message or the roster. A line
  that is missing is spoken in the assistant's voice instead, not silently.
