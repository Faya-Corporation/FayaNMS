-- CLOUD-11: durable normalized protocol-event handoff.
CREATE TABLE "ProtocolEventQueue" (
    "id" TEXT NOT NULL,
    "collectorId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "sourceIp" TEXT NOT NULL,
    "sourcePort" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "eventType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "protocolVersion" TEXT,
    "securityLevel" TEXT,
    "deviceId" TEXT,
    "attributesJson" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProtocolEventQueue_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProtocolEventQueue_status_nextAttemptAt_idx"
    ON "ProtocolEventQueue"("status", "nextAttemptAt");
CREATE INDEX "ProtocolEventQueue_collectorId_createdAt_idx"
    ON "ProtocolEventQueue"("collectorId", "createdAt");
CREATE INDEX "ProtocolEventQueue_deviceId_status_idx"
    ON "ProtocolEventQueue"("deviceId", "status");
CREATE INDEX "ProtocolEventQueue_correlationId_idx"
    ON "ProtocolEventQueue"("correlationId");

ALTER TABLE "ProtocolEventQueue"
    ADD CONSTRAINT "ProtocolEventQueue_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
