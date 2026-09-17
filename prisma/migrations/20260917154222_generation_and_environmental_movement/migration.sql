-- CreateEnum
CREATE TYPE "GenerationStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "GenerationMode" AS ENUM ('IMAGE');

-- CreateEnum
CREATE TYPE "GenerationSource" AS ENUM ('QUICK', 'STRUCTURED');

-- AlterTable
ALTER TABLE "ShotListItem" ADD COLUMN     "environmentalMovement" TEXT;

-- CreateTable
CREATE TABLE "Generation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sceneId" TEXT,
    "shotId" TEXT,
    "mode" "GenerationMode" NOT NULL DEFAULT 'IMAGE',
    "source" "GenerationSource" NOT NULL,
    "status" "GenerationStatus" NOT NULL DEFAULT 'QUEUED',
    "promptUsed" TEXT NOT NULL,
    "promptEdited" BOOLEAN NOT NULL DEFAULT false,
    "specSnapshot" JSONB,
    "providerId" TEXT NOT NULL,
    "promptProviderId" TEXT,
    "error" TEXT,
    "assetId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Generation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Generation_assetId_key" ON "Generation"("assetId");

-- CreateIndex
CREATE INDEX "Generation_projectId_idx" ON "Generation"("projectId");

-- CreateIndex
CREATE INDEX "Generation_shotId_idx" ON "Generation"("shotId");

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "ShotListItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
