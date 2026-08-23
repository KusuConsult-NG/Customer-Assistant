# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Customer Care Agent — a multi-tenant AI customer-experience platform for Nigerian businesses and government MDAs. **Customers reach it on WhatsApp and by phone; the web app is the staff dashboard.** (The embedded web-chat widget was a third customer channel and has been RETIRED — see below.) Internal identifiers still use the original `ace` prefix on purpose (`@ace/*` package names, the `ace_token` localStorage key, the `ace_live_pk_` key prefix): those are functional, not display strings, and renaming them would invalidate issued keys and stored sessions. npm-workspaces monorepo driven by Turbo: `apps/api` (NestJS 10), `apps/web` (Next.js 15 App Router), and `packages/*` (Prisma database client, conversation orchestrator, provider SDKs).

## Commands

```bash
npm install                        # root install (workspaces)
npx turbo run build                # build everything (api, web, all packages)
npx turbo run build --filter=@ace/api...   # api + its package dependencies
npm run db:generate                # prisma generate (packages/database)
npm run db:push                    # prisma db push — REQUIRED after any schema.prisma change
```

`DATABASE_URL` **and** `DIRECT_URL` must both be set for any Prisma command (pooled + direct connection; point both at the same DB locally).

### Tests

There is no single test runner. Three layers, all proven to run:

```bash
# 1. Package unit suites (plain node scripts; packages must be BUILT first)
cd packages/<name> && node test/run-test.js     # orchestrator needs DATABASE_URL/DIRECT_URL

# 2. API integration tests (Jest + supertest; needs a live PostgreSQL)
cd apps/api && npx jest --forceExit
cd apps/api && npx jest --forceExit -t "retired"          # single test by name

# 3. Browser e2e (Playwright; needs the FULL stack running: API on :4000, web on :3000)
cd apps/web && npx playwright test
```

Local full-stack recipe (no Docker needed if postgres/redis binaries exist):

```bash
cp .env.example .env          # every required var, with the traps annotated
npx turbo run build

# PostgreSQL 16 must run as a non-root user; Redis is optional but enables
# BullMQ ingestion, cross-pod Socket.IO, and Redis-backed rate limiting.
#
# Do NOT export .env into your shell with `set -a; . ./.env; set +a`. That
# executes the file, so a password containing ( ) * ! or a space is a syntax
# error — all legal in a .env, and dotenv reads them fine. Prisma and the API
# both read the file themselves; `scripts/dev-setup.sh` parses it as text.
npx prisma db push --schema=packages/database/prisma/schema.prisma

# `db push` CANNOT create the booking EXCLUDE constraint (Prisma cannot express
# EXCLUDE), so apply it separately or concurrent double-booking stays possible.
# Only the EXCLUDE ones: db push already created everything the other
# migrations describe, so re-running them collides.
for m in $(grep -l 'EXCLUDE USING' packages/database/prisma/migrations/*/migration.sql | sort); do
  psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f "$m"
done

node apps/api/dist/main.js
cd apps/web && npx next start -p 3000

npm run db:seed:gatekipa      # optional: a demo tenant with FAQs
npm run demo:readiness        # what actually works right now, per capability
npm run verify                # every test layer; missing prerequisites SKIP, never pass
```

Three things that cost real debugging time:

- **Startup validation rejects any value containing "placeholder"**, deliberately. Use a real-looking dummy.
- **Restart `next start` after a rebuild.** It serves the build that existed when it booted; after a rebuild it hands out chunk URLs that 404, React never hydrates, and every browser test fails with "element(s) not found" that reads exactly like a real regression. `scripts/verify-all.sh` detects this and skips rather than reporting a false failure.
- **Never point `DATABASE_URL` at production.** The harness and probes create real organizations through the real API — that is why they catch bugs mocks do not. Pointed at production once, they left 358 test organizations and ~13,900 contacts in the live CRM.

