-- New GenerationStatus values.
--
-- Split into its own migration on purpose: PostgreSQL will not let a value added
-- by ALTER TYPE be *used* until the adding transaction has committed, so the
-- backfill in the next migration cannot live in the same file.

ALTER TYPE "GenerationStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PROVIDER';
ALTER TYPE "GenerationStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
