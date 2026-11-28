# Phone Line Sign-Off — Plateau State Citizen Contact Centre (toll-free local voice line)

This is the sheet that signs the local voice line off for production. It has three parts:

1. **Proven by automated tests.** These checks run in CI on every change. Nothing to do but confirm CI is green.
2. **Proven on the live server.** The owner runs each step and records the result.
3. **Owner decisions and accounts.** These cannot be done in code.

A part-2 step passes only when its **pass mark** is met. That means the stated log lines, or the stated result in the dashboard. Record failures as they happened. Nothing on this sheet may be marked done from memory or on someone's say-so.

---

## 1. Proven by automated tests (CI `build-and-test`)

| Area | What is proven | Where |
|---|---|---|
| Hearing the caller | Caller audio reaches recognition through a real Asterisk. Recognition timing (`endpoint_ms`, `ended_by`, `silence_heard_ms`) is logged. The fallback timer is 1.0 s. | `voice-local-asterisk.spec.ts`, `voice-local-stt.spec.ts` |
| Interruption | One word ("Wait", "Stop", "No", "Excuse me") stops the agent, while "okay" or "yes" from a listener does not. Through real Asterisk, speech stops within 100 ms. | `voice-local-conversation-flow.spec.ts`, `voice-local-asterisk.spec.ts` |
| Speaking | No pause after titles ("Dr.", "Rt. Hon."). Playback starts once 1 s of audio is ready. The script's fixed sentences are pre-recorded. Pronunciations (Platoe, Gyell, Plas-cheh-ma) apply to replies only. | `voice-local.spec.ts`, `voice-local-conversation-flow.spec.ts` |
| Numbers and spelling | A number read out in groups is one answer: the line waits 2 s after the last group. A whole 11-digit number is taken at once. | `voice-local-guards.spec.ts` |
| Read-backs | A callback is not booked, and a hidden-number caller's number is not saved, until the agent has read the number back and the caller did not say "no". | `voice-local-guards.spec.ts` |
| Reports | `create-ticket` is refused after a "No". A summary must be read back and confirmed first. | `voice-local-conversation-flow.spec.ts` |
| Knowledge answers | Lists are given three at a time. "Not found" means saying so and offering a callback. | `voice-local-guards.spec.ts` |
| Profile | The LGA is saved when named. A location read-back names the community, ward and LGA. | `voice-local-guards.spec.ts`, `voice-local-conversation-flow.spec.ts` |
| Cost | One model request instead of two when a reply both speaks and saves. The script carries only what this kind of caller needs. | `voice-local-guards.spec.ts` |
| Female assistant only | With `LOCAL_VOICE_ASSISTANT_GENDER=female`, the name, the Governor's introduction and the voice are all female. | `voice-local.spec.ts`, `voice-local-tts.spec.ts` |
| Fallback | A failed local leg is handed to the ElevenLabs Dial by the dialplan. | `voice-local-asterisk.spec.ts` |

The real-Asterisk suite runs only with `ASTERISK_E2E=1`, in the engineering sandbox. It is not part of CI. Each PR states its result.

---

## 2. Proven on the live server (run from `/opt/customer-assistant/deploy/single-server`)

### 2.1 The deployment is the reviewed code
- `git log --oneline -1` in `/opt/customer-assistant` shows the merge commit of the last approved PR.
- `sudo docker compose --env-file server.env exec api printenv LOCAL_VOICE_LLM_MODEL LOCAL_VOICE_ASSISTANT_GENDER` shows the agreed model and `female`.

### 2.2 The model passes the conversation check (one run per scenario keeps the cost down)
```bash
sudo docker compose --env-file server.env exec api sh -c 'node apps/api/dist/voice-local/conversation-check.js "$LOCAL_VOICE_ORGANIZATION_SLUG" 1'
```
**Pass mark:** every scenario passes. The output must contain no "THE CALL FAILED" line. Any failure is recorded with its line, and is either fixed or explicitly accepted by the owner before sign-off.

### 2.3 Pre-recorded lines are on disk
```bash
sudo docker compose --env-file server.env exec api sh -c 'node apps/api/dist/voice-local/prerender.js "$LOCAL_VOICE_ORGANIZATION_SLUG" --apply'
```
**Pass mark:** the output shows `0 failed` for the assistant voice and for the Governor lines.

