# Voice Pipeline Architecture — Plateau State Citizen Contact Centre

## 1. End-to-End Call Flow

```
Caller (+2348000000456)
   │ SIP/RTP (G.711 µ-law / a-law)
   ▼
AlphaTech PBX / SIP Trunk
   │ UDP SIP + RTP
   ▼
Asterisk 20.6 (`ace-bridge-1`)
   ├── 1. Concurrency Gate: GROUP_COUNT(inbound) > 30 → Play busy message & hangup
   ├── 2. Adaptive Jitter Buffer: JITTERBUFFER(adaptive)=300,60,40
   ├── 3. POST /api/voice-local/register (with LOCAL_VOICE_SECRET)
   │       ├── Returns `fallback <reason>` (e.g. `disabled`, `not-ready`, `spitch-circuit-open`, `busy`)
   │       │     └── Asterisk routes call immediately (0 ms audio loss) → ElevenLabs SIP/WS Backup
   │       └── Returns `ok <uuid>`
   │             └── Asterisk opens AudioSocket(uuid, 127.0.0.1:9092)
   ▼
NestJS Local Voice Engine (`ace-api-1`)
   ├── Persona Selection: 50/50 random from 100 male (`jude`) / 100 female (`lucy`) Plateau personas
   ├── Opening Clips (0 ms API latency, pre-rendered on `/data/files/tts-cache`):
   │     1. Time-of-day Governor greeting (`SPITCH_GOVERNOR_VOICE`)
   │     2. NDPA privacy & recording disclosure (`jude` or `lucy`)
   ├── Live Turn Loop:
   │     • Inbound 8 kHz PCM (µ-law decoded) → Deepgram Nova-3 WebSocket (STT)
   │     • Transcript + Knowledge Retrieval (`search_knowledge` via Qdrant) → OpenAI `gpt-4o-mini` (streaming SSE)
   │     • Spoken sentences → Spitch TTS (punctuation-stripped, semaphore-gated, circuit-breaker-protected)
   │     • 24 kHz WAV → Anti-aliased FIR resampler (24 kHz → 8 kHz, <-60 dB stopband) → steady 20 ms AudioSocket frames
   ├── Post-Call: Recording saved to `/data/files`, transcript & ticket persisted to PostgreSQL 17
   └── 4. On AudioSocket close: Asterisk GETs `/api/voice-local/outcome/<uuid>`
           ├── `fallback` (unrecoverable session failure) → Asterisk transfers to ElevenLabs Backup
           └── `completed` / `caller-hung-up` → Hangup
```

---

## 2. Key Audio & Conversational Quality Controls

| Control | Implementation | Purpose |
| :--- | :--- | :--- |
| **Hard 30-Call Ceiling** | Asterisk `GROUP_COUNT(inbound) > 30` + `LocalVoiceService` `maxConnections = 30` | Prevents CPU/RAM/network collapse under call spikes |
| **Adaptive Jitter Buffer** | `JITTERBUFFER(adaptive)=300,60,40` on AudioSocket leg | Absorbs carrier jitter without excessive latency |
| **Anti-Aliased Resampler** | Windowed-sinc FIR 24 kHz → 8 kHz (`pcm.ts`) | Preserves 2–3.4 kHz consonant clarity (`<0.5 dB` ripple) and suppresses >4.5 kHz aliasing (`<-60 dB`) |
| **Spitch Punctuation Sanitiser** | Strips `,` and sentence-final `.`/`:` in `SpitchTts.synthesize()` | Prevents Spitch from speaking `"comma"` or `"full stop"` aloud |
| **Zero Synthetic Fillers** | `LOCAL_VOICE_ACK_AFTER_MS=0` + no lookup-bridge prompt rules | Eliminates repetitive `"One second, please"` / `"Let me check"` chatter |
| **PII Cache Guard** | `isCacheable()` in `tts.ts` | Guarantees citizen names, phone numbers, and reference IDs are never written to shared `tts-cache` |
| **Spitch Concurrency & Circuit Breaker** | Semaphore (`max 2` on Tier 1) + 429 retry + Circuit Breaker (opens at 3 consecutive failures for 30 s) | Prevents cascading 429 storms and triggers 0 ms failover to ElevenLabs |

---

## 3. Asterisk Lifecycle Evaluation (20.6 → 22 LTS)

- **Current Version:** Asterisk `20.6` (installed from Ubuntu 24.04 apt repository inside `ace-bridge-1`).
- **Lifecycle Status:** Asterisk 20 LTS exited full bug-fix support on **October 19, 2026** and is in **security-fix-only** maintenance through **October 19, 2027**.
- **Recommendation:** Do **not** upgrade Asterisk blindly on the live server. Once the isolated Staging MTN VPS is provisioned, build and soak-test `ace-bridge` on **Asterisk 22 LTS** (security support through **October 2029**), verifying:
  1. `res_pjsip` AlphaTech registration and NAT keepalive.
  2. `app_audiosocket` explicit `KIND.HANGUP` frame handling (previously verified on 20.6).
  3. `JITTERBUFFER(adaptive)` and `GROUP_COUNT(inbound)` dialplan behaviour.
  4. 30-call SIPp load test stability.
