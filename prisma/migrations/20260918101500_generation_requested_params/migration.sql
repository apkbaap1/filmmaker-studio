-- What was asked of the provider, frozen at submission time.
--
-- Nullable with no backfill: generations that predate this column were made
-- before the application recorded a requested size, and inventing one for them
-- would put a fact in the audit trail that nobody ever asserted.
ALTER TABLE "Generation" ADD COLUMN "requestedParams" JSONB;
