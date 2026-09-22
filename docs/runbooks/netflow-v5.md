# NetFlow v5 ingestion runbook

## Operational boundary

The worker supports bounded NetFlow v5 record ingestion. The UDP collector is opt-in (`FAYANMS_PROTOCOL_COLLECTOR_ENABLED=true`), binds to `127.0.0.1` by default, and listens on UDP 2055 by default. The standard Compose profiles do not publish worker UDP ports. For an exporter on another host, use a separately reviewed internal-only network/Compose override and host firewall rules restricted to approved exporter addresses; do not publish the collector to public ingress. Set `FAYANMS_PROTOCOL_COLLECTOR_BIND` and `FAYANMS_NETFLOW_PORT` only in the protected worker environment. NetFlow can be disabled independently with `FAYANMS_NETFLOW_DISABLED=true`.

## Accepted data and queue behavior

The decoder accepts only version 5 datagrams with 1–30 records and exact `24 + count × 48` byte framing. The authenticated telemetry ingest validates all fields and caps serialized batches at 16 KiB. Exporter peer address/port are stored separately from flow endpoint addresses. Raw datagrams and credentials are not stored. NetFlow v9 templates, IPFIX templates, and sFlow records are not decoded into `FlowRecord` rows.

The collector relays to `/api/v1/ingest/protocol` with its telemetry service identity. Queue delivery inserts the typed records, clears the duplicate queue batch, and marks the queue row delivered atomically. Failures follow the existing five-attempt queue retry/dead-letter policy; retryable and dead-lettered rows retain their validated batch under existing queue access controls. Review queue audit events `PROTOCOL_EVENT_QUEUED`, `PROTOCOL_EVENT_RECEIVED`, and `PROTOCOL_EVENT_DEAD_LETTERED` for delivery status.

## Retention

The independent `flows.retention` setting defaults to 14 days (`{ "days": 14, "enabled": true }`). Users with `admin.system` may read or update the complete policy at `/api/v1/flows/retention`; updates write `SETTINGS_UPDATED`. A server-owned daily `FLOW_RETENTION` job prunes records by server `receivedAt`, in chunks of at most 1,000 and no more than 10,000 per run. Additional daily runs continue cleanup. Each run updates the setting’s `lastPrunedAt`/`lastPruneResult` and writes `FLOW_RECORDS_PRUNED`. The prune endpoint is jobs-scope only; operators should not call it with a browser session.

## Verification and evidence limits

Run focused tests with `bun test tests/netflow-v5.test.ts tests/protocol-collector.test.ts tests/protocol-flow-batch.test.ts tests/protocol-ingest.test.ts tests/protocol-flow-drain.test.ts tests/flow-retention.test.ts tests/flow-retention-api.test.ts tests/audit/protocol-flow-retention.test.ts tests/audit/netflow-v5-no-flow-api-change.test.ts`. Test and harness success is not physical-vendor or production evidence. `/api/v1/flows` continues to return simulated aggregates; this work does not change its output or UI.