The Playwright suite registers its own org through the real API and injects the JWT into localStorage before each page load — every dashboard page is behind the layout auth guard, so tests cannot simply `goto()` a page. The app shell renders its own `<h1>Customer Care Agent</h1>`, so bare `h1` locators are strict-mode ambiguous; filter by text.

## Architecture

**Request flow**: Next.js pages call the API directly via `fetch` (`apps/web/src/lib/api.ts` builds the base URL; JWT from `localStorage.ace_token`). The NestJS API is a modular monolith — one module per domain (auth, organizations, crm, whatsapp, telephony, knowledge, scheduling, billing, workflows, analytics, events; `widget` is a retirement stub).

**Database access**: a single shared `PrismaClient` exported from `@ace/database` (`import { prisma } from '@ace/database'`) — NOT injected via Nest DI. Services import it directly; so do the orchestrator and worker packages.

**Multi-tenancy** is by `organizationId` scoping on every query — there is no automatic tenant filter. Every service method takes `organizationId` from the JWT (`req.user.organizationId`) and must include it in `where` clauses.

**The embedded web-chat widget is RETIRED**, and the way it was retired is deliberate. Customers reach this platform on WhatsApp and by phone; a third customer-facing channel was a third place for the AI to say something wrong, with its own tenant-resolution rules and its own unauthenticated model-billing endpoint. What remains:
- `/api/widget/*` answers **410 Gone** for everything, with a body naming the replacement. Not deleted, because the embed snippet is a `<script>` tag on tenants' own sites that we cannot reach in and remove — a 404 also describes an outage, a bad URL or a broken proxy, and somebody would go hunting for a fault that is not there.
- **The `/api/widget/*` CORS carve-out (`main.ts`) must stay.** Without it a tenant's browser blocks the 410 as a cross-origin violation, and the site owner sees a CORS error instead of the message explaining what happened.
- `apps/web/public/widget.js` is still served and is **inert** — it renders nothing and logs one `console.info` saying the widget was retired. An old embed leaves the page exactly as it was before the tag was added.
- `ChannelType.WEBCHAT` and existing WEBCHAT conversations/messages are **kept**. They are the record of what the business told its customers; retiring a channel is not a reason to destroy it, and the dashboard still renders those threads.
- `Organization.widgetPrimaryColor/widgetSecondaryColor/widgetPosition` still exist but are **no longer writable** — a settings form that saves and changes nothing is worse than no form. Columns kept because dropping them needs `db push --accept-data-loss`, which does not belong in this deploy path for three dead colour fields.

All of it is safe to delete once no tenant site carries the snippet. Until then these are the things telling site owners why it stopped.

**Auth**: `JwtStrategy.validate` re-checks the user in the DB on every request — deactivation and role changes take effect on the next request, not at token expiry. Do not remove this in favor of trusting token claims. JWT secrets are read from env with NO fallback anywhere (module factory throws if unset) — tests and local boots must set `JWT_SECRET`/`JWT_REFRESH_SECRET`. `tokenVersion` on User is embedded in every token and checked per request: bump it to revoke all outstanding sessions (logout/password change already do). `RolesGuard` is registered globally and reads `@Roles(...)` metadata.

**The orchestrator** (`packages/orchestrator`) is a keyword-matching intent engine, channel-agnostic, called by the WhatsApp service and the voice media-stream handler. It is the LIVE conversation engine — see the note below on the second one. Its contract: **tool intents never throw to the caller** — every DB-backed tool routes failures through `toolFailureReply()` (honest reply + `shouldHandoff: true`/`TOOL_FAILURE`), because an uncaught throw means the customer receives no reply at all. Unmatched input goes to RAG (Qdrant vector search with a Postgres ILIKE fallback) and then GPT-4o-mini synthesis with the org's persona prompt.

**TWO conversation engines exist right now, and only one is live.** This is the single most confusing thing in the repo, so read this before changing either.

