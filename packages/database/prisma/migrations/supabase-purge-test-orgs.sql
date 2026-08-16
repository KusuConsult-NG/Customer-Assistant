-- ═══════════════════════════════════════════════════════════════════════════
-- Remove test-suite organizations by KEEPING a short list, not by matching a
-- pattern.
--
-- Why this shape. There are ~100 fixture organizations and a handful of real
-- ones, so listing every id to delete is impractical and easy to get wrong.
-- Pattern matching is worse: tested against a database with a real tenant
-- named "E2E Logistics Ltd", a `slug LIKE 'e2e-%'` delete removed it and
-- cascaded away its customers. And a name-based guess is unreliable in the
-- other direction too — "AuthOrg …", "Ọlámidé 北京 🚀 Ltd", "LockDbg" and
-- "Automated Testing Org" all read as plausible businesses and are all
-- fixtures from the auth suite.
--
-- So: you name what SURVIVES. Everything else goes. Reviewing three ids you
-- recognise is a judgement you can actually make; reviewing a hundred you
-- cannot.
--
-- Deleting an organization cascades to its users, contacts, bookings,
-- conversations, messages, tickets, workflows, API keys and call logs.
--
-- HOW TO RUN
--   1. Take a Supabase snapshot. This is not reversible after COMMIT.
--   2. Put every organization you want to keep in the INSERT below.
--   3. Run the whole block. It ends in ROLLBACK, so nothing is destroyed —
--      read the two result tables it prints.
--   4. When the survivor list is exactly right, change ROLLBACK to COMMIT
--      and run it once more.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TEMP TABLE keep (id TEXT PRIMARY KEY) ON COMMIT DROP;

-- ─── The organizations that SURVIVE. Everything not listed is deleted. ─────
INSERT INTO keep (id) VALUES
  ('c7d579918475b69f735af346')   -- Kusu Consult · created 2 Aug, 4 users, 9 contacts, 5 bookings
  -- ,('...')                    -- add another id per line if you have more real tenants
;

-- ─── Guard: an empty keep list would delete every tenant you have. ─────────
DO $$
BEGIN
  IF (SELECT count(*) FROM keep) = 0 THEN
    RAISE EXCEPTION 'Keep list is empty — refusing to delete every organization.';
  END IF;
END $$;

-- ─── Guard: every id in the keep list must actually exist. A typo would ────
-- otherwise silently drop a real tenant into the delete set.
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(k.id, ', ') INTO missing
  FROM keep k LEFT JOIN organizations o ON o.id = k.id
  WHERE o.id IS NULL;

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'These keep-list ids do not exist (typo?): %', missing;
  END IF;
END $$;

-- ─── What survives. Check this list first — it is the whole point. ─────────
SELECT 'SURVIVES' AS outcome, o.slug, o.name, o."createdAt"::date AS created,
       (SELECT count(*) FROM contacts c WHERE c."organizationId" = o.id) AS contacts
FROM organizations o
WHERE o.id IN (SELECT id FROM keep)
ORDER BY o."createdAt";

-- ─── What goes, and how much of it. ────────────────────────────────────────
SELECT 'DELETED' AS outcome,
       count(*)                                                   AS organizations,
       (SELECT count(*) FROM contacts      WHERE "organizationId" NOT IN (SELECT id FROM keep)) AS contacts,
       (SELECT count(*) FROM bookings      WHERE "organizationId" NOT IN (SELECT id FROM keep)) AS bookings,
       (SELECT count(*) FROM conversations WHERE "organizationId" NOT IN (SELECT id FROM keep)) AS conversations,
       (SELECT count(*) FROM users         WHERE "organizationId" NOT IN (SELECT id FROM keep)) AS users
FROM organizations
WHERE id NOT IN (SELECT id FROM keep);

DELETE FROM organizations WHERE id NOT IN (SELECT id FROM keep);

-- ─── The database as it will be. ───────────────────────────────────────────
SELECT 'REMAINING' AS state, slug, name FROM organizations ORDER BY "createdAt";

ROLLBACK;   -- ← change to COMMIT when the lists above are exactly right
