-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "aspectRatio" TEXT,
ADD COLUMN     "resolution" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "aspectRatio" TEXT,
ADD COLUMN     "resolution" TEXT;
