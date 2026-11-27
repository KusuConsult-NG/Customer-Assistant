# Failover Test Report — Plateau State Citizen Contact Centre

**Report Date:** 2026-11-27  
**Engineering Principle:** Distinguish honestly between **new-call failover** and **mid-call zero-drop recovery**, and report only directly verified behaviour.

---

## 1. Two Distinct Failover Challenges

| Failover Mode | What It Means | Current Architecture Behaviour | Verified? |
| :--- | :--- | :--- | :--- |
| **Mode A: New-Call Failover** | When the local pipeline or Spitch is down/unhealthy, new incoming calls route straight to ElevenLabs before AudioSocket connects | **Implemented:** `LocalVoiceService.register()` checks readiness and `spitchCircuitState().open`. If Spitch has failed 3 consecutive times, `register()` returns `fallback spitch-circuit-open` in 0 ms and Asterisk sends the call straight to ElevenLabs. | **Unit-tested** (`voice-local-tts.spec.ts`); live staging failover drill pending standby VPS |
| **Mode B: Mid-Call Failover (Active Call Recovery)** | If Spitch/Deepgram/OpenAI fails **after** a citizen is already speaking on AudioSocket | **Partial (Not Zero-Drop Context Transfer):** `VoiceSession` terminates the AudioSocket leg with `KIND.HANGUP` and records `outcome = fallback`. Asterisk queries `/api/voice-local/outcome/<uuid>` and transfers the live SIP channel to ElevenLabs **without dropping the carrier call**, **but** ElevenLabs starts a fresh agent turn (it does **not** inherit mid-sentence conversation history from the aborted local session). | **Code-verified** (`local-voice.service.ts` + Asterisk dialplan); live end-to-end call drill pending staging |

---

## 2. Automated Failover Verification Executed on Stabilisation Branch

| Test Case | Suite | Result |
| :--- | :--- | :--- |
| Spitch circuit breaker opens after 3 consecutive HTTP 500/503 failures and fails fast without issuing further `fetch` calls | `apps/api/test/voice-local-tts.spec.ts` | **PASS** |
| Spitch concurrency semaphore queues excess parallel synthesis requests and retries on HTTP 429 | `apps/api/test/voice-local-tts.spec.ts` | **PASS** |
| Deepgram STT wiring and error propagation | `apps/api/test/deepgram-wiring.spec.ts` | **PASS** |
| ElevenLabs fallback contract & voice settings validation | `apps/api/test/elevenlabs-contracts.spec.ts` | **PASS** |

---

## 3. Confirmed Failover Capacity Risks (Unresolved — User Action Required)

1. **ElevenLabs Concurrency Cap (`10` calls on Creator Plan):**
   - If Spitch experiences an outage while **25–30 citizens** are calling simultaneously, the first **10** failover calls will connect to ElevenLabs, and calls **11–30** will be rejected by ElevenLabs concurrency limits.
   - **Resolution:** Either upgrade ElevenLabs to `Scale` (`$299/mo`, 30 concurrent calls) or explicitly accept degraded failover capacity (10 concurrent backup calls) as a documented policy decision.
2. **ElevenLabs Credit Balance (`64,002` credits remaining at audit):**
   - If credits hit zero during a primary outage, failover fails silently or plays an error. Automated balance monitoring is required.
3. **Single-VPS Host Failure:**
   - Because Asterisk (`ace-bridge-1`) runs on the same MTN VPS as `ace-api-1`, a full MTN VPS outage disconnects **both** primary and ElevenLabs failover (since AlphaTech SIP terminates on `102.88.134.211`). Full host-level resilience requires Standby MTN VPS #2 + AlphaTech secondary SIP failover route.

---

## 4. Planned Staging Failover Drills (To Execute Once Staging VPS Exists)

1. **Spitch Blackhole Drill:** Block outbound traffic to Spitch API on staging → verify 3 failures open circuit → verify call #4 routes to ElevenLabs in `<200 ms`.
2. **Deepgram Outage Drill:** Invalidate `DEEPGRAM_API_KEY` on staging → verify `readiness()` returns `fallback not-ready` and calls route to ElevenLabs.
3. **API Container Kill Drill:** Stop `ace-api-1` while Asterisk is up → verify Asterisk `CURL` timeout triggers dialplan fallback to ElevenLabs.
4. **PostgreSQL / Qdrant Restart Drill:** Restart `ace-qdrant-1` → verify `healthcheck` gates recovery and API degrades gracefully to callback capture without crashing.
