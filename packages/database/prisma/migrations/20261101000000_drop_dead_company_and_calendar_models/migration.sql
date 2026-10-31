-- Drop two models that no code has ever touched.
--
-- `Company` and `CalendarIntegration` were both carried in the schema with
-- zero references anywhere in the repository: no service read them, no
-- controller exposed them, no seed wrote them. `Contact.companyId` existed as
-- an optional column with its own index and nothing ever set it.
--
-- They are removed rather than kept because a model in the schema reads as a
-- feature. `CalendarIntegration` in particular held `accessToken` and
-- `refreshToken` as PLAINTEXT columns — the one place in this schema exempted
-- from the encryption-at-rest rule, exempted precisely because nothing used
-- it. A plaintext credential column that exists for no reason is a place for
-- credentials to end up later.
--
-- ── BEFORE APPLYING THIS ─────────────────────────────────────────────────────
--
-- Verify the tables are empty in the database you are about to run it on:
--
--   SELECT count(*) FROM companies;
--   SELECT count(*) FROM calendar_integrations;
--   SELECT count(*) FROM contacts WHERE "companyId" IS NOT NULL;
--
-- All three were 0 in development, which is what made this lossless there.
-- A production database that predates the repurposing could differ, and this
-- migration cannot tell the difference — it drops either way.
--
-- `db push` on a fresh database simply never creates them, so this file is
-- only for databases that already have them. Run it BEFORE the next
-- `db push`: a push against the new schema sees the tables as removable and
-- refuses without --accept-data-loss, which is a safe failure rather than a
-- silent drop, but a failure all the same.

ALTER TABLE "contacts" DROP CONSTRAINT IF EXISTS "contacts_companyId_fkey";
DROP INDEX IF EXISTS "contacts_companyId_idx";
ALTER TABLE "contacts" DROP COLUMN IF EXISTS "companyId";

DROP TABLE IF EXISTS "companies";
DROP TABLE IF EXISTS "calendar_integrations";
