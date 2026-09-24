-- CreateEnum
CREATE TYPE "AudioRole" AS ENUM ('DIALOGUE', 'MUSIC', 'SFX', 'AMBIENCE');

-- AlterEnum
ALTER TYPE "AssetType" ADD VALUE 'AUDIO';

-- AlterTable
ALTER TABLE "TimelineClip" ADD COLUMN     "audioMuted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AudioTrack" (
    "id" TEXT NOT NULL,
    "sequenceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AudioRole" NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "gainDb" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioClip" (
    "id" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "startSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "inPointSeconds" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "outPointSeconds" DOUBLE PRECISION,
    "gainDb" DOUBLE PRECISION,
    "fadeInSeconds" DOUBLE PRECISION,
    "fadeOutSeconds" DOUBLE PRECISION,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AudioClip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AudioTrack_sequenceId_idx" ON "AudioTrack"("sequenceId");

-- CreateIndex
CREATE INDEX "AudioClip_trackId_idx" ON "AudioClip"("trackId");

-- CreateIndex
CREATE INDEX "AudioClip_assetId_idx" ON "AudioClip"("assetId");

-- AddForeignKey
ALTER TABLE "AudioTrack" ADD CONSTRAINT "AudioTrack_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioClip" ADD CONSTRAINT "AudioClip_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "AudioTrack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioClip" ADD CONSTRAINT "AudioClip_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
