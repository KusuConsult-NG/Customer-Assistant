-- ═══════════════════════════════════════════════════════════════════════════
-- Find test-suite data left in a real database — and remove it safely.
--
-- The validation harness and the channel probes create real organizations
-- through the real API. That is the point of them, and it is why they catch
-- bugs mocks do not. But whatever they created stays behind, and if they were
-- ever run against a live database that data sits in the CRM, the dashboard
-- counts and the analytics alongside real customers.
--
-- PART 1 only SELECTs. PART 2 deletes, and deliberately CANNOT be run without
-- you first pasting in specific ids.
--
-- Why not just delete everything matching 'e2e-%'? Because it is not safe.
-- Tested against a database holding a real tenant called "E2E Logistics Ltd"
-- (slug e2e-logistics-real-business), a pattern delete removed it along with
-- its customers and bookings. A fixture slug and a real one are not reliably
-- distinguishable by shape, so nothing here deletes by pattern. Part 1 shows
-- you candidates; you decide which are fixtures; Part 2 removes only the ids
-- you name.
-- ═══════════════════════════════════════════════════════════════════════════


-- ─── PART 1 · Inspect. Reads only, safe to run any time. ───────────────────

-- 1a. Organizations that LOOK like fixtures, with what each one holds.
--     Read the name and date columns and decide for yourself. A fixture is
--     typically minutes old, named for a test suite, and has no real contacts.
SELECT
  o.id,
  o.slug,
  o.name,
  o."createdAt"                                                           AS created,
  (SELECT count(*) FROM users u          WHERE u."organizationId" = o.id) AS users,
  (SELECT count(*) FROM contacts c       WHERE c."organizationId" = o.id) AS contacts,
  (SELECT count(*) FROM bookings b       WHERE b."organizationId" = o.id) AS bookings,
  (SELECT count(*) FROM conversations cv WHERE cv."organizationId" = o.id) AS conversations,
  (SELECT count(*) FROM tickets t        WHERE t."organizationId" = o.id) AS tickets
FROM organizations o
WHERE o.slug LIKE 'e2e-%'
   OR o.slug LIKE 'wa-probe-%'
   OR o.slug LIKE 'voice-probe-%'
   OR o.name LIKE 'E2E %'
   OR o.name LIKE 'WA Probe %'
   OR o.name LIKE 'Voice Probe %'
ORDER BY o."createdAt" DESC;

-- 1b. Every organization in the database, so you can see the candidates above
--     in context and spot any real tenant that resembles a fixture.
SELECT id, slug, name, "createdAt"::date AS created
FROM organizations
ORDER BY "createdAt";

-- 1c. The "Dr Race" bookings the migration cancelled.
--     These come from the concurrency regression test: it fires 8 identical
--     booking requests at once to prove the double-booking constraint holds.
--     Every run leaves the 7 losers behind, so a multiple of 7 is expected and
--     none of them are real appointments. This shows which organization they
--     belong to — if that is a fixture org, they are noise, nothing more.
SELECT
  o.slug        AS organization_slug,
  o.name        AS organization_name,
  b.status,
  count(*)      AS bookings
FROM bookings b
JOIN organizations o ON o.id = b."organizationId"
WHERE b."staffName" = 'Dr Race'
GROUP BY 1, 2, 3
ORDER BY bookings DESC;


-- ═══════════════════════════════════════════════════════════════════════════
-- ─── PART 2 · Remove. DESTRUCTIVE. ────────────────────────────────────────
--
-- Deleting an organization cascades to its users, contacts, bookings,
-- conversations, messages, tickets, workflows and API keys. Right for a
-- fixture, catastrophic for a real tenant.
--
-- To use it:
--   1. Run Part 1 and read the results.
--   2. Take a Supabase snapshot.
--   3. Paste the ids you are certain are fixtures into the list below.
--   4. Run the block. It rolls back by default — read the output, then swap
--      ROLLBACK for COMMIT and run it again to make it permanent.
--
-- The empty list is deliberate: with no ids, this deletes nothing.
-- ═══════════════════════════════════════════════════════════════════════════

-- BEGIN;
--
-- WITH doomed AS (
--   SELECT unnest(ARRAY[
--     -- paste ids from Part 1 here, one per line, quoted and comma-separated:
--     -- 'a1b2c3d4-0000-0000-0000-000000000000',
--     -- 'e5f6a7b8-0000-0000-0000-000000000000'
--   ]::text[]) AS id
-- )
-- SELECT o.slug, o.name, o."createdAt"
-- FROM organizations o JOIN doomed d ON d.id = o.id;   -- what you are about to delete
--
-- DELETE FROM organizations
-- WHERE id IN (SELECT id FROM (
--   SELECT unnest(ARRAY[
--     -- the SAME ids again
--   ]::text[]) AS id
-- ) x);
--
-- SELECT slug, name FROM organizations ORDER BY "createdAt";  -- what survives
--
-- ROLLBACK;   -- swap for COMMIT once the output above looks right