| | `packages/orchestrator` | `apps/api/src/agent-tools` |
|---|---|---|
| Status | **LIVE** — serves every channel today | Built and tested, **not yet serving anyone** |
| Who runs the conversation | We do: keyword intents → RAG → GPT-4o-mini | ElevenLabs Agents does |
| Who runs the business logic | We do | We do — same services, over HTTP |
| Channels | WhatsApp, voice | Intended: WhatsApp + voice, once cut over |

Nothing has been migrated. A customer message today goes through the orchestrator, exactly as before; the agent-tools endpoints have never been called by a real agent. Do not read the ElevenLabs work as a replacement that already happened.

The split is deliberate: the agent layer replaces the CONVERSATION (turn-taking, speech, intent routing), not the BUSINESS LOGIC. Bookings, tickets, payment details and knowledge stay in the same services both paths call. That is why `agent-tools` is a thin controller over `SchedulingService`/`CrmService`/`KnowledgeService` rather than a second implementation — a second implementation would drift, and the drift would be in what customers are told about their money.

Both paths must keep the same guarantees, and they enforce them the same way:
- a tool failure never throws to the customer (`toolFailureReply()` in the orchestrator, `failed()` in `AgentToolsService`)
- payment details come only from the org's configured `payout*` fields
- a transfer is never announced before it is known to be possible
- the AI admits to being an AI when asked

Cutting a tenant over means: `POST /api/agent-provisioning/sync` (OWNER/ADMIN), point one number at the agent it created, and compare against the orchestrator path. Delete `TwilioMediaStreamHandler` and the Deepgram wiring only after a real call proves the replacement — the voice path has never completed a real call under either engine.

**Agent provisioning is generated, never hand-maintained.** `apps/api/src/agent-tools/agent-tool-catalog.ts` is the single source for the webhook tools (`TOOL_NAMES`) and the system prompt; `ElevenLabsAgentService` pushes it and records the ids, and `scripts/generate-agent-config.js` prints the same payloads as a dry run without pushing. Four things about that path are load-bearing:

- **Tools are separate resources.** `prompt.tools` is deprecated (the SDK says so outright) — each tool is created on its own and the agent holds `prompt.toolIds`. `agentDefinition()` refuses to emit both.
- **`prompt.timezone` is required.** Unset, the agent does not know what day it is, and `book-appointment` asks it to resolve "next Tuesday" into an ISO timestamp — an invented date written into a real calendar. `agentDefinition()` throws rather than defaulting.
- **The SDK is camelCase and converts to snake_case itself.** Hand-written snake_case passed to the SDK is silently dropped, taking `dynamicVariable` — the binding that stops the model supplying the caller's phone number — with it. Never bypass the SDK for these payloads.
- **The agent key is a workspace secret, not a literal header.** Tools reference it by `secretId`; our own copy is a SHA-256 hash. Rotation (`POST /api/agent-provisioning/rotate-key`) updates the secret *before* revoking the old key, so a call in progress keeps working. `scripts/mint-agent-key.js` still exists for a hand-configured agent.

`syncAgent` is idempotent, persists each tool id as it is created (so a half-finished run is resumable rather than duplicating), and refuses outright when `API_BASE_URL` is localhost or a private range — an agent that answers calls and fails every tool call is worse than none, because it looks provisioned. `getAgentStatus` is read-only on purpose: repairing drift silently also destroys the evidence of how it happened.

**Connecting a number is not symmetrical between the two channels** (`ElevenLabsNumbersService`):

- **A Twilio number CAN be imported over the API** (`POST /api/agent-provisioning/numbers/import`), because we hold the tenant's `accountSid`/`authToken` in `TelephonyConfig` and ElevenLabs takes both. **This import IS the voice cutover** — ElevenLabs answers the number from then on, not `TwilioMediaStreamHandler` — so `confirmVoiceCutover: true` is required and never defaulted, and `numbers/release` exists so the decision is reversible (releasing still leaves re-pointing the Twilio voice webhook to the operator). `enableSms` defaults to **false**, against the upstream default: this platform consumes no inbound SMS, so taking that route would change a tenant's Twilio config for nothing.
- **A WhatsApp account CANNOT.** The SDK has get/list/update/delete and no create — the line is connected through the ElevenLabs dashboard via Meta's embedded signup, which needs a human. `whatsapp/attach` only assigns our agent to an already-connected line and records its id; it refuses a line whose Meta token has expired (assigning it would report success and then answer nothing).

