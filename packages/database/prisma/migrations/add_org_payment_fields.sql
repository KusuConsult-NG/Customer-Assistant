-- Adds per-organization payment collection details used by the AI assistant's
-- payment guidance. Idempotent — safe to run on any existing database.
-- (This repo applies schema via `npm run db:push`; this file exists for
--  deployments that apply SQL manually, matching ace_migration.sql.)

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "paymentBankName" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "paymentAccountName" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "paymentAccountNumber" TEXT;
