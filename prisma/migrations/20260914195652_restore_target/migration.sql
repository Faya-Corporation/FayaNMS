-- AlterTable
ALTER TABLE "ChangeRequest" ADD COLUMN     "restoreSnapshotId" TEXT;

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_restoreSnapshotId_fkey" FOREIGN KEY ("restoreSnapshotId") REFERENCES "ConfigSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;
