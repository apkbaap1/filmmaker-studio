-- Storage provider + key.
--
-- Written by hand rather than accepting Prisma's generated diff, which would
-- have dropped `filePath` and destroyed every existing asset's location. The
-- column is backfilled into `storageKey` first, so no development or test
-- media is lost; re-keying those legacy paths into the canonical shape, and
-- moving them into object storage, is the job of `npm run storage:migrate`.

CREATE TYPE "StorageProvider" AS ENUM ('LOCAL', 'S3');

ALTER TABLE "Asset"
  ADD COLUMN "checksum" TEXT,
  ADD COLUMN "storageProvider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN "storageKey" TEXT;

-- Existing rows are all local disk paths; carry them across verbatim.
UPDATE "Asset" SET "storageKey" = "filePath" WHERE "storageKey" IS NULL;

ALTER TABLE "Asset" ALTER COLUMN "storageKey" SET NOT NULL;
ALTER TABLE "Asset" DROP COLUMN "filePath";
