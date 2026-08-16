-- ═══════════════════════════════════════════════════════════════════════════
-- Remove test-suite organizations, keeping a short list you name.
--
-- Written for the Supabase SQL editor, which AUTOCOMMITS each statement. That
-- rules out the obvious shape: a TEMP TABLE holding the keep list is dropped
-- the moment its own CREATE commits, and every later statement then fails with
-- `relation "keep" does not exist`. An explicit BEGIN/ROLLBACK is not honoured
-- there either, so a "dry run" that relies on rolling back is not a dry run.
--
-- So each step below is a single self-contained statement, the keep list is
-- repeated inline in each one, and STEP 1 is read-only. The safety checks live
-- INSIDE the DELETE in STEP 2 rather than in separate guard statements, so
-- they cannot be skipped or lost between statements.
--
-- Deleting an organization cascades to its users, contacts, bookings,
-- conversations, messages, tickets, workflows, API keys and call logs.
-- ═══════════════════════════════════════════════════════════════════════════


-- ═══ STEP 1 · Preview. Read-only. Run this first. ══════════════════════════
-- Edit the ARRAY to list every organization you want to KEEP.

WITH keep AS (
  SELECT unnest(ARRAY[
    'c7d579918475b69f735af346'    -- Kusu Consult
    -- ,'paste-another-id-here'
  ]::text[]) AS id
)
SELECT
  CASE WHEN o.id IN (SELECT id FROM keep) THEN '✅ KEEP' ELSE '🗑 DELETE' END AS action,
  count(*)                                                                    AS organizations,
  COALESCE(sum((SELECT count(*) FROM contacts      c  WHERE c."organizationId"  = o.id)), 0) AS contacts,
  COALESCE(sum((SELECT count(*) FROM bookings      b  WHERE b."organizationId"  = o.id)), 0) AS bookings,
  COALESCE(sum((SELECT count(*) FROM conversations cv WHERE cv."organizationId" = o.id)), 0) AS conversations,
  COALESCE(sum((SELECT count(*) FROM users         u  WHERE u."organizationId"  = o.id)), 0) AS users
FROM organizations o
GROUP BY 1
ORDER BY 1;


-- ═══ STEP 1b · The organizations that will SURVIVE, listed individually. ═══
-- This is the list that matters. If anything here is wrong, stop.

WITH keep AS (
  SELECT unnest(ARRAY[
    'c7d579918475b69f735af346'    -- Kusu Consult
    -- ,'paste-another-id-here'
  ]::text[]) AS id
)
SELECT
  o.id, o.slug, o.name, o."createdAt"::date AS created,
  (SELECT count(*) FROM users    u WHERE u."organizationId" = o.id) AS users,
  (SELECT count(*) FROM contacts c WHERE c."organizationId" = o.id) AS contacts,
  (SELECT count(*) FROM bookings b WHERE b."organizationId" = o.id) AS bookings
FROM organizations o
WHERE o.id IN (SELECT id FROM keep)
ORDER BY o."createdAt";


-- ═══ STEP 2 · Delete. DESTRUCTIVE, and there is no rollback here. ══════════
--
-- Take a Supabase snapshot before running this.
--
-- The two guards are part of the statement:
--   · every id in the list must exist — if one is a typo the counts will not
--     match, the condition is false for every row, and NOTHING is deleted
--     rather than a real tenant being swept in alongside the fixtures;
--   · an empty list makes array_length NULL, so the condition is NULL, and
--     again nothing is deleted rather than everything.
--
-- Use the SAME array as STEP 1. If you edited it there, edit it here too.

-- DELETE FROM organizations
-- WHERE id <> ALL (ARRAY[
--         'c7d579918475b69f735af346'    -- Kusu Consult
--         -- ,'paste-another-id-here'
--       ]::text[])
--   AND (
--         SELECT count(*) FROM organizations
--         WHERE id = ANY (ARRAY[
--           'c7d579918475b69f735af346'
--           -- ,'paste-another-id-here'
--         ]::text[])
--       ) = array_length(ARRAY[
--           'c7d579918475b69f735af346'
--           -- ,'paste-another-id-here'
--         ]::text[], 1);


-- ═══ STEP 3 · Confirm. Read-only. Run after STEP 2. ════════════════════════
-- SELECT id, slug, name, "createdAt"::date AS created
-- FROM organizations
-- ORDER BY "createdAt";
