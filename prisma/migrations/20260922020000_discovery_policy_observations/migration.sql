-- CLOUD-11: operator-controlled continuous discovery policies and bounded
-- wire-observation reconciliation. No secrets or raw packets are stored.
CREATE TABLE "DiscoveryPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subnetsJson" TEXT NOT NULL,
    "portsJson" TEXT NOT NULL,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastEnqueuedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryPolicy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveryPolicy_name_key" ON "DiscoveryPolicy"("name");
CREATE INDEX "DiscoveryPolicy_enabled_lastEnqueuedAt_idx"
    ON "DiscoveryPolicy"("enabled", "lastEnqueuedAt");

CREATE TABLE "DiscoveryObservation" (
    "id" TEXT NOT NULL,
    "jobId" TEXT,
    "deviceId" TEXT,
    "correlationId" TEXT NOT NULL,
    "subnet" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "reachable" BOOLEAN NOT NULL DEFAULT true,
    "openPortsJson" TEXT NOT NULL,
    "protocolsJson" TEXT NOT NULL,
    "confidence" INTEGER NOT NULL,
    "osFingerprint" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryObservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiscoveryObservation_jobId_ip_key"
    ON "DiscoveryObservation"("jobId", "ip");
CREATE INDEX "DiscoveryObservation_ip_observedAt_idx"
    ON "DiscoveryObservation"("ip", "observedAt");
CREATE INDEX "DiscoveryObservation_deviceId_observedAt_idx"
    ON "DiscoveryObservation"("deviceId", "observedAt");
CREATE INDEX "DiscoveryObservation_correlationId_idx"
    ON "DiscoveryObservation"("correlationId");

ALTER TABLE "DiscoveryObservation"
    ADD CONSTRAINT "DiscoveryObservation_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "JobExecution"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "DiscoveryObservation"
    ADD CONSTRAINT "DiscoveryObservation_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
