-- ═══════════════════════════════════════════════════════════════════════════
-- ACE Platform — bring a production database up to the current schema.
--
-- Paste this whole file into the Supabase SQL editor and Run. It applies every
-- schema change from the audit-fix, workflow-engine, selfie-capture and
-- widget-appearance work in one pass.
--
-- SAFE TO RE-RUN. Every statement is guarded, so running it twice (or running
-- it when some changes are already present) is a no-op rather than an error.
-- Verified by executing it twice in a row against a real PostgreSQL 16.
--
-- RUN THIS BEFORE DEPLOYING THE NEW CODE. Prisma selects every mapped column,
-- so a column the code expects and the database lacks breaks unrelated queries.
--
-- Two statements below CHANGE DATA rather than just structure. Both are called
-- out where they appear, and both are no-ops on a healthy database:
--   · duplicate conversations are merged (§2)
--   · bookings that already overlap for the same staff member are cancelled,
--     because the new constraint cannot be created while they exist (§6)
-- Take a snapshot first if you want to be able to inspect the before-state.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── 1. Enum values ────────────────────────────────────────────────────────
ALTER TYPE "ChannelType"           ADD VALUE IF NOT EXISTS 'MESSENGER';
ALTER TYPE "TelephonyProviderType" ADD VALUE IF NOT EXISTS 'MTN_ENTERPRISE_SIP';
ALTER TYPE "TelephonyProviderType" ADD VALUE IF NOT EXISTS 'AIRTEL_BUSINESS_SIP';


-- ─── 2. Users: token revocation, email verification, login lockout ─────────
-- tokenVersion is embedded in every JWT and re-checked per request: bumping it
-- revokes all of a user's outstanding sessions.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion"         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifyExpiresAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failedLoginAttempts"  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockedUntil"          TIMESTAMP(3);


-- ─── 3. Organizations: payout details and widget appearance ────────────────
-- payout* are the ONLY source for payment instructions the AI reads to a
-- customer. Unset means the assistant defers to a human rather than inventing
-- an account number.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutBankName"       TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutAccountName"    TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutAccountNumber"  TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutUssdCode"       TEXT;

-- Widget appearance. Previously the config endpoint returned hardcoded values,
-- so an operator could set a brand colour, be told it saved, and see the
-- default blue widget on their site forever.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "widgetPrimaryColor"   TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "widgetSecondaryColor" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "widgetPosition"       TEXT DEFAULT 'bottom-right';


-- ─── 4. Conversations: one per (organization, contact, channel) ────────────
-- ⚠ CHANGES DATA. A customer who messaged twice could end up with several
-- conversation rows, so the assistant answered without the earlier history.
-- Messages are moved onto the earliest conversation and the extras removed.
-- No-op when no duplicates exist.
WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY "organizationId", "contactId", "channel" ORDER BY "createdAt"
         ) AS keep_id
  FROM "conversations"
)
UPDATE "messages" m
SET "conversationId" = r.keep_id
FROM ranked r
WHERE m."conversationId" = r.id AND r.id <> r.keep_id;

WITH ranked AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY "organizationId", "contactId", "channel" ORDER BY "createdAt"
         ) AS keep_id
  FROM "conversations"
)
DELETE FROM "conversations" c
USING ranked r
WHERE c.id = r.id AND r.id <> r.keep_id;

-- Prisma's own name for this @@unique. Using any other name would create a
-- SECOND, redundant unique index on a database that already has Prisma's.
CREATE UNIQUE INDEX IF NOT EXISTS "conversations_organizationId_contactId_channel_key"
  ON "conversations" ("organizationId", "contactId", "channel");


-- ─── 5. Messages: provider idempotency ─────────────────────────────────────
-- Meta delivers webhooks AT LEAST once. Without this, a retry created a
-- duplicate customer message and triggered a second AI reply to the customer.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "externalId" TEXT;

-- Back-fill from the metadata blob where the id was already recorded. Where a
-- redelivery already produced copies, only the earliest keeps the id, so the
-- unique index below can be created.
WITH ranked AS (
  SELECT id,
         "metadata"->>'messageId' AS ext,
         ROW_NUMBER() OVER (
           PARTITION BY "metadata"->>'messageId' ORDER BY "sentAt" ASC, id ASC
         ) AS rn
  FROM "messages"
  WHERE "metadata" ? 'messageId' AND "metadata"->>'messageId' IS NOT NULL
)
UPDATE "messages" m
SET "externalId" = r.ext
FROM ranked r
WHERE m.id = r.id AND r.rn = 1 AND m."externalId" IS DISTINCT FROM r.ext;

