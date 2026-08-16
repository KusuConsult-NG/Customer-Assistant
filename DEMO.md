# Running a demo on free services

Everything in this repo can be demoed without a paid plan. Two things make
that true:

1. **The LLM endpoint is configurable.** OpenAI has no free tier, but several
   providers serve the identical wire format on a free plan. Point
   `LLM_BASE_URL` at one and every AI feature works unchanged.
2. **Every unavailable dependency degrades honestly.** Nothing is faked. A
   missing service means a curated answer, a documented fallback, or a plain
   "let me get a human" — never an invented booking, price, or delivery
   receipt. That behavior is asserted by the test suites, not assumed.

Run `node scripts/demo-readiness.js` at any time: it contacts every configured
service and prints what the demo will actually do, per capability.

---

## The one setting that matters

| Variable | Default | What to set for a free demo |
|---|---|---|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible base URL |
| `LLM_CHAT_MODEL` | `gpt-4o-mini` | The chat model id on that provider |
| `OPENAI_API_KEY` | — | The key for whichever provider you chose |

Providers that serve the OpenAI chat-completions format on a free plan include
Groq, Google Gemini's OpenAI-compatibility endpoint, OpenRouter's free models,
and Cerebras. Check each one's current free-tier terms and model ids yourself —
they change, and this file will go stale before they do.

```bash
# Example shape — substitute your provider's real base URL and model id
LLM_BASE_URL=https://<provider>/openai/v1
LLM_CHAT_MODEL=<model-id-from-that-provider>
OPENAI_API_KEY=<your-free-tier-key>
```

**Embeddings are the exception.** Free chat endpoints are common; free
embedding endpoints are not. If your provider has no embedding model, leave
document search on the PostgreSQL keyword fallback — it needs no key and no
configuration. Only set `EMBEDDING_MODEL` if you have one, and then set
`EMBEDDING_DIMENSIONS` to that model's real vector width: it must equal the
Qdrant collection size, and a mismatch fails every search. The readiness
script checks this for you by asking the provider for a vector and comparing.

---

## What works at each level of configuration

### Nothing but PostgreSQL

The floor, and it still demos well:

- Dashboard: CRM, scheduling, workflows, billing views, team management
- Web-chat widget answering from **curated FAQ entries** (the FAQ manager in
  the dashboard) — deterministic, no model involved
- Booking, cancellation, rescheduling, ticket creation through the assistant
- Double-booking made impossible by a database constraint (worth showing:
  fire two concurrent bookings for one slot and watch one get a 409)
- Anything outside the FAQs hands off to a human, honestly

Not available: free-text AI answers, semantic document search, file uploads,
voice, WhatsApp.

### + a free LLM endpoint

- The assistant answers open questions in the organization's persona
- Post-call summaries and sentiment
- Prompt-injection resistance and the AI-disclosure rule still hold — both
  are asserted in the harness

### + Redis (free tier available from managed providers)

- Background document ingestion instead of inline text-only indexing
- Durable workflow queue rather than the inline sweeper
- Cross-pod live updates and Redis-backed rate limiting

Without Redis everything still runs on a single pod; binary uploads are marked
FAILED rather than silently half-indexed.

### + Supabase (free tier)

- Knowledge-base document upload and retrieval
- Onboarding selfie capture

Create **both** buckets manually and make them **private**:
`knowledge-documents` and `onboarding-selfies`. Without them these two
features return a 503 that names the missing configuration.

### + Twilio / Deepgram / ElevenLabs trial credit

- Inbound voice calls answered by the AI in one consistent voice

A Twilio trial can only call **verified** numbers — verify the phone you will
demo from, first. Note the known gap: on a voice call, "let me speak to a
human" is spoken but the call is not yet transferred (chat and WhatsApp hand
off correctly). Either avoid that phrase in a voice demo or say what happens.

### + Meta WhatsApp test number (free)

- The test number messages up to 5 verified recipients at no cost
- Inbound messages are answered; outbound failures surface as failures

---

## Testing everything

```bash
./scripts/verify-all.sh
```

Runs, in order: the monorepo build, all package unit suites, the API
integration suite (Jest), the 274-check HTTP validation harness, and the
Playwright browser suite. Layers whose prerequisites are missing are reported
as **SKIPPED with the reason** — never counted as passing.

Prerequisites per layer are listed at the top of the script. The fullest run
needs a live PostgreSQL, the API on `:4000`, and the web app on `:3000`.

Two things that will bite you:

- **Restart `next start` after a rebuild.** It serves the build that existed
  when it booted; after a rebuild it hands out chunk URLs that 404, React
  never hydrates, and every browser test fails with "element(s) not found"
  that looks precisely like a real regression. The script now detects this
  and skips rather than reporting a false failure.
- **The env validator rejects any value containing "placeholder"**, by
  design. Use a real-looking dummy for local runs.

### What the suites prove without any paid service

The harness asserts the degradation itself: that an unreachable model hands
the conversation to a human (`AI-010`), that a pricing question invents no
price (`AI-006`), that a prompt injection does not override the persona
(`AI-008`), and that storage-dependent checks **block** rather than pass when
storage is unconfigured. Blocked is a distinct outcome from passed in the
report, deliberately — an uncertified capability is never reported as working.

---

## Demo script that works with no paid dependency at all

1. `node scripts/demo-readiness.js` — show the audience exactly what is live
2. Dashboard tour: CRM with contacts, scheduling, the workflow builder
3. Widget on the embedding site: ask a curated question, get the exact
   operator-written answer
4. Ask something unknown: watch it decline to invent and offer a human
5. Ask to book an appointment: a real row appears in the dashboard
6. Fire two concurrent bookings for the same slot: one wins, one gets 409
7. Say "I want to speak to a human agent": the conversation flips to handoff
   and an agent replies from the console
