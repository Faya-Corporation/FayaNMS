-- SNMPv3 engine identity enrollment and replay/timeliness state.
ALTER TABLE "Device" ADD COLUMN "snmpEngineIdHex" TEXT;
ALTER TABLE "Device" ADD COLUMN "snmpEngineBoots" INTEGER;
ALTER TABLE "Device" ADD COLUMN "snmpEngineTime" INTEGER;
ALTER TABLE "Device" ADD COLUMN "snmpEngineLastSeenAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Device_snmpEngineIdHex_key" ON "Device"("snmpEngineIdHex");
