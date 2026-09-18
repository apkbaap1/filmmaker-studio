-- CreateEnum
CREATE TYPE "TransitionType" AS ENUM ('CUT', 'DISSOLVE', 'FADE', 'MATCH_CUT', 'J_CUT', 'L_CUT');

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "durationSeconds" DOUBLE PRECISION,
ADD COLUMN     "height" INTEGER,
ADD COLUMN     "width" INTEGER;

-- CreateTable
CREATE TABLE "Sequence" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Main edit',
    "order" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimelineClip" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "inPointSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outPointSeconds" DOUBLE PRECISION,
    "transition" "TransitionType",
    "transitionDurationSeconds" DOUBLE PRECISION,
    "selectedAssetId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimelineClip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sequence_projectId_idx" ON "Sequence"("projectId");

-- CreateIndex
CREATE INDEX "TimelineClip_sequenceId_idx" ON "TimelineClip"("sequenceId");

-- CreateIndex
CREATE INDEX "TimelineClip_shotId_idx" ON "TimelineClip"("shotId");

-- AddForeignKey
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineClip" ADD CONSTRAINT "TimelineClip_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineClip" ADD CONSTRAINT "TimelineClip_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "ShotListItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimelineClip" ADD CONSTRAINT "TimelineClip_selectedAssetId_fkey" FOREIGN KEY ("selectedAssetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
