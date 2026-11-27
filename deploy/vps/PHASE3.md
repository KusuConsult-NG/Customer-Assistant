# Phase 3: proving the server's own voice line on real calls

> **On the Docker setup** (`deploy/single-server`, what the MTN Cloud server
> runs), switching on, logs and the commands in section 3 differ: see
> `deploy/single-server/PHASE3.md`. The calls to make are the same.

Phase 2 is tested against a real Asterisk with the paid providers faked
(`apps/api/test/voice-local*.spec.ts`). What only real calls can show is
listed here. **ElevenLabs stays the automatic fallback throughout**: a failure
on the local line hands the call to the ElevenLabs agent, it does not drop it.

## 1. Switch it on (and off)

On the server:

1. In `deploy/vps/deploy.env`: `LOCAL_VOICE_PIPELINE=1`, `AZURE_SPEECH_KEY`,
   `AZURE_SPEECH_REGION`, `LOCAL_VOICE_ORGANIZATION_SLUG` (the toll-free
   line's agency), then `sudo ./install.sh --skip-build`.
2. In `infra/sip-bridge/bridge.env`: `LOCAL_VOICE=1`, then
   `sudo ./setup.sh`.

**Off again in one step:** `LOCAL_VOICE=0` in bridge.env and
`sudo ./setup.sh`. Every call goes straight to ElevenLabs, exactly as before.

Each call logs one line: `journalctl -u ace-api | grep voice_local_call_ended`
gives the outcome, the length, and why if it failed over.

## 2. The calls to make

Make each from a real phone, at least twice, in a quiet room AND somewhere
noisy (a roadside, beside a generator). Note the result in the table.

| # | Call | Pass when |
|---|---|---|
| 1 | New caller, ask "what events are in December?" | Governor's greeting, then the assistant. The full answer comes in groups of three with "Shall I continue?". It speaks within ~2 s of you finishing. |
| 2 | Same number again | "Welcome back, <name>". It does not ask your name or location again. |
| 3 | Report a broken culvert, confirm the summary | It reads the summary back, files the case **after** you say yes, and reads a five-digit reference. The case is on the Cases screen with the call attached. |
| 4 | Ask for a callback | It reads the number back digit by digit, and gives a reference. The callback is on the Callbacks screen. |
| 5 | Talk over the assistant mid-sentence | It stops within about half a second and answers what you said. |
| 6 | Say nothing for 30 s | It asks whether you are still there (twice), then says goodbye. |
| 7 | Long call, 5+ minutes | No drop. This is the "2-minute drop" check. |
| 8 | Say a Plateau name and an LGA ("Bokkos", "Mangu", "Gyel B") | Heard correctly, read back correctly. |
| 9 | Hang up mid-sentence | The call log shows the call. It was not handed to ElevenLabs (outcome `caller_hung_up`). |
| 10 | Stop Deepgram (wrong key) and call | You hear the greeting, then the ElevenLabs agent takes over. The log says `fallback`. Put the key back afterwards. |
| 11 | Play a recording from the dashboard | Both sides are audible (caller left, assistant right). |
| 12 | Five calls at once | All are answered, and Asterisk audio does not stutter (`top`: asterisk stays responsive). |

Listen especially for:
- **Clarity of the Nigerian voice.** If a word is mispronounced, note it. Azure
  takes a pronunciation lexicon, and adding one is a small change.
- **Speed.** `AZURE_TTS_RATE` (default `-5%`) in deploy.env changes it without
  a rebuild (`install.sh --skip-build`).
- **How fast it answers a question.** Most of the wait is the model.
  `LOCAL_VOICE_LLM_MODEL=gpt-4o-mini` is faster and cheaper. Test it before
  keeping it: it follows the call script less reliably.

## 3. Before ElevenLabs is cancelled

Do not cancel until **all** of these are true:

- [ ] Every row above passed, on at least two days, from at least two networks
      (e.g. MTN and Airtel).
- [ ] A week of live traffic with fallbacks under 2% of calls:
      `journalctl -u ace-api --since -7d | grep -c 'outcome=fallback'` against
      `grep -c voice_local_call_ended`.
- [ ] The Governor's greeting is rendered for every assistant name and
      time of day, and stored on disk. After cancellation nothing can make a
      new one in his voice:
      ```bash
      cd /srv/ace/app
      sudo -u ace env $(sudo grep -E '^(DATABASE_URL|VOICE_CACHE_DIR|STORAGE_DIR|ENCRYPTION_KEY|ELEVENLABS_API_KEY|ELEVENLABS_ALLOW_SHARED_WORKSPACE)=' /etc/ace/ace.env | xargs) \
        node apps/api/dist/voice-local/prerender.js <agency-slug>          # report: how many are missing
      # … the same with --apply to render them (one ElevenLabs request each, ~300 for the Plateau roster)
      ```
      Re-run it after any change to the welcome message or the roster. A line
      that is missing is spoken in the assistant's voice instead, not silently.
- [ ] Callbacks dialled out by officers do not go through ElevenLabs, or
      there is a replacement. Today an outbound callback is placed by the
      ElevenLabs agent.
- [ ] The decision is recorded, with who made it.

Then set `LOCAL_VOICE=1` permanently. The bridge's ElevenLabs Dial then only
plays the "all circuits busy" message if the local line fails. Better: keep a
small ElevenLabs plan as the fallback. The difference is a caller who gets
help instead of a busy tone.
