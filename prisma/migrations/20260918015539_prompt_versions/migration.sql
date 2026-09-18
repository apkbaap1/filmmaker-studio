-- CreateEnum
CREATE TYPE "PromptSource" AS ENUM ('COMPILED', 'EDITED');

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "mode" "GenerationMode" NOT NULL,
    "version" INTEGER NOT NULL,
    "source" "PromptSource" NOT NULL,
    "text" TEXT NOT NULL,
    "specSnapshot" JSONB,
    "promptProviderId" TEXT,
    "sourceAssetId" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptVersion_shotId_idx" ON "PromptVersion"("shotId");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_shotId_mode_version_key" ON "PromptVersion"("shotId", "mode", "version");

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_shotId_fkey" FOREIGN KEY ("shotId") REFERENCES "ShotListItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
