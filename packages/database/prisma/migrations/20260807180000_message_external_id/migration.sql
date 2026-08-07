-- Idempotency for inbound provider messages (Meta wamid and equivalents).
--
-- Meta delivers webhooks at least once. Without this constraint a retry created a
-- duplicate customer message and triggered a second AI reply.

ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "externalId" TEXT;

-- Back-fill from the metadata blob where the id was already being recorded, so
-- existing conversations gain protection too. Deduplicated: where a redelivery has
-- already produced copies, only the earliest keeps the id.
WITH ranked AS (
  SELECT id,
         "metadata"->>'messageId' AS ext,
         ROW_NUMBER() OVER (PARTITION BY "metadata"->>'messageId' ORDER BY "sentAt" ASC, id ASC) AS rn
  FROM "messages"
  WHERE "metadata" ? 'messageId' AND "metadata"->>'messageId' IS NOT NULL
)
UPDATE "messages" m
SET "externalId" = r.ext
FROM ranked r
WHERE m.id = r.id AND r.rn = 1;

CREATE UNIQUE INDEX IF NOT EXISTS "messages_externalId_key" ON "messages"("externalId");
