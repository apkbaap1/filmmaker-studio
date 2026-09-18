-- Generation becomes a durable job record.
--
-- Hand-written rather than taken from `prisma migrate dev`, because the
-- generated version adds "idempotencyKey" as TEXT NOT NULL with no database
-- default. Prisma's @default(cuid()) is applied by the client, not by Postgres,
-- so that statement fails outright on any table that already has rows. The
-- column is added nullable, backfilled, and only then constrained.

CREATE TYPE "GenerationFailureKind" AS ENUM ('RETRYABLE', 'PERMANENT', 'INDETERMINATE');

ALTER TABLE "Generation"
  ADD COLUMN "model"                 TEXT,
  ADD COLUMN "idempotencyKey"        TEXT,
  ADD COLUMN "attempts"              INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxAttempts"           INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "leaseOwner"            TEXT,
  ADD COLUMN "leaseToken"            TEXT,
  ADD COLUMN "leaseExpiresAt"        TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt"         TIMESTAMP(3),
  ADD COLUMN "lastAttemptAt"         TIMESTAMP(3),
  ADD COLUMN "submissionAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "submittedAt"           TIMESTAMP(3),
  ADD COLUMN "completedAt"           TIMESTAMP(3),
  ADD COLUMN "stagedMedia"           JSONB,
  ADD COLUMN "failureKind"           "GenerationFailureKind";

-- The id is already unique per row, so it is a sound seed for the idempotency
-- key of work that predates this column. New rows get a cuid from the client.
UPDATE "Generation" SET "idempotencyKey" = "id" WHERE "idempotencyKey" IS NULL;
ALTER TABLE "Generation" ALTER COLUMN "idempotencyKey" SET NOT NULL;

-- Timestamps for rows that already reached a terminal state, so the audit trail
-- is not retroactively blank. `updatedAt` is the closest honest approximation
-- available; nothing is invented for rows that never completed.
UPDATE "Generation" SET "completedAt" = "updatedAt" WHERE "status" = 'COMPLETED';
UPDATE "Generation" SET "submittedAt" = "updatedAt" WHERE "providerJobId" IS NOT NULL;

-- Rows left PROCESSING by the old browser-driven flow are orphans: the tab that
-- was driving them is gone and nothing will ever finish them. Those that never
-- reached a provider go back in the queue for the worker. Those that did are
-- left alone rather than resubmitted — a duplicate provider job costs real
-- money, and the worker's poll path picks them up from AWAITING_PROVIDER.
UPDATE "Generation"
   SET "status" = 'QUEUED', "nextAttemptAt" = NOW()
 WHERE "status" = 'PROCESSING' AND "providerJobId" IS NULL;

UPDATE "Generation"
   SET "status" = 'AWAITING_PROVIDER', "nextAttemptAt" = NOW()
 WHERE "status" = 'PROCESSING' AND "providerJobId" IS NOT NULL;

UPDATE "Generation" SET "nextAttemptAt" = "createdAt" WHERE "status" = 'QUEUED' AND "nextAttemptAt" IS NULL;

CREATE UNIQUE INDEX "Generation_idempotencyKey_key" ON "Generation"("idempotencyKey");
CREATE INDEX "Generation_status_nextAttemptAt_idx" ON "Generation"("status", "nextAttemptAt");