### 2.4 Pronunciations heard and approved
```bash
sudo docker compose --env-file server.env exec api sh -c 'node apps/api/dist/voice-local/pronunciation-review.js "$LOCAL_VOICE_ORGANIZATION_SLUG"'
```
**Pass mark:** the owner has listened to every word and given a verdict for each: fine, a chosen take, or wrong. The chosen spellings are in `pronounce.ts`, or in `LOCAL_VOICE_PRONOUNCE`, with who confirmed them and when.

### 2.5 Scripted test calls (toll-free line, real phone)

Make each call, then read the log for it:
```bash
sudo docker compose --env-file server.env logs api --since 15m | grep -E "voice_local_(turn|barge_in|call_ended|spelling_patience|readback_required|lga_saved|second_trip_skipped|playback_underrun|failed_over)"
```

| # | Call | Pass mark |
|---|---|---|
| C1 | **New caller, full complaint.** Give your name, LGA, ward and community, and agree to use this number. Report a broken borehole, answer the questions, then confirm the summary. | The agent reads your name back. It reads the location back with community, ward and LGA. It reads the summary back before registering, and gives you a reference number. The dashboard shows the ticket with that reference and your profile saved. `call_ended outcome=completed`. |
| C2 | **Returning caller corrects location.** Call again and give a different ward. | The whole new location is read back before it is saved. The dashboard shows the new location. |
| C3 | **Office holder.** Ask "Who is the Commissioner for Health?" | The full name with its title, and no pause between "Dr." and the name. |
| C4 | **A list.** Ask "What events are on in December?" | The agent says how many there are, gives three, and asks whether to continue. |
| C5 | **No answer, then a callback.** Ask something it cannot know, then accept the callback offer. | The agent says plainly that it doesn't know, and offers a callback. It reads the number back before booking. The log shows `readback_required` if it tried to book early. A callback reference is given, and the callback appears in the dashboard. |
| C6 | **Read out a number in groups** ("0803 … 123 … 4567") when asked for one. | The number is taken as one answer: `voice_local_spelling_patience` in the log. |
| C7 | **Interrupt.** Say "Wait" while the agent is talking. | It stops at once. The log shows `voice_local_barge_in` with `was_playing:true`. |
| C8 | **Another language.** Speak Hausa. | It answers kindly in English only. |
| C9 | **Silence.** Say nothing after the greeting. | It asks whether you are there, and later ends the call politely. |
| C10 | **Ten minutes of normal use.** | No `playback_underrun` and no `failed_over`. |

**Timing pass mark, across C1–C10:** for each `voice_local_turn`, the silence the caller hears is about `endpoint_ms + first_audio_ms`. That should be **3 s or less on most turns**. Turns that search knowledge or register a report may take longer. Record the median and the worst turn.

### 2.6 Recording and transcript
**Pass mark:** for C1, the dashboard plays the call recording, and the transcript matches what was said.

---

## 3. Owner decisions and accounts

| Item | Why | Done when |
|---|---|---|
| **OpenAI account: limits and budget** | Each reply sends about 10,000–12,000 tokens. A new account was capped at 10,000 tokens a minute, and calls failed over (HTTP 429). | Settings → Limits shows enough tokens per minute for the expected number of simultaneous calls (about 75,000 per busy call). Auto-recharge or budget alerts are set. |
| **Model choice** | gpt-4o costs about 2× gpt-4.1 per call and about 8× gpt-4.1-mini (from published prices; check the pricing page). | The cheapest model that passes 2.2 is set in `server.env` as `LOCAL_VOICE_LLM_MODEL`. |
| Everything in `USER_ACTIONS_REQUIRED.md` | Backups, Spitch tier, carrier escalation, DPO sign-off. | As listed there. |

---

## Sign-off

| Part | Result | Recorded by | Date |
|---|---|---|---|
| 1. CI green on the deployed commit | | | |
| 2.1–2.6 on the live server | | | |
| 3. Owner decisions | | | |

Signed off for production by: ______________________  Date: __________