CREATE UNIQUE INDEX IF NOT EXISTS "messages_externalId_key" ON "messages" ("externalId");


-- ─── 6. Bookings: double-booking made impossible ───────────────────────────
-- ⚠ CHANGES DATA. The application's conflict check is a read-then-write race:
-- eight simultaneous requests all passed it and produced eight confirmed
-- bookings in one slot. Only a database constraint actually prevents this.
--
-- The constraint cannot be created while overlapping rows exist, so any that
-- are already there are cancelled first, with the reason written into notes.
-- Review them afterwards:
--   SELECT id, "staffName", "startTime", notes FROM bookings
--   WHERE notes LIKE '%[SYSTEM] Cancelled during migration%';
CREATE EXTENSION IF NOT EXISTS btree_gist;

WITH overlapping AS (
  SELECT b.id
  FROM bookings a
  JOIN bookings b
    ON a."organizationId" = b."organizationId"
   AND a."staffName"      = b."staffName"
   AND a.id < b.id
   AND a."startTime" < b."endTime"
   AND a."endTime"   > b."startTime"
  WHERE a.status IN ('CONFIRMED', 'RESCHEDULED')
    AND b.status IN ('CONFIRMED', 'RESCHEDULED')
    AND a."staffName" IS NOT NULL
)
UPDATE bookings
SET status = 'CANCELLED',
    notes  = COALESCE(notes || E'\n', '') ||
             '[SYSTEM] Cancelled during migration: overlapped an earlier booking for the same staff member.'
WHERE id IN (SELECT id FROM overlapping);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_staff_overlap;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_staff_overlap
  EXCLUDE USING gist (
    "organizationId" WITH =,
    "staffName"      WITH =,
    tsrange("startTime", "endTime") WITH &&
  )
  WHERE (status IN ('CONFIRMED', 'RESCHEDULED') AND "staffName" IS NOT NULL);


-- ─── 7. Workflow engine: durable runs ──────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "WorkflowRunStatus" AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED','DEAD_LETTER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WorkflowStepStatus" AS ENUM ('SUCCEEDED','FAILED','SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id"             TEXT PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "workflowId"     TEXT NOT NULL,
  "triggerType"    TEXT NOT NULL,
  "status"         "WorkflowRunStatus" NOT NULL DEFAULT 'QUEUED',
  "payload"        JSONB NOT NULL,
  "attempt"        INTEGER NOT NULL DEFAULT 0,
  "error"          TEXT,
  "ranInline"      BOOLEAN NOT NULL DEFAULT false,
  "queuedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt"      TIMESTAMP(3),
  "finishedAt"     TIMESTAMP(3),
  CONSTRAINT "workflow_runs_workflowId_fkey"
    FOREIGN KEY ("workflowId") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "workflow_runs_organizationId_queuedAt_idx" ON "workflow_runs" ("organizationId", "queuedAt");
CREATE INDEX IF NOT EXISTS "workflow_runs_workflowId_queuedAt_idx"     ON "workflow_runs" ("workflowId", "queuedAt");
CREATE INDEX IF NOT EXISTS "workflow_runs_status_idx"                  ON "workflow_runs" ("status");

