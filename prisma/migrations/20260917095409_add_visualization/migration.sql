-- CreateEnum
CREATE TYPE "AssetType" AS ENUM ('IMAGE', 'VIDEO', 'DIAGRAM');

-- CreateEnum
CREATE TYPE "AssetSource" AS ENUM ('UPLOADED', 'GENERATED');

-- CreateEnum
CREATE TYPE "CameraAngle" AS ENUM ('EYE_LEVEL', 'LOW_ANGLE', 'HIGH_ANGLE', 'DUTCH_ANGLE', 'BIRDS_EYE', 'WORMS_EYE', 'OVER_THE_SHOULDER', 'POV');

-- AlterTable
ALTER TABLE "ShotListItem" ADD COLUMN     "cameraAngle" "CameraAngle",
ADD COLUMN     "lightingNotes" TEXT,
ADD COLUMN     "soundDesignNotes" TEXT;

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sceneId" TEXT,
    "shotId" TEXT,
    "type" "AssetType" NOT NULL,
    "source" "AssetSource" NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "caption" TEXT,
    "prompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");

-- CreateIndex
CREATE INDEX "Asset_sceneId_idx" ON "Asset"("sceneId");

-- CreateIndex
CREATE INDEX "Asset_shotId_idx" ON "Asset"("shotId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "ShotListItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
