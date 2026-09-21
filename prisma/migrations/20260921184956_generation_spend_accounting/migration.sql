-- CreateEnum
CREATE TYPE "UsageUnit" AS ENUM ('IMAGE', 'VIDEO_SECOND', 'CALL');

-- AlterTable
ALTER TABLE "Generation" ADD COLUMN     "createdById" TEXT;

-- CreateTable
CREATE TABLE "GenerationUsage" (
    "id" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "providerId" TEXT NOT NULL,
    "model" TEXT,
    "mode" "GenerationMode" NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" "UsageUnit" NOT NULL,
    "unitCostMicros" INTEGER,
    "currency" TEXT,
    "costMicros" INTEGER,
    "rateSource" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationUsage_projectId_occurredAt_idx" ON "GenerationUsage"("projectId", "occurredAt");

-- CreateIndex
CREATE INDEX "GenerationUsage_userId_occurredAt_idx" ON "GenerationUsage"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "Generation" ADD CONSTRAINT "Generation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_generationId_fkey" FOREIGN KEY ("generationId") REFERENCES "Generation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationUsage" ADD CONSTRAINT "GenerationUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
