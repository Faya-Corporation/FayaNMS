-- CreateTable
CREATE TABLE "CollectorAgent" (
    "id" TEXT NOT NULL,
    "agentKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "siteId" TEXT,
    "role" TEXT NOT NULL,
    "region" TEXT,
    "version" TEXT,
    "capacity" INTEGER NOT NULL DEFAULT 10,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastHeartbeatAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registeredBy" TEXT,

    CONSTRAINT "CollectorAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectorAssignment" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "via" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 1,
    "leasedUntil" TIMESTAMP(3),
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT NOT NULL DEFAULT 'reconcile',

    CONSTRAINT "CollectorAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectorAgent_agentKey_key" ON "CollectorAgent"("agentKey");

-- CreateIndex
CREATE INDEX "CollectorAgent_siteId_idx" ON "CollectorAgent"("siteId");

-- CreateIndex
CREATE INDEX "CollectorAgent_status_idx" ON "CollectorAgent"("status");

-- CreateIndex
CREATE INDEX "CollectorAgent_lastHeartbeatAt_idx" ON "CollectorAgent"("lastHeartbeatAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectorAssignment_deviceId_key" ON "CollectorAssignment"("deviceId");

-- CreateIndex
CREATE INDEX "CollectorAssignment_agentId_idx" ON "CollectorAssignment"("agentId");

-- CreateIndex
CREATE INDEX "CollectorAssignment_leaseEpoch_idx" ON "CollectorAssignment"("leaseEpoch");

-- CreateIndex
CREATE INDEX "CollectorAssignment_leasedUntil_idx" ON "CollectorAssignment"("leasedUntil");

-- AddForeignKey
ALTER TABLE "CollectorAgent" ADD CONSTRAINT "CollectorAgent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectorAssignment" ADD CONSTRAINT "CollectorAssignment_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectorAssignment" ADD CONSTRAINT "CollectorAssignment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "CollectorAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