**The live console feed is a POLLER, and there is no alternative.** ElevenLabs pushes nothing mid-conversation — every webhook event type they define (`transcript`, `audio`, `call_initiation_failure`, and the unredacted variants) fires *after* the call ends; `getSignedUrl`/`getWebrtcToken` are for a client joining as the user, not for observing. So `ElevenLabsLiveService` polls `conversations.list({agentId})` + `conversations.get(id)` every 4s and fans out over the existing `/events` Socket.IO room. Three consequences worth keeping:
- **Snapshots, not deltas.** Every emit carries the full transcript plus a turn count. With a polling source, a multi-pod fan-out and consoles that connect mid-call, a duplicate or out-of-order delta garbles the transcript while a duplicate snapshot is a visual no-op.
- **Polling is watcher-gated.** `AgentConsoleGateway` calls `watch()`/`unwatch()` on connect/disconnect; a tenant with nobody at the console generates zero provider traffic. Only decrement for a socket that actually registered — an unauthenticated socket never called `watch()`, and decrementing for it stops polling for real viewers.
- **One tenant's failure is contained.** A poll round logs and continues; an expired key for one tenant must not blank every other console. The list is scoped to the tenant's own `agentId` because the workspace may hold everyone else's conversations.

`GET /api/agent-provisioning/live` returns the same snapshot over REST so a freshly loaded console is not blank for a poll interval.

**In the console, live calls are a SEPARATE list from stored conversations** (`apps/web/src/app/agent-console/page.tsx`). A live conversation has no row in our database, cannot be replied to, and disappears when the call ends; a stored one does none of those. Merged into one list the only thing telling them apart would be a badge, and an operator would eventually type into a call that can never receive it — so selecting one clears the other, the live pane has **no input element at all** (not a disabled one), and it shows `freshness(polledAt)` rather than an unqualified "Live". Taking over needs C3; until that exists an input would be a control that silently does nothing. The agent-console socket effect must NOT depend on the selected conversation id — it used to, so every click tore the socket down and rebuilt it, which now also churns the server-side watcher count that decides whether ElevenLabs is polled at all.

**Human takeover: ElevenLabs offers NO way to stop a conversation in progress.** Their entire mutating surface is `update` on agents, tools, secrets, phone numbers and WhatsApp accounts — configuration, never a live call — and `conversations.messages` is search-only. So "tell the agent to stop responding" cannot be asked of ElevenLabs at all. `ElevenLabsTakeoverService` works around it at the carrier instead, and the two channels genuinely differ:
- **Voice is takeable.** ElevenLabs answers the Twilio number with the tenant's own credentials, so the call is a Twilio call and can be redirected out from under it — via the same `VoiceAiService.transferCallToHuman` the orchestrator path uses (`TelephonyModule` exports it for exactly this; a second "move the call" implementation is a second thing that can silently stop moving it). **Act, then announce**: the outcome is reported from what Twilio actually did, never from the intention.
- **WhatsApp is not.** The only lever is `enableMessaging` on the whole line, which silences the agent for every customer on that number. That is an outage, not a handoff, so takeover refuses it and explains why; the line-wide pause lives separately at `POST /api/agent-provisioning/whatsapp/pause` behind `confirmAffectsEveryConversation`. The console shows no transfer button for a WhatsApp thread at all.

`callSid` is deliberately not defended against being absent — all three phone-call variants in the SDK declare it required and the SDK validates responses, so a payload without one is rejected in the client first. A test pins that assumption rather than a branch pretending to handle it.

