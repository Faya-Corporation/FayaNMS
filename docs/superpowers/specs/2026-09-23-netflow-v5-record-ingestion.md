# NetFlow v5 Record Ingestion Design

## Status and scope

Written design for roadmap item 4: decode NetFlow v5 datagrams and persist their actual records. It does not replace the simulated `/api/v1/flows` response; that is roadmap item 7. NetFlow v9/IPFIX templates, sFlow, sampling correction, exporter ownership/failover, interface mapping, dashboards, and production vendor certification are also out of scope. The packet layout follows [Cisco's NetFlow Export Datagram Formats](https://www.cisco.com/c/en/us/td/docs/net_mgmt/netflow_collection_engine/5-0-3/user/guide/format.html).

## Current boundary

The UDP collector currently accepts v5 by version number and relays generic metadata. Authenticated `/api/v1/ingest/protocol` writes scalar event attributes into `ProtocolEventQueue`; the worker claims and drains those durable rows. The queue is the retry boundary to retain. `/api/v1/flows` currently reads device/interface metadata and returns deterministic simulated aggregates.

## Proposed data flow

1. For NetFlow only, the collector parses v5 datagrams into a bounded header plus typed records. Preserve the transport peer as exporter address; never confuse it with a record's source/destination IP.
2. Reject malformed packets before relay: require version 5, count 1–30, and exact datagram length `24 + count × 48`; parse all multibyte fields in network byte order. No partial batch acceptance.
3. Extend the strict authenticated ingest contract with an optional, versioned `flowBatch` payload. Validate its count, field ranges, addresses, and total serialized size server-side. Keep the existing event attributes small and scalar; do not put flow arrays in `attributesJson` or persist raw datagrams.
4. Store the typed batch on the durable queue row in the same transaction as its queue audit event. During drain, insert all records and mark the queue row delivered in one database transaction. Any failure rolls back both, allowing the existing retry policy to replay the batch.
5. Add a `FlowRecord` table with queue ID and record index as a unique idempotency key. Include nullable device association, exporter address/port, collector ID, received/export timestamps and header metadata, IPv4 endpoints, next hop, input/output ifIndex, packet/octet counters, source/destination ports, TCP flags, protocol, ToS, ASNs, and prefix masks. Retain `First`/`Last` as exporter uptime milliseconds; do not imply they are UTC timestamps without a separately validated uptime-to-wall-clock conversion.

Exporter-to-device association remains nullable unless the existing trusted association policy yields a device; endpoint addresses never establish device ownership. Preserve audit correlation to the queue ID, and report accepted records separately from ordinary protocol-event delivery. Keep v5 source data sufficient for later analytics, but do not change `/flows` in this task.

## Retention and operations

Flow records need an independent, configurable retention policy; do not apply metric retention implicitly. Recommended initial default is 14 days with a bounded, indexed prune operation and worker scheduling. The setting and prune endpoint should be server-owned and auditable; an admin UI can remain later work. Confirm the default during spec review. Queue dead-lettering must retain the original typed batch for diagnosis/replay under existing queue access controls.

## Verification and acceptance

- Unit-test valid v5 header/record decoding, IPv4 conversion, byte order, count boundaries, short/extra payloads, unsupported versions, and maximum datagram size.
- Test strict ingest validation, unauthenticated rejection, queue persistence, batch rollback/retry, idempotent replay, and retention boundaries with the repository's existing test conventions.
- Demonstrate that invalid batches create no queue or flow rows; a successful drain creates exactly `count` rows once, even after a retry; a failed transaction leaves the queue retryable.
- Apply a forward-only Prisma migration. Existing queued protocol events remain valid with no flow batch. Run focused tests, full relevant checks, and migration validation.
- Keep `/api/v1/flows` output and simulation behavior unchanged; verify existing flow API tests remain green.

## Open review point

Approve or adjust the proposed 14-day default and the inclusion of a scheduled prune path in item 4 before implementation planning. No implementation is authorized by this design approval alone.
