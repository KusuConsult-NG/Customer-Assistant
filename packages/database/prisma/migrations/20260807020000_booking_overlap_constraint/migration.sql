-- Database-level guarantee that one staff member cannot hold two bookings at once.
--
-- The application already checks for a conflict before inserting, but that is a
-- read-then-write race: under genuine concurrency every in-flight request passes the
-- check before any of them commits. Driving 8 simultaneous identical booking requests
-- produced 8 CONFIRMED bookings in the same slot — two customers would each be told
-- their appointment was confirmed, and discover the clash in the waiting room.
--
-- An exclusion constraint is the only thing that closes this, because it is enforced
-- by the database at commit time rather than by a check that raced.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Existing overlaps must be resolved before the constraint can be created.
-- Keep the earliest booking in each overlapping group and cancel the rest, recording
-- why so the data is auditable rather than silently mutated.
WITH overlapping AS (
  SELECT b.id
  FROM bookings a
  JOIN bookings b
    ON a."organizationId" = b."organizationId"
   AND a."staffName" = b."staffName"
   AND a.id < b.id
   AND a."startTime" < b."endTime"
   AND a."endTime" > b."startTime"
  WHERE a.status IN ('CONFIRMED', 'RESCHEDULED')
    AND b.status IN ('CONFIRMED', 'RESCHEDULED')
    AND a."staffName" IS NOT NULL
)
UPDATE bookings
SET status = 'CANCELLED',
    notes = COALESCE(notes || E'\n', '') ||
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
