-- Onboarding selfie capture.

CREATE TYPE "SelfieRequestStatus" AS ENUM ('PENDING', 'RECEIVED', 'EXPIRED', 'CANCELLED');
CREATE TYPE "SelfieChannel" AS ENUM ('WHATSAPP', 'VOICE', 'WEB');

CREATE TABLE "selfie_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "SelfieChannel" NOT NULL,
    "status" "SelfieRequestStatus" NOT NULL DEFAULT 'PENDING',
    "purpose" TEXT,
    "conversationId" TEXT,
    "callSid" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "storagePath" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "receivedAt" TIMESTAMP(3),
    "receivedVia" "SelfieChannel",
    "rejectionReason" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "requestedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "selfie_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "selfie_requests_tokenHash_key" ON "selfie_requests"("tokenHash");
CREATE INDEX "selfie_requests_organizationId_createdAt_idx" ON "selfie_requests"("organizationId", "createdAt");
CREATE INDEX "selfie_requests_contactId_status_idx" ON "selfie_requests"("contactId", "status");
CREATE INDEX "selfie_requests_status_expiresAt_idx" ON "selfie_requests"("status", "expiresAt");

ALTER TABLE "selfie_requests" ADD CONSTRAINT "selfie_requests_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "selfie_requests" ADD CONSTRAINT "selfie_requests_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
