-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "credentialProfileId" TEXT,
ADD COLUMN     "dataSource" TEXT NOT NULL DEFAULT 'SIMULATOR';

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_credentialProfileId_fkey" FOREIGN KEY ("credentialProfileId") REFERENCES "CredentialProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
