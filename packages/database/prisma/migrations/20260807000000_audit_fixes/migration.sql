-- ACE Platform — schema changes from the correctness/security audit.
--
-- Safe to run against an existing database: every column is nullable or has a
-- default, and the only new constraint (conversations) is de-duplicated first.

-- ─── 1. Enum parity with packages/shared-types ──────────────────────────────
-- These values existed in the TypeScript enums and in application code but not in
-- the database, so selecting them failed at insert time.
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'MESSENGER';
ALTER TYPE "TelephonyProviderType" ADD VALUE IF NOT EXISTS 'MTN_ENTERPRISE_SIP';
ALTER TYPE "TelephonyProviderType" ADD VALUE IF NOT EXISTS 'AIRTEL_BUSINESS_SIP';

-- ─── 2. Session revocation + email verification expiry ──────────────────────
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifyExpiresAt" TIMESTAMP(3);

-- ─── 3. Per-organization payment collection details ─────────────────────────
-- Replaces the hardcoded bank account the AI assistant used to read out.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutBankName" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutAccountName" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutAccountNumber" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "payoutUssdCode" TEXT;

-- ─── 4. Conversation uniqueness ─────────────────────────────────────────────
-- The find-then-create + P2002 retry pattern in WhatsappService and WidgetService
-- assumed this constraint existed. It did not, so concurrent inbound messages could
-- split one customer's history across duplicate conversation rows.
-- Merge any existing duplicates into the oldest row before adding the constraint.
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

DELETE FROM "conversations" c
USING (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY "organizationId", "contactId", "channel" ORDER BY "createdAt"
         ) AS keep_id
  FROM "conversations"
) r
WHERE c.id = r.id AND r.id <> r.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS "conversations_organizationId_contactId_channel_key"
  ON "conversations" ("organizationId", "contactId", "channel");

-- ─── 5. Indexes ─────────────────────────────────────────────────────────────
-- Every tenant-scoped query filtered on organizationId with no index behind it.
CREATE INDEX IF NOT EXISTS "users_organizationId_idx"              ON "users" ("organizationId");
CREATE INDEX IF NOT EXISTS "users_passwordResetToken_idx"          ON "users" ("passwordResetToken");
CREATE INDEX IF NOT EXISTS "api_keys_organizationId_idx"           ON "api_keys" ("organizationId");
CREATE INDEX IF NOT EXISTS "telephony_configs_organizationId_idx"  ON "telephony_configs" ("organizationId");
CREATE INDEX IF NOT EXISTS "telephony_configs_phoneNumber_idx"     ON "telephony_configs" ("phoneNumber");
CREATE INDEX IF NOT EXISTS "whatsapp_configs_organizationId_idx"   ON "whatsapp_configs" ("organizationId");
CREATE INDEX IF NOT EXISTS "whatsapp_configs_phoneNumberId_idx"    ON "whatsapp_configs" ("phoneNumberId");
CREATE INDEX IF NOT EXISTS "contacts_organizationId_createdAt_idx" ON "contacts" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "contacts_companyId_idx"                ON "contacts" ("companyId");
CREATE INDEX IF NOT EXISTS "companies_organizationId_idx"          ON "companies" ("organizationId");
CREATE INDEX IF NOT EXISTS "leads_organizationId_createdAt_idx"    ON "leads" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "leads_contactId_idx"                   ON "leads" ("contactId");
CREATE INDEX IF NOT EXISTS "deals_organizationId_createdAt_idx"    ON "deals" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "deals_contactId_idx"                   ON "deals" ("contactId");
CREATE INDEX IF NOT EXISTS "tickets_organizationId_createdAt_idx"  ON "tickets" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "tickets_contactId_idx"                 ON "tickets" ("contactId");
CREATE INDEX IF NOT EXISTS "tickets_assignedUserId_idx"            ON "tickets" ("assignedUserId");
CREATE INDEX IF NOT EXISTS "notes_contactId_idx"                   ON "notes" ("contactId");
CREATE INDEX IF NOT EXISTS "conversations_organizationId_lastMessageAt_idx" ON "conversations" ("organizationId", "lastMessageAt");
CREATE INDEX IF NOT EXISTS "conversations_contactId_idx"           ON "conversations" ("contactId");
CREATE INDEX IF NOT EXISTS "messages_conversationId_sentAt_idx"    ON "messages" ("conversationId", "sentAt");
CREATE INDEX IF NOT EXISTS "call_logs_organizationId_startedAt_idx" ON "call_logs" ("organizationId", "startedAt");
CREATE INDEX IF NOT EXISTS "call_logs_contactId_idx"               ON "call_logs" ("contactId");
CREATE INDEX IF NOT EXISTS "knowledge_documents_organizationId_createdAt_idx" ON "knowledge_documents" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "document_chunks_documentId_chunkIndex_idx" ON "document_chunks" ("documentId", "chunkIndex");
CREATE INDEX IF NOT EXISTS "document_chunks_organizationId_idx"    ON "document_chunks" ("organizationId");
CREATE INDEX IF NOT EXISTS "bookings_organizationId_startTime_idx" ON "bookings" ("organizationId", "startTime");
CREATE INDEX IF NOT EXISTS "bookings_contactId_idx"                ON "bookings" ("contactId");
CREATE INDEX IF NOT EXISTS "bookings_status_startTime_idx"         ON "bookings" ("status", "startTime");
CREATE INDEX IF NOT EXISTS "reservations_organizationId_reservationTime_idx" ON "reservations" ("organizationId", "reservationTime");
CREATE INDEX IF NOT EXISTS "reservations_contactId_idx"            ON "reservations" ("contactId");
CREATE INDEX IF NOT EXISTS "calendar_integrations_organizationId_idx" ON "calendar_integrations" ("organizationId");
CREATE INDEX IF NOT EXISTS "faq_entries_organizationId_sortOrder_idx" ON "faq_entries" ("organizationId", "sortOrder");
CREATE INDEX IF NOT EXISTS "webhook_logs_organizationId_createdAt_idx" ON "webhook_logs" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "broadcast_campaigns_organizationId_createdAt_idx" ON "broadcast_campaigns" ("organizationId", "createdAt");
CREATE INDEX IF NOT EXISTS "workflows_organizationId_triggerType_isActive_idx" ON "workflows" ("organizationId", "triggerType", "isActive");

-- ─── 6. WhatsApp templates were auto-marked APPROVED locally ────────────────
-- Nothing was ever submitted to Meta, so broadcasts using them were rejected with
-- error 132001. Existing rows without a Meta template id are reset so operators can
-- see which ones still need submitting.
UPDATE "whatsapp_templates"
SET "status" = 'PENDING_SUBMISSION'
WHERE "status" = 'APPROVED' AND ("metaTemplateId" IS NULL OR "metaTemplateId" = '');
