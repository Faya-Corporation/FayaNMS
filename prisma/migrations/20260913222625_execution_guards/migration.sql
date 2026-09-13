-- CreateTable
CREATE TABLE "ChangeExecutionLease" (
    "changeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChangeExecutionLease_pkey" PRIMARY KEY ("changeId")
);

-- CreateTable
CREATE TABLE "DeviceWriteLock" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "changeId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceWriteLock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeExecutionLease_jobId_idx" ON "ChangeExecutionLease"("jobId");

-- CreateIndex
CREATE INDEX "ChangeExecutionLease_expiresAt_idx" ON "ChangeExecutionLease"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceWriteLock_deviceId_key" ON "DeviceWriteLock"("deviceId");

-- CreateIndex
CREATE INDEX "DeviceWriteLock_changeId_idx" ON "DeviceWriteLock"("changeId");

-- CreateIndex
CREATE INDEX "DeviceWriteLock_stepId_idx" ON "DeviceWriteLock"("stepId");

-- CreateIndex
CREATE INDEX "DeviceWriteLock_expiresAt_idx" ON "DeviceWriteLock"("expiresAt");

-- AddForeignKey
ALTER TABLE "ChangeExecutionLease" ADD CONSTRAINT "ChangeExecutionLease_changeId_fkey" FOREIGN KEY ("changeId") REFERENCES "ChangeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceWriteLock" ADD CONSTRAINT "DeviceWriteLock_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;
