-- CreateEnum
CREATE TYPE "ContinuityStatus" AS ENUM ('REVIEWED', 'INTENTIONAL', 'DISMISSED');

-- AlterTable
ALTER TABLE "ShotListItem" ADD COLUMN     "characterProps" TEXT,
ADD COLUMN     "hairMakeup" TEXT;

-- CreateTable
CREATE TABLE "ContinuityDecision" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "status" "ContinuityStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContinuityDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContinuityDecision_projectId_idx" ON "ContinuityDecision"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ContinuityDecision_projectId_findingKey_key" ON "ContinuityDecision"("projectId", "findingKey");

-- AddForeignKey
ALTER TABLE "ContinuityDecision" ADD CONSTRAINT "ContinuityDecision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
