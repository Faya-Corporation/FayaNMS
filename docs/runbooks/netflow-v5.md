# NetFlow v5 ingestion runbook

## Operational boundary

The worker supports bounded NetFlow v5 record ingestion. The UDP collector is opt-in (`FAYANMS_PROTOCOL_COLLECTOR_ENABLED=true`), binds to `127.0.0.1` by default, and listens on UDP 2055 by default. The standard Compose profiles do not publish worker UDP ports. For an exporter on another host, use a separately reviewed internal-only network/Compose override and host firewall rules restricted to approved exporter addresses; do not publish the collector to public ingress. Set `FAYANMS_PROTOCOL_COLLECTOR_BIND` and `FAYANMS_NETFLOW_PORT` only in the protected worker environment. NetFlow can be disabled independently with `FAYANMS_NETFLOW_DISABLED=true`.

## Accepted data and queue behavior

The decoder accepts only version 5 datagrams with 1–30 records and exact `24 + count × 48` byte framing. The authenticated telemetry ingest validates all fields and caps serialized batches at 16 KiB. Exporter peer address/port are stored separately from flow endpoint addresses. Raw datagrams and credentials are not stored. NetFlow v9 templates, IPFIX templates, and sFlow records are not decoded into `FlowRecord` rows.

The collector relays to `/api/v1/ingest/protocol` with its telemetry service identity. Queue delivery inserts the typed records, clears the duplicate queue batch, and marks the queue row delivered atomically. Failures follow the existing five-attempt queue retry/dead-letter policy; retryable and dead-lettered rows retain their validated batch under existing queue access controls. Review queue audit events `PROTOCOL_EVENT_QUEUED`, `PROTOCOL_EVENT_RECEIVED`, and `PROTOCOL_EVENT_DEAD_LETTERED` for delivery status.

## Idempotency (F-048)

Delivery is at-least-once, and ingest is idempotent within a bounded window. Each event payload may carry an optional `idempotencyKey` (1–128 characters, `[A-Za-z0-9._:-]`); a NetFlow v5 event without one is deduped on a derived key of collector, exporter peer, and datagram header identity (`collectorId`, `sourceIp`, `sourcePort`, `flowSequence`, `unixSeconds`, `unixNanoseconds`) — a retransmitted datagram decodes to the same header, while every new batch differs because exporters increment `flowSequence`. A retry that reaches a still-live queue row (`QUEUED`, `IN_FLIGHT`, or `DELIVERED`) for the same key is answered `200` with `duplicate: true` plus the original attempt's `queueId`/`correlationId`, and writes no new queue row, audit row, or `FlowRecord`; the first delivery answers `202` with `queued: true`. The preflight runs inside the ingest transaction under a transaction-scoped Postgres advisory lock, so concurrent double-submits cannot create duplicates.

The dedupe window is the lifetime of the original queue row: `DELIVERED` rows are pruned by `protocolQueue.retention` (default 7 delivered days), so a retry arriving after that window is accepted again as a new event. A `DEAD` prior attempt releases the key — a retry is re-queued (at-least-once for failures). Events with no key and no derivable NetFlow header (syslog, SNMP traps, v9/IPFIX/sFlow metadata) keep plain at-least-once behavior: every accepted POST queues a new row. Keys identify payloads — reusing a key with a different payload returns the original attempt's receipt.

## Retention

The independent `flows.retention` setting defaults to 14 days (`{ "days": 14, "enabled": true }`). Users with `admin.system` may read or update the complete policy at `/api/v1/flows/retention`; updates write `SETTINGS_UPDATED`. A server-owned daily `FLOW_RETENTION` job prunes records by server `receivedAt`, in chunks of at most 1,000 and no more than 10,000 per run. Additional daily runs continue cleanup. Each run updates the setting’s `lastPrunedAt`/`lastPruneResult` and writes `FLOW_RECORDS_PRUNED`. The prune endpoint is jobs-scope only; operators should not call it with a browser session.

The staging queue itself is swept by the independent `protocolQueue.retention` setting (default `{ "deliveredDays": 7, "deadDays": 30, "enabled": true }`). A daily `PROTOCOL_QUEUE_RETENTION` job prunes terminal `DELIVERED`/`DEAD` `ProtocolEventQueue` rows (chunked 1,000 / 10,000 per run, `PROTOCOL_QUEUE_PRUNED` audit) — never rows that still own flow records: FlowRecord retention reclaims those first, and the queue rows follow on a later sweep.

## Verification and evidence limits

Run focused tests with `bun test tests/netflow-v5.test.ts tests/protocol-collector.test.ts tests/protocol-flow-batch.test.ts tests/protocol-ingest.test.ts tests/protocol-flow-drain.test.ts tests/flow-retention.test.ts tests/flow-retention-api.test.ts tests/audit/protocol-flow-retention.test.ts tests/audit/netflow-v5-no-flow-api-change.test.ts`. Test and harness success is not physical-vendor or production evidence. `/api/v1/flows` continues to return simulated aggregates; this work does not change its output or UI.
