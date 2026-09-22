ALTER TABLE "ProtocolEventQueue"
    ADD COLUMN "flowBatchJson" TEXT;

CREATE TABLE "FlowRecord" (
    "id" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "recordIndex" INTEGER NOT NULL,
    "deviceId" TEXT,
    "collectorId" TEXT NOT NULL,
    "exporterAddress" TEXT NOT NULL,
    "exporterPort" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "exportedAt" TIMESTAMP(3) NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "systemUptimeMs" BIGINT NOT NULL,
    "unixSeconds" BIGINT NOT NULL,
    "unixNanoseconds" BIGINT NOT NULL,
    "flowSequence" BIGINT NOT NULL,
    "engineType" INTEGER NOT NULL,
    "engineId" INTEGER NOT NULL,
    "samplingMode" INTEGER NOT NULL,
    "samplingInterval" INTEGER NOT NULL,
    "sourceIp" TEXT NOT NULL,
    "destinationIp" TEXT NOT NULL,
    "nextHopIp" TEXT NOT NULL,
    "inputIfIndex" INTEGER NOT NULL,
    "outputIfIndex" INTEGER NOT NULL,
    "packets" BIGINT NOT NULL,
    "octets" BIGINT NOT NULL,
    "firstUptimeMs" BIGINT NOT NULL,
    "lastUptimeMs" BIGINT NOT NULL,
    "sourcePort" INTEGER NOT NULL,
    "destinationPort" INTEGER NOT NULL,
    "tcpFlags" INTEGER NOT NULL,
    "protocol" INTEGER NOT NULL,
    "tos" INTEGER NOT NULL,
    "sourceAs" INTEGER NOT NULL,
    "destinationAs" INTEGER NOT NULL,
    "sourceMask" INTEGER NOT NULL,
    "destinationMask" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlowRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FlowRecord_queueId_recordIndex_key"
    ON "FlowRecord"("queueId", "recordIndex");
CREATE INDEX "FlowRecord_receivedAt_idx"
    ON "FlowRecord"("receivedAt");
CREATE INDEX "FlowRecord_deviceId_receivedAt_idx"
    ON "FlowRecord"("deviceId", "receivedAt");

ALTER TABLE "FlowRecord"
    ADD CONSTRAINT "FlowRecord_queueId_fkey"
    FOREIGN KEY ("queueId") REFERENCES "ProtocolEventQueue"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FlowRecord"
    ADD CONSTRAINT "FlowRecord_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
