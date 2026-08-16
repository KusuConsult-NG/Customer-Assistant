-- Per-organization widget appearance.
--
-- The Widget Generator page has always shown colour and position controls, but
-- there was nowhere to store them: the widget config endpoint returned
-- hardcoded values, so an operator could set their brand colour, receive a
-- "Widget settings saved" toast, and still get the default blue bottom-right
-- widget on their site. These columns are that missing storage.
--
-- Idempotent — safe to run against a database that already has them.

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "widgetPrimaryColor" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "widgetSecondaryColor" TEXT;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "widgetPosition" TEXT DEFAULT 'bottom-right';
