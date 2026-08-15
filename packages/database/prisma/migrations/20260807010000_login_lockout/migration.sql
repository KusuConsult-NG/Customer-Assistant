-- Per-account brute-force lockout.
-- A per-IP rate limit cannot stop distributed credential stuffing against a single
-- account, and it locks out legitimate users who share a NAT address.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "lockedUntil" TIMESTAMP(3);