**One phone number, one contact** (`packages/database/src/phone-number.ts`). The same customer arrives as `+2348012345678` (Twilio), `2348012345678` (Meta) and `08012345678` (a staff member typing), and `Contact` is unique on `[organizationId, phoneNumber]` with exact-match lookups — so they were three different people, and a booking made over WhatsApp was invisible to the same person calling in.
- **Writes store the canonical form** (E.164 with the plus) via `normalizePhoneNumber()`.
- **Reads match every shape** via `phoneNumberVariants()` — `phoneNumber: { in: … }`. Rows written before this existed are still in their channel's format, so canonical-only lookups would leave every existing customer as unfindable as before.
- **A number the rules do not recognise is returned UNCHANGED.** Guessing at an unfamiliar shape turns one findable contact into an unfindable one, which is worse than the duplicate. The local-form rule (`0…` → `+234…`) assumes Nigeria and takes the country code as a parameter.
- The unique constraint now bites correctly: a second row for the same number is a P2002 rather than a differently-formatted string slipping through.

Existing duplicates are collapsed by `npm run contacts:dedupe` (report-only; `-- --apply` merges). Oldest row survives, a real name beats a generated placeholder, and every relation moves — conversations included, where a channel collision moves the MESSAGES into the survivor's thread rather than losing them to the `[organizationId, contactId, channel]` constraint. Deliberately a separate step: merging customer records destroys one of them, and nothing that destructive should happen as a side effect of somebody answering a phone.

**What is FREE is one search, shared** (`packages/database/src/availability.ts`). Both engines offer appointment times, and two implementations of "what is free" drift into a double booking that both paths believed was legitimate. The module imports no Prisma client on purpose — the caller passes a `BusyLoader` — because a top-level import would make the shared definition untestable in the orchestrator suites, which replace `prisma`. Business hours (Mon–Fri 08:00–18:00 WAT) are platform-wide for now; a wrong constant is at least wrong in one place. `BUSY_BOOKING_STATUSES` is shared too, so the two loaders cannot disagree about what occupies a slot.

The agent gained `check-availability` for this. Without it the agent asked the caller to name a time, tried to write it, and learned the answer from an exclusion violation — a guess-and-retry loop on a live call, while the orchestrator offered real openings on WhatsApp. The guardrail block in `agentPromptFor` instructs the agent to call it before proposing any time; that block is appended AFTER the tenant persona so a stored persona cannot override it, and `scripts/sync-payload/apply-prompt-update.js` verifies a payload carries BOTH the current `SYSTEM_PROMPT` and the current guardrails before pushing — they are separate strings, so checking only the first would let a lost guardrail through.

**Every customer-facing write goes through a FLOW** (`packages/orchestrator/src/flows.ts` and the five `*-flow.ts` files). Booking, rescheduling, cancelling, reserving and PLASCHEMA enrollment each used to be a single message in and a write out. None of them is now: each offers real options or collects real answers, and writes only what the customer chose. `FlowDefinition.summarise` is optional and the exception is narrow — booking and reserving omit the read-back because the last answer IS the decision; anything that CHANGES or DESTROYS an existing record keeps it. State lives on `Conversation.flowState`, and a flow with no thread to hang state on hands over rather than falling through to the next matching branch (VOICE has no `Conversation` row: the media-stream handler passes the callSid as the conversation id).

**Credentials at rest** — EVERY provider credential is AES-256-GCM encrypted, stored as `v1.<iv>.<tag>.<ciphertext>` with a fresh IV per write. The crypto lives in `@ace/database` (`secret-box.ts` + `credentials.ts`) rather than in the API, because the columns live there and the orchestrator package reads some of them too — a helper only the API could import would leave that path decrypting nothing.

Covered: `HostedAgentConfig.apiKey`, `TelephonyConfig.authToken/apiKey/apiSecret`, `WhatsAppConfig.accessToken/webhookVerifyToken`. NOT covered, deliberately: `accountSid`, `phoneNumberId`, `whatsappBusinessId` — those identify accounts rather than open them, and reading them in a database console is worth more than hiding them. `CalendarIntegration.accessToken/refreshToken` are plaintext but no code in the repo touches that model at all.

