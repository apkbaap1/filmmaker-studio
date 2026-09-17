-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "GenerationMode" ADD VALUE 'VIDEO';
ALTER TYPE "GenerationMode" ADD VALUE 'IMAGE_TO_VIDEO';

-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "durationSeconds" DOUBLE PRECISION,
ADD COLUMN     "providerJobId" TEXT,
ADD COLUMN     "sourceAssetId" TEXT;

-- AlterTable
ALTER TABLE "ShotListItem" ADD COLUMN     "wardrobe" TEXT;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
