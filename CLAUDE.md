# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Customer Care Agent — a multi-tenant AI customer-experience platform (WhatsApp, voice telephony, web-chat widget) for Nigerian businesses and government MDAs. Internal identifiers still use the original `ace` prefix on purpose (`@ace/*` package names, the `ace_token` localStorage key, the `ace_live_pk_` widget key prefix): those are functional, not display strings, and renaming them would invalidate issued keys and stored sessions. npm-workspaces monorepo driven by Turbo: `apps/api` (NestJS 10), `apps/web` (Next.js 15 App Router), and `packages/*` (Prisma database client, conversation orchestrator, provider SDKs).

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
cd apps/api && npx jest --forceExit -t "Widget"          # single test by name

# 3. Browser e2e (Playwright; needs the FULL stack running: API on :4000, web on :3000)
cd apps/web && npx playwright test
```

Local full-stack recipe (no Docker needed if postgres/redis binaries exist):

```bash
cp .env.example .env          # every required var, with the traps annotated
npx turbo run build

# PostgreSQL 16 must run as a non-root user; Redis is optional but enables
# BullMQ ingestion, cross-pod Socket.IO, and Redis-backed rate limiting.
set -a; . ./.env; set +a
npx prisma db push --schema=packages/database/prisma/schema.prisma

# `db push` CANNOT create the booking EXCLUDE constraint (Prisma cannot express
# EXCLUDE), so apply it separately or concurrent double-booking stays possible.
psql "$DIRECT_URL" -f packages/database/prisma/migrations/20260807020000_booking_overlap_constraint/migration.sql

node apps/api/dist/main.js
cd apps/web && npx next start -p 3000

