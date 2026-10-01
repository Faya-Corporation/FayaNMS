-- RT-015 (F-017 + F-049 + F-050) — additive hot-path indexes.
-- Purely additive: CREATE INDEX only, no DROP/ALTER/NOT NULL changes.
-- Plain CREATE INDEX rather than CONCURRENTLY: Prisma migrations run inside
-- a transaction (CONCURRENTLY cannot run in one); the first staging deploy
-- holds a brief lock while each index builds on the existing rows.

-- F-017/F-050: the metric retention prune and the dashboard trend /
-- fetchRollups readers filter granularity (+ metric) + periodStart without
-- a leading deviceId — MetricRollup's only index (@@unique deviceId-first)
-- cannot serve them, so every prune run seq-scanned the table three times.
CREATE INDEX "MetricRollup_granularity_metric_periodStart_idx"
    ON "MetricRollup"("granularity", "metric", "periodStart");

-- F-049: the per-ingest-event hot path resolves devices by management IP
-- (ingest/protocol, worker discovery reconcile) — non-unique on purpose
-- (duplicate mgmtIp values are legal today).
CREATE INDEX "Device_mgmtIp_idx"
    ON "Device"("mgmtIp");
