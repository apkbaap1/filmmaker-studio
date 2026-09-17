/*
  Warnings:

  - The `cameraAngle` column on the `ShotListItem` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "Scene" ADD COLUMN     "action" TEXT,
ADD COLUMN     "directorNotes" TEXT,
ADD COLUMN     "emotionalBeat" TEXT;

-- AlterTable
ALTER TABLE "ShotListItem" ADD COLUMN     "cameraEndPosition" TEXT,
ADD COLUMN     "cameraHeight" TEXT,
ADD COLUMN     "cameraStartPosition" TEXT,
ADD COLUMN     "characterBlocking" TEXT,
ADD COLUMN     "composition" TEXT,
ADD COLUMN     "depthOfField" TEXT,
ADD COLUMN     "dialogueAudio" TEXT,
ADD COLUMN     "directorNotes" TEXT,
ADD COLUMN     "durationSeconds" DOUBLE PRECISION,
ADD COLUMN     "editPoint" TEXT,
ADD COLUMN     "focalLength" TEXT,
ADD COLUMN     "framing" TEXT,
ADD COLUMN     "mood" TEXT,
ADD COLUMN     "movementSpeed" TEXT,
ADD COLUMN     "sfx" TEXT,
ADD COLUMN     "subjectMovement" TEXT,
ADD COLUMN     "transition" TEXT,
DROP COLUMN "cameraAngle",
ADD COLUMN     "cameraAngle" TEXT;

-- DropEnum
DROP TYPE "CameraAngle";

-- CreateTable
CREATE TABLE "_CastMemberToScene" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CastMemberToScene_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_CastMemberToScene_B_index" ON "_CastMemberToScene"("B");

-- AddForeignKey
ALTER TABLE "_CastMemberToScene" ADD CONSTRAINT "_CastMemberToScene_A_fkey" FOREIGN KEY ("A") REFERENCES "CastMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CastMemberToScene" ADD CONSTRAINT "_CastMemberToScene_B_fkey" FOREIGN KEY ("B") REFERENCES "Scene"("id") ON DELETE CASCADE ON UPDATE CASCADE;