npm run db:seed:gatekipa      # optional: a demo tenant with FAQs + a widget key
npm run demo:readiness        # what actually works right now, per capability
npm run verify                # every test layer; missing prerequisites SKIP, never pass
```

Three things that cost real debugging time:

- **Startup validation rejects any value containing "placeholder"**, deliberately. Use a real-looking dummy.
- **Restart `next start` after a rebuild.** It serves the build that existed when it booted; after a rebuild it hands out chunk URLs that 404, React never hydrates, and every browser test fails with "element(s) not found" that reads exactly like a real regression. `scripts/verify-all.sh` detects this and skips rather than reporting a false failure.
- **Never point `DATABASE_URL` at production.** The harness and probes create real organizations through the real API — that is why they catch bugs mocks do not. Pointed at production once, they left 358 test organizations and ~13,900 contacts in the live CRM.

The Playwright suite registers its own org through the real API and injects the JWT into localStorage before each page load — every dashboard page is behind the layout auth guard, so tests cannot simply `goto()` a page. The app shell renders its own `<h1>Customer Care Agent</h1>`, so bare `h1` locators are strict-mode ambiguous; filter by text.

## Architecture

**Request flow**: Next.js pages call the API directly via `fetch` (`apps/web/src/lib/api.ts` builds the base URL; JWT from `localStorage.ace_token`). The NestJS API is a modular monolith — one module per domain (auth, organizations, crm, whatsapp, telephony, knowledge, scheduling, billing, widget, workflows, analytics, events).

**Database access**: a single shared `PrismaClient` exported from `@ace/database` (`import { prisma } from '@ace/database'`) — NOT injected via Nest DI. Services import it directly; so do the orchestrator and worker packages.

**Multi-tenancy** is by `organizationId` scoping on every query — there is no automatic tenant filter. Every service method takes `organizationId` from the JWT (`req.user.organizationId`) and must include it in `where` clauses. The widget resolves its tenant from an explicit `apiKey`/org-id query param; a request with no key falls back to the FIRST org in the DB (single-tenant demo convenience — production embeds must always pass the key).

**Auth**: `JwtStrategy.validate` re-checks the user in the DB on every request — deactivation and role changes take effect on the next request, not at token expiry. Do not remove this in favor of trusting token claims. JWT secrets are read from env with NO fallback anywhere (module factory throws if unset) — tests and local boots must set `JWT_SECRET`/`JWT_REFRESH_SECRET`. `tokenVersion` on User is embedded in every token and checked per request: bump it to revoke all outstanding sessions (logout/password change already do). `RolesGuard` is registered globally and reads `@Roles(...)` metadata.

**The orchestrator** (`packages/orchestrator`) is a keyword-matching intent engine, channel-agnostic, called by the WhatsApp service, widget service, and voice media-stream handler. Its contract: **tool intents never throw to the caller** — every DB-backed tool routes failures through `toolFailureReply()` (honest reply + `shouldHandoff: true`/`TOOL_FAILURE`), because an uncaught throw means the customer receives no reply at all. Unmatched input goes to RAG (Qdrant vector search with a Postgres ILIKE fallback) and then GPT-4o-mini synthesis with the org's persona prompt.

**Webhook security — verify BEFORE ACK, using the raw body**:
- `main.ts` creates the app with `rawBody: true, bodyParser: false` and registers exactly one JSON parser via `app.useBodyParser('json', ...)`. **Never add another `express.json()`** — a second parser consumes the request without the rawBody hook and silently breaks every signature check.
- Meta WhatsApp: HMAC-SHA256 of rawBody (`X-Hub-Signature-256`); invalid → 403, server misconfig → 500 (so Meta retries), then ACK 200 and process async.
- Twilio: HMAC-SHA1 over callbackUrl+sorted params. Telnyx: Ed25519 over `timestamp|rawBody` (`TELNYX_PUBLIC_KEY`), 5-min replay window. Paystack: HMAC-SHA512 of rawBody.
- For all providers: when a secret/key IS configured, a missing signature header is a rejection, never a skip.

**Voice calls** use TWO WebSocket layers that must not be confused: Twilio Media Streams speak a raw `ws` protocol handled by `TwilioMediaStreamHandler` (mounted via an HTTP `upgrade` interceptor in `main.ts` on `/telephony/stream/:callSid`), while the agent console uses Socket.IO gateways (`/events`, `/telephony` namespaces). `CallBroadcastService` bridges the two. In the media-stream handler, socket listeners are registered synchronously before any awaited DB work — Twilio sends `start` immediately on upgrade and a lost `start` leaves the call permanently mute.

**A voice handoff must move the call, not just say so**: when the orchestrator returns `shouldHandoff` on a VOICE call, `handOffCallToHuman` redirects the live call to the org's `forwardingNumber` via Twilio's REST API **before** anything is spoken, and what the caller hears is chosen from the actual outcome — Twilio's own TwiML says "connecting you" only after the redirect is accepted. With no forwarding number (or a refused redirect) the AI must NOT claim a transfer: it files a HIGH-priority ticket against the caller's number and reads back the reference. Keep the act-then-announce ordering; announcing first is how the customer ends up holding a promise nothing kept.

**Socket.IO multi-pod fan-out**: `RedisSocketIoAdapter` (an `IoAdapter` subclass) must be registered in `main.ts` **before** `app.listen()` — the adapter is applied inside `createIOServer()` when Nest bootstraps the gateways. Attaching after listen does nothing (this exact bug shipped once).

**Document ingestion**: uploads go to Supabase Storage (path, not URL, stored in `storageUrl`), then a BullMQ job on Redis; `DocumentWorkerHost` runs the worker inside the API process when `REDIS_URL` is set. Extraction is mime-typed (pdf-parse / mammoth / UTF-8) — binary types must never be decoded as UTF-8 and indexed. Without Redis, only plain-text types are inline-indexed; binary uploads are honestly marked FAILED. Deleting a document must also delete its Qdrant points, or the deleted knowledge keeps answering in RAG.

**Booking integrity** is enforced by a PostgreSQL `EXCLUDE USING gist` constraint (`bookings_no_staff_overlap`, requires `btree_gist`) that lives ONLY in `packages/database/prisma/migrations/…booking_overlap_constraint/migration.sql` — `db push` cannot create it (Prisma cannot express EXCLUDE), so any fresh database needs that SQL applied after push (CI does this). Application-level conflict checks are a UX nicety; the constraint is the guarantee.

**The workflow engine is real** (`workflow-executor/runner/actions/trigger` services): typed nodes (`kind`+`action`+config), durable `workflow_runs`/`workflow_run_steps`, BullMQ worker with an inline sweeper fallback, and domain events fired from CRM/WhatsApp/widget/scheduling/telephony via `WorkflowTriggerService.emitAsync`. Runs are claimed with a conditional `updateMany` — keep it, or the worker and sweeper double-execute every step.

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