CREATE TABLE IF NOT EXISTS "workflow_run_steps" (
  "id"         TEXT PRIMARY KEY,
  "runId"      TEXT NOT NULL,
  "nodeId"     TEXT NOT NULL,
  -- ACTION type, CONDITION, or DELAY.
  "kind"       TEXT NOT NULL,
  "action"     TEXT,
  "status"     "WorkflowStepStatus" NOT NULL,
  -- Resolved configuration actually used, and what the action returned.
  "input"      JSONB,
  "output"     JSONB,
  "error"      TEXT,
  "startedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "workflow_run_steps_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "workflow_run_steps_runId_startedAt_idx" ON "workflow_run_steps" ("runId", "startedAt");


-- ─── 8. Onboarding selfie capture ──────────────────────────────────────────
-- Upload tokens are stored ONLY as SHA-256 hashes, so a link cannot be
-- recovered from the database by anyone, including an operator.
-- This is capture, NOT verification: verifiedAt is never set without a real
-- biometric provider behind it.
DO $$ BEGIN
  CREATE TYPE "SelfieRequestStatus" AS ENUM ('PENDING', 'RECEIVED', 'EXPIRED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "SelfieChannel" AS ENUM ('WHATSAPP', 'VOICE', 'WEB');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "selfie_requests" (
  "id"                TEXT NOT NULL,
  "organizationId"    TEXT NOT NULL,
  "contactId"         TEXT NOT NULL,
  "channel"           "SelfieChannel" NOT NULL,
  "status"            "SelfieRequestStatus" NOT NULL DEFAULT 'PENDING',
  "purpose"           TEXT,
  "conversationId"    TEXT,
  "callSid"           TEXT,
  "tokenHash"         TEXT NOT NULL,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "storagePath"       TEXT,
  "mimeType"          TEXT,
  "sizeBytes"         INTEGER,
  "receivedAt"        TIMESTAMP(3),
  "receivedVia"       "SelfieChannel",
  "rejectionReason"   TEXT,
  "verifiedAt"        TIMESTAMP(3),
  "requestedByUserId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "selfie_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "selfie_requests_tokenHash_key"              ON "selfie_requests" ("tokenHash");
CREATE INDEX        IF NOT EXISTS "selfie_requests_organizationId_createdAt_idx" ON "selfie_requests" ("organizationId", "createdAt");
CREATE INDEX        IF NOT EXISTS "selfie_requests_contactId_status_idx"         ON "selfie_requests" ("contactId", "status");
CREATE INDEX        IF NOT EXISTS "selfie_requests_status_expiresAt_idx"         ON "selfie_requests" ("status", "expiresAt");

DO $$ BEGIN
  ALTER TABLE "selfie_requests" ADD CONSTRAINT "selfie_requests_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "selfie_requests" ADD CONSTRAINT "selfie_requests_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Verification — run this after the script and check the results.
-- ═══════════════════════════════════════════════════════════════════════════
SELECT 'organizations.widget* columns' AS check,
       count(*)::text || ' of 3' AS result
FROM information_schema.columns
WHERE table_name = 'organizations'
  AND column_name IN ('widgetPrimaryColor','widgetSecondaryColor','widgetPosition')
UNION ALL
SELECT 'organizations.payout* columns',
       count(*)::text || ' of 4'
FROM information_schema.columns
WHERE table_name = 'organizations'
  AND column_name IN ('payoutBankName','payoutAccountName','payoutAccountNumber','payoutUssdCode')
UNION ALL
SELECT 'users lockout + tokenVersion',
       count(*)::text || ' of 4'
FROM information_schema.columns
WHERE table_name = 'users'
  AND column_name IN ('tokenVersion','emailVerifyExpiresAt','failedLoginAttempts','lockedUntil')
UNION ALL
SELECT 'messages.externalId',
       count(*)::text || ' of 1'
FROM information_schema.columns
WHERE table_name = 'messages' AND column_name = 'externalId'
UNION ALL
SELECT 'new tables',
       count(*)::text || ' of 3'
FROM information_schema.tables
WHERE table_name IN ('workflow_runs','workflow_run_steps','selfie_requests')
UNION ALL
SELECT 'double-booking constraint',
       CASE WHEN count(*) = 1 THEN 'present' ELSE 'MISSING' END
FROM pg_constraint WHERE conname = 'bookings_no_staff_overlap'
UNION ALL
SELECT 'bookings cancelled by this script (review these)',
       count(*)::text
FROM bookings WHERE notes LIKE '%[SYSTEM] Cancelled during migration%';


-- ═══════════════════════════════════════════════════════════════════════════
-- Optional cleanup — the three payment* columns added by hand in an earlier
-- session. Nothing reads them since the schema standardised on payout*, so
-- they are harmless; drop them only if you want the table tidy.
--
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "paymentBankName";
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "paymentAccountName";
--   ALTER TABLE "organizations" DROP COLUMN IF EXISTS "paymentAccountNumber";
-- ═══════════════════════════════════════════════════════════════════════════