**Every read must go through `withTelephonyCredentials()` / `withWhatsAppCredentials()`, every write through `sealTelephonyCredentials()` / `sealWhatsAppCredentials()`.** A missed read does not fail loudly — it hands a `v1.…` ciphertext to Twilio or Meta, which rejects it as a bad credential, and the tenant's phone line or WhatsApp stops working with an auth error pointing at the wrong system entirely. Three rules:
- **With `ENCRYPTION_KEY` unset, writing throws** rather than falling back to plaintext with a warning — that is how a system reports encryption at rest while having none. CI sets a throwaway key for this reason.
- **A key that is not 32 bytes is rejected, not stretched.** Hashing a short passphrase into key-shaped bytes makes a weak secret look strong in every log and review.
- **Legacy plaintext still reads**, warning on every read and naming the row, so turning encryption on breaks no live phone line. `npm run secrets:encrypt` reports across all three models; `-- --apply` rewrites, and also re-encrypts anything readable only by `ENCRYPTION_KEY_PREVIOUS` (which is what makes rotation possible without every credential going dark at once). A value neither key can read is reported and **left alone**.

Masking a credential for the dashboard decrypts first (`maskStoredSecret`): masking the stored value would show the last four characters of base64 ciphertext, which changes every write and matches nothing an operator can compare against their Meta or Twilio console. The settings write paths return a masked view rather than the stored row — before encryption they echoed the tenant's own access token straight back in the response body.

