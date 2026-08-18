-- Extend the booking overlap guarantee to bookings with NO staff assigned.
--
-- The original constraint (20260807020000) closed the read-then-write race for
-- bookings that name a staff member, and its comment records the experiment:
-- 8 simultaneous identical requests produced 8 CONFIRMED bookings in one slot.
--
-- It carried `WHERE "staffName" IS NOT NULL`, because `staffName WITH =` never
-- matches two NULLs — under `=`, NULL is not equal to NULL, so unstaffed rows
-- could not conflict with each other and had to be excluded from the predicate
-- rather than silently doing nothing.
--
-- So the race was only half closed, and the open half is the half that matters:
-- the hosted agent's book-appointment tool DOES NOT EXPOSE staffName at all
-- (see agent-tool-catalog.ts), so every booking an agent makes is unstaffed and
-- was covered by nothing. Re-running the same experiment against the tool:
--
--     with staff     -> 1 confirmed, 7 told the slot was unavailable, 1 row
--     without staff  -> 8 confirmed, 8 rows
--
-- Eight callers each told "You are booked for 9am", and the business finds out
-- in the waiting room. That is the exact failure the first migration was written
-- to prevent.
--
-- COALESCE gives every unstaffed booking the same key, so they exclude against
-- one another per organization and time range. That is already what the
-- application-level check enforces when no staff is given — it looks for ANY
-- overlapping booking in the organization — so this changes no sequential
-- behaviour. It only makes the answer survive concurrency, which is the whole
-- point of putting it in the database.
--
-- The constraint keeps its original name. `isOverlapViolation()` recognises it
-- by name as well as by SQLSTATE, and renaming it would quietly break the
-- translation of a 23P01 into an honest "that time has just been taken".

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Existing unstaffed overlaps must be resolved before the constraint can be
-- created. Same treatment as the first migration: keep the earliest booking in
-- each overlapping group, cancel the rest, and record why so the change is
-- auditable rather than silent.
WITH overlapping AS (
  SELECT b.id
  FROM bookings a
  JOIN bookings b
    ON a."organizationId" = b."organizationId"
   AND COALESCE(a."staffName", '') = COALESCE(b."staffName", '')
   AND a.id < b.id
   AND a."startTime" < b."endTime"
   AND a."endTime" > b."startTime"
  WHERE a.status IN ('CONFIRMED', 'RESCHEDULED')
    AND b.status IN ('CONFIRMED', 'RESCHEDULED')
)
UPDATE bookings
SET status = 'CANCELLED',
    notes = COALESCE(notes || E'\n', '') ||
            '[SYSTEM] Cancelled during migration: overlapped an earlier booking in the same slot.'
WHERE id IN (SELECT id FROM overlapping);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_staff_overlap;

ALTER TABLE bookings
  ADD CONSTRAINT bookings_no_staff_overlap
  EXCLUDE USING gist (
    "organizationId"            WITH =,
    (COALESCE("staffName", '')) WITH =,
    tsrange("startTime", "endTime") WITH &&
  )
  WHERE (status IN ('CONFIRMED', 'RESCHEDULED'));
