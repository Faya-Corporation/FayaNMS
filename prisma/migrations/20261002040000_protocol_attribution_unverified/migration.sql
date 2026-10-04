-- F-036 (batch-11): persisted honesty marker for protocol-event device
-- attribution that could not be corroborated against the source IP.
ALTER TABLE "ProtocolEventQueue"
    ADD COLUMN "attributionUnverified" BOOLEAN NOT NULL DEFAULT false;