**The ElevenLabs workspace has no tenancy boundary of its own**, so each tenant gets its own (`elevenlabs-workspace.ts`). Everything inside a workspace — agents, numbers, WhatsApp lines, every transcript — belongs to whoever holds the key, so a tenant with no `HostedAgentConfig.apiKey` is **refused**, not quietly dropped into the shared `ELEVENLABS_API_KEY` workspace. `ELEVENLABS_ALLOW_SHARED_WORKSPACE=1` re-enables the fallback for deployments that genuinely serve one tenant; it is deliberately not inferred from `NODE_ENV`. The in-code filtering (every listing scoped to the caller's own agent, cross-agent WhatsApp attach refused) stays as defence in depth — it is a check that has to be re-applied correctly at every listing endpoint anyone ever adds, which is why it is not the boundary.

A dedicated workspace needs **both halves**, set via `POST /api/agent-provisioning/credentials` (`{apiKey?, webhookSecret?}`): the key to act in it, and its own webhook signing secret to verify what it sends back. Setting only the key leaves a tenant whose calls work and whose transcripts are all rejected, so `GET credentials` reports `mode`, `webhookUrl` and a `warnings[]` naming exactly that gap.

**Webhook security — verify BEFORE ACK, using the raw body**:
- `main.ts` creates the app with `rawBody: true, bodyParser: false` and registers exactly one JSON parser via `app.useBodyParser('json', ...)`. **Never add another `express.json()`** — a second parser consumes the request without the rawBody hook and silently breaks every signature check.
- Meta WhatsApp: HMAC-SHA256 of rawBody (`X-Hub-Signature-256`); invalid → 403, server misconfig → 500 (so Meta retries), then ACK 200 and process async.
- Twilio: HMAC-SHA1 over callbackUrl+sorted params. Telnyx: Ed25519 over `timestamp|rawBody` (`TELNYX_PUBLIC_KEY`), 5-min replay window. Paystack: HMAC-SHA512 of rawBody.
- ElevenLabs post-call: HMAC-SHA256 of `<timestamp>.<rawBody>`, header `t=…,v0=…`. Verified in `elevenlabs-signature.ts` rather than via the SDK's `constructEvent`, because that helper compares with `!==` (timing oracle) and bounds only the past, so a far-future timestamp stays replayable forever — ours uses `timingSafeEqual` and bounds both directions. **The header name is the one unverified thing**: `ElevenLabs-Signature` is documented but was never confirmed against a live delivery, so it is overridable via `ELEVENLABS_SIGNATURE_HEADER` and a delivery arriving without it logs the header names it did carry.
- **Two ElevenLabs webhook routes, one per workspace kind.** `POST /api/webhooks/elevenlabs` verifies with `ELEVENLABS_WEBHOOK_SECRET` (the shared workspace); `POST /api/webhooks/elevenlabs/:organizationId` verifies with that tenant's own stored secret and has **no env fallback** — falling back would check a tenant's transcripts against the shared workspace's secret. The org is in the path because the signature must be checked before the body is parsed, so the payload cannot be what says whose secret to use.
- **A valid signature says who SENT a delivery, never whose conversation it is.** `ElevenLabsWebhookService.ingest` takes the verified organization and refuses to attribute across it: a tenant-path delivery naming another org's agent, or a shared-secret delivery naming an agent whose org has its own workspace. Both return 200 (the sender is genuine, nothing to retry) and write nothing — refusing to attribute is not the same as rejecting.
- For all providers: when a secret/key IS configured, a missing signature header is a rejection, never a skip.

**Post-call ingestion** (`ElevenLabsWebhookService`) is how a finished ElevenLabs conversation becomes a `CallLog` or a `Conversation`+`Message` thread — tool calls show what was *done*, only this shows what was *said*. Three properties:
- **Attribution is by `agent_id` alone**, resolved against `HostedAgentConfig`. Unknown agent → dropped; two organizations claiming one agent → dropped and logged at error level. Never "the first organization" — that files a stranger's transcript and the caller's number into someone's CRM. (Enforced in code, not by a unique index: adding one to an existing table makes `db push` demand `--accept-data-loss`, and carrying that flag would silence the warning for every future schema change.)
- **Redelivery is idempotent by construction** — calls upsert on `CallLog.callSid`, and each transcript turn is inserted with a deterministic `Message.externalId` (`<conversation_id>:<index>`).
- **A conversation with no phone number and no WhatsApp id is not stored.** There is nobody to attach it to, and a placeholder contact invents a customer.

Contacts are matched across phone formats — see the phone-number note below.

**Voice calls** use TWO WebSocket layers that must not be confused: Twilio Media Streams speak a raw `ws` protocol handled by `TwilioMediaStreamHandler` (mounted via an HTTP `upgrade` interceptor in `main.ts` on `/telephony/stream/:callSid`), while the agent console uses Socket.IO gateways (`/events`, `/telephony` namespaces). `CallBroadcastService` bridges the two. In the media-stream handler, socket listeners are registered synchronously before any awaited DB work — Twilio sends `start` immediately on upgrade and a lost `start` leaves the call permanently mute.

**A voice handoff must move the call, not just say so**: when the orchestrator returns `shouldHandoff` on a VOICE call, `handOffCallToHuman` redirects the live call to the org's `forwardingNumber` via Twilio's REST API **before** anything is spoken, and what the caller hears is chosen from the actual outcome — Twilio's own TwiML says "connecting you" only after the redirect is accepted. With no forwarding number (or a refused redirect) the AI must NOT claim a transfer: it files a HIGH-priority ticket against the caller's number and reads back the reference. Keep the act-then-announce ordering; announcing first is how the customer ends up holding a promise nothing kept.

**Socket.IO multi-pod fan-out**: `RedisSocketIoAdapter` (an `IoAdapter` subclass) must be registered in `main.ts` **before** `app.listen()` — the adapter is applied inside `createIOServer()` when Nest bootstraps the gateways. Attaching after listen does nothing (this exact bug shipped once).

**Document ingestion**: uploads go to Supabase Storage (path, not URL, stored in `storageUrl`), then a BullMQ job on Redis; `DocumentWorkerHost` runs the worker inside the API process when `REDIS_URL` is set. Extraction is mime-typed (pdf-parse / mammoth / UTF-8) — binary types must never be decoded as UTF-8 and indexed. Without Redis, only plain-text types are inline-indexed; binary uploads are honestly marked FAILED. Deleting a document must also delete its Qdrant points, or the deleted knowledge keeps answering in RAG.

**Booking integrity** is enforced by a PostgreSQL `EXCLUDE USING gist` constraint (`bookings_no_staff_overlap`, requires `btree_gist`) that lives ONLY in `packages/database/prisma/migrations/*/migration.sql` — `db push` cannot create it (Prisma cannot express EXCLUDE), so a fresh database needs every file **containing `EXCLUDE USING`** applied after push, in order (CI selects them by content, not by name, so a new one cannot be forgotten). The other files in that directory are hand-written schema changes for databases that predate them — `db push` already creates all of that, and re-running them on a fresh database collides. Application-level conflict checks are a UX nicety and a read-then-write race; the constraint is the guarantee.

It keys on `COALESCE("staffName", '')`, so bookings with NO staff assigned exclude against each other too. The original predicate was `staffName IS NOT NULL` — `=` never matches two NULLs, so unstaffed rows could not conflict and had to be left out — and the agent's `book-appointment` tool does not expose `staffName` at all, so **every booking a hosted agent makes was covered by nothing**. Eight simultaneous requests produced eight CONFIRMED bookings in one slot, each caller told their appointment was made. Adding a staff parameter would not have fixed it; only the database can settle a race.

**The workflow engine is real** (`workflow-executor/runner/actions/trigger` services): typed nodes (`kind`+`action`+config), durable `workflow_runs`/`workflow_run_steps`, BullMQ worker with an inline sweeper fallback, and domain events fired from CRM/WhatsApp/scheduling/telephony via `WorkflowTriggerService.emitAsync`. Runs are claimed with a conditional `updateMany` — keep it, or the worker and sweeper double-execute every step.

**Onboarding selfies** (`apps/api/src/onboarding/`): one-time upload tokens stored only as SHA-256 hashes, magic-byte image validation (SVG refused), 5-minute signed URLs, private `onboarding-selfies` bucket. This is capture, NOT verification — `verifiedAt` is never set without a real biometric provider.

**Supabase Storage requires BOTH `Authorization` and `apikey` headers** (`apps/api/src/common/object-storage.ts`) — with only the bearer token every upload fails with a misleading 400/403. Both buckets (`knowledge-documents`, `onboarding-selfies`) must be created manually as PRIVATE. Runtime `DATABASE_URL` must use the Supabase pooler in transaction mode (port 6543, `pgbouncer=true`); `DIRECT_URL` stays on 5432 for migrations.

**Appointment reminders** (`appointment-reminder.service.ts`) use an atomic claim-before-send: one raw `UPDATE ... WHERE notes NOT LIKE '%[MARKER]%'` appends the marker, and only the caller whose update count is 1 sends. This is what makes concurrent pods safe — keep claim-then-send ordering.

## Non-negotiable invariants (each reverses a shipped bug)

1. **Never fabricate success or data shown to humans**: no invented bank accounts/USSD codes, no fake call records when a provider API fails (throw with the reason), no placeholder quotes/prices, no "PAID" status on unpaid bookings, no links to endpoints that don't exist. Degrade honestly and hand off to a human.
2. The AI must identify as an AI when asked (regulatory + Meta policy). Do not restore any "I'm a human" persona reply.
3. Payment details shown to customers come ONLY from the org's configured `payoutBankName/payoutAccountName/payoutAccountNumber/payoutUssdCode` fields; unset → defer to a human.
4. Env naming drift: telephony historically read `API_URL` while the rest reads `API_BASE_URL`; code now falls back between them — preserve the fallback if touching those paths.
5. Conversation lists must return the LAST N messages (query desc, reverse for display), never the first N.

## Deploy notes

Deployment configs: `render.yaml`, `Dockerfile.api`, `Dockerfile.web`, `kubernetes/deployment.yaml`. After any `schema.prisma` change, `npm run db:push` must run against the production DB **before** the new code deploys — Prisma selects all mapped columns, so new columns missing in the DB break unrelated queries. Startup env validation (`env.validation.ts`) hard-fails the boot on missing required vars and warns on optional ones; add new env vars there.
