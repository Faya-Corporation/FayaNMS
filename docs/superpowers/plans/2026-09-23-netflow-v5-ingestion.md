# NetFlow v5 Record Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode actual NetFlow v5 records, stage them through the durable protocol queue, persist them idempotently, and prune them using an audited 14-day default policy.

**Architecture:** Keep the decoder pure and shared by the worker collector and server-side validation. Put a bounded typed batch on `ProtocolEventQueue`; drain it by inserting all `FlowRecord` rows and marking the queue row delivered in the same transaction. Reuse `Setting`, the existing daily job scheduler, worker runner, and server-owned API pattern for flow retention.

**Tech Stack:** TypeScript, Bun, Node `Buffer`, Zod, Prisma, PostgreSQL, existing service-JWT worker and audit/job systems.

**Spec:** `docs/superpowers/specs/2026-09-23-netflow-v5-record-ingestion.md`

## Global Constraints

- Accept NetFlow v5 only when `count` is 1–30 and datagram length is exactly `24 + count × 48` bytes.
- Parse all multibyte packet fields in network byte order; reject malformed batches without partial acceptance.
- Keep normalized event attributes scalar and bounded; do not store or relay raw datagrams.
- Keep `/api/v1/flows` simulation behavior unchanged; this plan does not implement roadmap item 7.
- Retain the existing durable queue retry boundary; use queue ID plus record index for persistence idempotency.
- Default flow retention to 14 days and run pruning on the server-owned daily worker schedule.
- Do not claim physical-vendor, staging, or production interoperability from unit or harness tests.

## Review Focus

- Truncated, overlong, unsupported-version, zero-count, and count-over-30 datagrams must be rejected before relay; Task 1 tests these boundaries.
- Unsigned 32-bit counters, uptime values, sequence numbers, and timestamps must survive parsing without signed overflow; Task 1 tests high-bit values.
- JSON batches with count/record mismatch, out-of-range fields, or oversized serialization must fail before queue creation; Task 2 tests the API validator.
- Exporter peer address must remain distinct from flow source/destination addresses; Task 2 tests persisted exporter identity and endpoint addresses.
- A repeated sequence or a sequence gap must not drop records; persist `flowSequence`, and deduplicate only by queue ID plus record index. Task 3 tests replay idempotency and sequence preservation; gap-detection policy remains out of scope.

---

### Task 1: Pure NetFlow v5 decoder and collector boundary

**Files:**
- Create: `src/lib/protocol/netflow-v5.ts`
- Modify: `Dockerfile.worker`
- Modify: `mini-services/worker/protocol-collector.ts`
- Create: `tests/netflow-v5.test.ts`
- Modify: `tests/protocol-collector.test.ts`

**Interfaces:**
- Export `NetFlowV5Header`, `NetFlowV5Record`, and `NetFlowV5Batch` from `src/lib/protocol/netflow-v5.ts`. Keep this shared runtime module dependency-free beyond Node built-ins; define the Zod schema in the Next.js ingest route so the worker image does not acquire a new Zod runtime dependency.
- Export `decodeNetFlowV5Datagram(packet: Buffer): NetFlowV5Batch | null`. Return `null` for any unsupported or malformed datagram; never return a partial batch.
- `NetFlowV5Header` stores `count` (1–30), `systemUptimeMs`, `unixSeconds`, `unixNanoseconds`, `flowSequence`, `engineType`, `engineId`, `samplingMode`, and `samplingInterval` as nonnegative numbers that preserve the packet's unsigned values. Split the two mode bits and 14 interval bits from the wire's sampling word.
- `NetFlowV5Record` stores `sourceIp`, `destinationIp`, and `nextHopIp` as dotted-decimal strings; `packets`, `octets`, `firstUptimeMs`, and `lastUptimeMs` as decimal strings; and `inputIfIndex`, `outputIfIndex`, `sourcePort`, `destinationPort`, `tcpFlags`, `protocol`, `tos`, `sourceAs`, `destinationAs`, `sourceMask`, and `destinationMask` as bounded integers.

- [ ] **Step 1: Write failing decoder tests.** Start with this valid one-record fixture, then add 30-record and malformed/unsupported boundary tests:

```ts
import { expect, test } from "bun:test";
import { decodeNetFlowV5Datagram } from "../src/lib/protocol/netflow-v5";

test("decodes v5 fields in network byte order", () => {
  const packet = Buffer.alloc(72);
  packet.writeUInt16BE(5, 0);
  packet.writeUInt16BE(1, 2);
  packet.writeUInt32BE(0xf0000001, 4);
  packet.writeUInt32BE(0xf0000005, 8);
  packet.writeUInt32BE(123, 12);
  packet.writeUInt32BE(0xf0000002, 16);
  packet[20] = 1;
  packet[21] = 2;
  packet.writeUInt16BE(100, 22);
  packet.set([192, 0, 2, 1, 198, 51, 100, 2, 203, 0, 113, 1], 24);
  packet.writeUInt16BE(7, 36);
  packet.writeUInt16BE(8, 38);
  packet.writeUInt32BE(0xf0000003, 40);
  packet.writeUInt32BE(0xf0000004, 44);
  packet.writeUInt16BE(443, 56);
  packet.writeUInt16BE(52_000, 58);
  packet[61] = 0x12;
  packet[62] = 6;
  const batch = decodeNetFlowV5Datagram(packet);
  expect(batch?.header.count).toBe(1);
  expect(batch?.header.systemUptimeMs).toBe(0xf0000001);
  expect(batch?.header.unixSeconds).toBe(0xf0000005);
  expect(batch?.header.unixNanoseconds).toBe(123);
  expect(batch?.header.flowSequence).toBe(0xf0000002);
  expect(batch?.records[0]).toMatchObject({
    sourceIp: "192.0.2.1",
    destinationIp: "198.51.100.2",
    nextHopIp: "203.0.113.1",
    packets: "4026531843",
    octets: "4026531844",
    sourcePort: 443,
    destinationPort: 52_000,
    tcpFlags: 0x12,
    protocol: 6,
  });
});
```

- [ ] **Step 2: Run `bun test tests/netflow-v5.test.ts`.** Expected: FAIL because `decodeNetFlowV5Datagram` does not exist.
- [ ] **Step 3: Implement the pure decoder.** Read the 24-byte header and each 48-byte record with explicit big-endian Buffer reads. Require `version === 5`, `1 <= count <= 30`, and `packet.length === 24 + count * 48`; convert IPv4 from the four wire bytes and unsigned counters to decimal strings. Use the same explicit offsets in the record loop:

```ts
const offset = 24 + index * 48;
const packets = packet.readUInt32BE(offset + 16);
const octets = packet.readUInt32BE(offset + 20);
const sourcePort = packet.readUInt16BE(offset + 32);
const destinationPort = packet.readUInt16BE(offset + 34);
```

- [ ] **Step 4: Run `bun test tests/netflow-v5.test.ts`.** Expected: PASS for normal, maximum-count, overflow-preservation, truncation, trailing-byte, unsupported-version, and count-boundary cases.
- [ ] **Step 5: Integrate the v5 collector path.** In `decodeProtocolPacket`, decode v5 into `flowBatch`, retain the transport peer as exporter `sourceIp`/`sourcePort`, and reject malformed v5 before `nextPost`. Leave v9, IPFIX, sFlow, syslog, and SNMP behavior unchanged.
- [ ] **Step 6: Add the decoder module to the worker runtime closure.** Add `COPY --chown=10001:10001 src/lib/protocol/netflow-v5.ts /src/lib/protocol/netflow-v5.ts` to `Dockerfile.worker`, beside its other shared protocol modules.
- [ ] **Step 7: Run `bun test tests/netflow-v5.test.ts tests/protocol-collector.test.ts`.** Expected: PASS; malformed v5 never enters the relay queue, while existing protocol paths remain intact. Verify `bun run build:gate` and the worker ARM64 image build include the new runtime module.
- [ ] **Step 8: Commit.** `git add src/lib/protocol/netflow-v5.ts Dockerfile.worker mini-services/worker/protocol-collector.ts tests/netflow-v5.test.ts tests/protocol-collector.test.ts && git commit -m "feat(netflow): decode bounded v5 datagrams"`.

### Task 2: Strict batch validation and durable queue schema

**Files:**
- Modify: `src/lib/protocol/ingest.ts`
- Create: `src/lib/protocol/netflow-v5-schema.ts`
- Modify: `src/app/api/v1/ingest/protocol/route.ts`
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260923010000_netflow_v5_records/migration.sql`
- Create: `tests/protocol-flow-batch.test.ts`
- Modify: `tests/protocol-ingest.test.ts`

**Interfaces:**
- Extend the strict ingest input with optional `flowBatch: NetFlowV5Batch`; only `protocol: "netflow"` and `protocolVersion: "NETFLOW_V5"` may carry it. A v5 event must carry one valid nonempty batch.
- Ingest response reports `flowRecordsAccepted` as the decoded record count separately from the ordinary queued-event acceptance.
- Add nullable `ProtocolEventQueue.flowBatchJson String?`, `ProtocolEventQueue.flowRecords FlowRecord[]`, and `Device.flowRecords FlowRecord[]`.
- Add `FlowRecord` with queue relation, `recordIndex`, nullable device relation, exporter address/port and collector ID, server `receivedAt`, exporter time/header metadata, all typed v5 record fields, and `@@unique([queueId, recordIndex])`. Index `receivedAt` for retention and `(deviceId, receivedAt)` for future analytics.
- Keep unsigned 32-bit fields that can exceed signed `Int` in decimal-string inputs and PostgreSQL `BigInt` columns.

- [ ] **Step 1: Write failing validator tests.** Cover a valid one-record batch; count mismatch; empty/31-record batch; invalid IPv4; negative or overflowing integer; non-NetFlow batch; v5 without batch; and serialized size above 16 KiB.
- [ ] **Step 2: Run `bun test tests/protocol-flow-batch.test.ts`.** Expected: FAIL because strict batch validation is not implemented.
- [ ] **Step 3: Add the server-side batch schema and API contract.** Keep Zod out of the worker runtime. Define `netFlowV5BatchSchema` in `src/lib/protocol/netflow-v5-schema.ts`, validate exact keys and ranges, and enforce `Buffer.byteLength(JSON.stringify(flowBatch), "utf8") <= 16 * 1024` before any DB write. Its bounds must include:

```ts
import { isIPv4 } from "node:net";
import { z } from "zod";

const uint8 = z.number().int().min(0).max(255);
const uint16 = z.number().int().min(0).max(65_535);
const uint32 = z.number().int().min(0).max(4_294_967_295);
const uint32Text = z.string().regex(/^\d{1,10}$/).refine((value) => BigInt(value) <= 4_294_967_295n);
const ipv4 = z.string().refine(isIPv4, "Expected IPv4 address");

const headerSchema = z.object({
  count: z.number().int().min(1).max(30),
  systemUptimeMs: uint32,
  unixSeconds: uint32,
  unixNanoseconds: z.number().int().min(0).max(999_999_999),
  flowSequence: uint32,
  engineType: uint8,
  engineId: uint8,
  samplingMode: z.number().int().min(0).max(3),
  samplingInterval: z.number().int().min(0).max(16_383),
}).strict();

const recordSchema = z.object({
  sourceIp: ipv4, destinationIp: ipv4, nextHopIp: ipv4,
  inputIfIndex: uint16, outputIfIndex: uint16,
  packets: uint32Text, octets: uint32Text,
  firstUptimeMs: uint32Text, lastUptimeMs: uint32Text,
  sourcePort: uint16, destinationPort: uint16,
  tcpFlags: uint8, protocol: uint8, tos: uint8,
  sourceAs: uint16, destinationAs: uint16,
  sourceMask: uint8, destinationMask: uint8,
}).strict();

export const netFlowV5BatchSchema = z.object({
  header: headerSchema,
  records: z.array(recordSchema).min(1).max(30),
}).strict().superRefine((batch, ctx) => {
  if (batch.header.count !== batch.records.length) {
    ctx.addIssue({ code: "custom", path: ["records"], message: "count must match records length" });
  }
});
```

In `src/app/api/v1/ingest/protocol/route.ts`, import this schema and add `flowBatch: netFlowV5BatchSchema.optional()` to `ingestSchema`, then apply the protocol/version refinement:

```ts
const ingestSchema = z.object({
  collectorId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  protocol: z.enum(PROTOCOLS),
  sourceIp: z.string().trim().min(1).max(64),
  sourcePort: z.coerce.number().int().min(1).max(65535),
  receivedAt: z.coerce.date().optional(),
  eventType: z.string().trim().min(1).max(120),
  severity: z.string().trim().min(1).max(32),
  message: z.string().max(8192),
  protocolVersion: z.string().trim().max(32).optional(),
  securityLevel: z.enum(["authPriv", "community", "unknown"]).optional(),
  deviceHint: z.object({
    hostname: z.string().trim().max(255).optional(),
    credentialProfileId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  }).strict().optional(),
  attributes: z.record(z.string().max(64), attributeSchema).optional(),
  flowBatch: netFlowV5BatchSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.flowBatch && (value.protocol !== "netflow" || value.protocolVersion !== "NETFLOW_V5")) {
    ctx.addIssue({ code: "custom", path: ["flowBatch"], message: "flowBatch requires NetFlow v5" });
  }
  if (value.protocol === "netflow" && value.protocolVersion === "NETFLOW_V5" && !value.flowBatch) {
    ctx.addIssue({ code: "custom", path: ["flowBatch"], message: "NetFlow v5 requires a decoded batch" });
  }
});
```

After successful Zod parsing and before association or database access, reject the batch when `Buffer.byteLength(JSON.stringify(parsed.data.flowBatch), "utf8") > 16 * 1024`.

- [ ] **Step 4: Run `bun test tests/protocol-flow-batch.test.ts tests/protocol-ingest.test.ts`.** Expected: PASS, with existing non-flow ingest contracts unchanged and valid v5 responses reporting exactly `flowRecordsAccepted: flowBatch.records.length`.
- [ ] **Step 5: Add Prisma fields and the forward-only migration.** Create `FlowRecord`, its queue/device foreign keys and indexes, and the nullable queue batch field. Preserve old queue rows without flow data; do not backfill fabricated records. Use this core model shape and add the exact fields from `NetFlowV5Record`:

```prisma
model FlowRecord {
  id             String             @id @default(cuid())
  queueId        String
  queue          ProtocolEventQueue @relation(fields: [queueId], references: [id], onDelete: Cascade)
  recordIndex    Int
  deviceId       String?
  device         Device?            @relation(fields: [deviceId], references: [id], onDelete: SetNull)
  collectorId    String
  exporterAddress String
  exporterPort   Int
  receivedAt     DateTime
  exportedAt     DateTime
  recordCount    Int
  systemUptimeMs BigInt
  unixSeconds    BigInt
  unixNanoseconds BigInt
  flowSequence   BigInt
  engineType     Int
  engineId       Int
  samplingMode   Int
  samplingInterval Int
  sourceIp       String
  destinationIp  String
  nextHopIp      String
  inputIfIndex   Int
  outputIfIndex  Int
  packets        BigInt
  octets         BigInt
  firstUptimeMs  BigInt
  lastUptimeMs   BigInt
  sourcePort     Int
  destinationPort Int
  tcpFlags       Int
  protocol       Int
  tos            Int
  sourceAs       Int
  destinationAs  Int
  sourceMask     Int
  destinationMask Int
  createdAt      DateTime           @default(now())

  @@unique([queueId, recordIndex])
  @@index([receivedAt])
  @@index([deviceId, receivedAt])
}
```

Also add `flowBatchJson String?` and `flowRecords FlowRecord[]` to `ProtocolEventQueue`, and `flowRecords FlowRecord[]` to `Device`.

- [ ] **Step 6: Validate schema and migration.** Run `bunx prisma validate`, `bunx prisma migrate deploy`, and `bunx prisma migrate diff --from-migrations prisma/migrations --shadow-database-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` against the disposable CI/local PostgreSQL setup. Expected: migration applies cleanly and schema drift is empty.
- [ ] **Step 7: Commit.** `git add src/lib/protocol/ingest.ts src/app/api/v1/ingest/protocol/route.ts prisma/schema.prisma prisma/migrations/20260923010000_netflow_v5_records/migration.sql tests/protocol-flow-batch.test.ts tests/protocol-ingest.test.ts && git commit -m "feat(netflow): persist typed v5 batches in queue"`.

### Task 3: Atomic, idempotent flow persistence during queue drain

**Files:**
- Modify: `src/app/api/v1/ingest/protocol/route.ts`
- Modify: `src/app/api/v1/worker/protocol-events/drain/route.ts`
- Modify: `mini-services/worker/scheduler.ts`
- Modify: `tests/protocol-ingest.test.ts`
- Create: `tests/protocol-flow-drain.test.ts`

**Interfaces:**
- Queue creation writes `flowBatchJson` and the queue audit event in one transaction; audit JSON records only batch count/header correlation, not a duplicate raw datagram or unbounded payload.
- Drain parses the validated stored batch, creates records with `{ queueId, recordIndex }`, then marks the queue row `DELIVERED` in the same transaction. Successful response includes `flowRecordsPersisted` separately from ordinary event count.

- [ ] **Step 1: Write failing persistence tests.** Assert a 3-record batch becomes exactly three rows with the same queue ID, record indexes 0–2, preserved flow sequence, exporter peer, and nullable/untrusted device association.
- [ ] **Step 2: Run `bun test tests/protocol-flow-drain.test.ts`.** Expected: FAIL because the drain only creates the ordinary protocol audit event.
- [ ] **Step 3: Implement transactional batch delivery.** Insert all records and update queue status in one Prisma transaction. Keep foreign-key and unique-key failures inside that transaction so no prefix of a batch can commit:

```ts
await db.$transaction(async (tx) => {
  await tx.flowRecord.createMany({ data: records });
  const delivered = await tx.protocolEventQueue.updateMany({
    where: { id: row.id, status: "IN_FLIGHT" },
    data: { status: "DELIVERED", deliveredAt, lockedAt: null },
  });
  if (delivered.count !== 1) throw new Error("protocol queue lease was lost");
  await tx.auditEvent.create({ data: deliveryAudit });
});
```

- [ ] **Step 4: Add replay and failure tests.** Force a transaction failure and assert no `FlowRecord` rows persist and the queue remains retryable. Replay the same queue batch and assert the unique `(queueId, recordIndex)` key prevents duplicate rows. Assert a non-flow queued event still drains normally and a dead-lettered queue row still contains its original `flowBatchJson`.
- [ ] **Step 5: Report flow record counts separately.** Return `flowRecordsPersisted` from the drain route and include it in the worker's `protocolQueue` log line in `mini-services/worker/scheduler.ts`.
- [ ] **Step 6: Run `bun test tests/protocol-flow-drain.test.ts tests/protocol-ingest.test.ts tests/protocol-queue.test.ts`.** Expected: PASS, including atomic rollback and old-row compatibility.
- [ ] **Step 7: Commit.** `git add src/app/api/v1/worker/protocol-events/drain/route.ts mini-services/worker/scheduler.ts tests/protocol-flow-drain.test.ts tests/protocol-ingest.test.ts && git commit -m "feat(netflow): persist queued records atomically"`.

### Task 4: Audited 14-day retention and scheduled pruning

**Files:**
- Create: `src/lib/flows/retention.ts`
- Create: `src/app/api/v1/flows/retention/route.ts`
- Create: `src/app/api/v1/flows/retention/prune/route.ts`
- Modify: `src/app/api/v1/worker/tick/route.ts`
- Modify: `mini-services/worker/runner.ts`
- Modify: `src/app/api/v1/worker/complete/route.ts`
- Modify: `src/app/api/v1/worker/claim/route.ts`
- Create: `tests/flow-retention.test.ts`
- Create: `tests/flow-retention-api.test.ts`
- Modify: `tests/audit/protocol-flow-retention.test.ts`

**Interfaces:**
- Store a configurable `{ days, enabled, lastPrunedAt, lastPruneResult }` record in `Setting` key `flows.retention`; default to `{ days: 14, enabled: true }`, validate days from 1 through 3650, and protect changes with `admin.system` plus `SETTINGS_UPDATED` audit.
- The server-owned prune API accepts worker `jobs` scope or an authorized admin session, deletes by server `receivedAt`, writes `FLOW_RECORDS_PRUNED` audit, and returns deleted count/duration.
- Daily `FLOW_RETENTION` jobs follow the existing `METRIC_RETENTION` dedupe/claim/runner/completion pattern. Delete in 1,000-row indexed chunks, capped at 10,000 rows per run; subsequent daily passes continue cleanup if more remain.

- [ ] **Step 1: Write failing pure retention tests.** Assert the 14-day default, days validation, disabled policy no-op, and cutoff semantics using injected `now` and rows just before/at/after the cutoff.
- [ ] **Step 2: Run `bun test tests/flow-retention.test.ts`.** Expected: FAIL because flow retention helpers do not exist.
- [ ] **Step 3: Implement policy parsing and validation.** Reuse `Setting` without a schema migration; malformed stored JSON falls back to the 14-day default, while invalid PUT input returns 400:

```ts
export const FLOW_RETENTION_KEY = "flows.retention";
export const DEFAULT_FLOW_RETENTION = { days: 14, enabled: true } as const;
export const flowRetentionSchema = z.object({
  days: z.number().int().min(1).max(3650),
  enabled: z.boolean(),
}).strict();
```

- [ ] **Step 4: Add authenticated policy and prune routes.** Policy reads/writes require `admin.system`; the prune route accepts only the worker `jobs` scope. Persist policy updates with `SETTINGS_UPDATED`; each prune records `FLOW_RECORDS_PRUNED` with deleted count, retention days, cutoff, and correlation ID. Base retention on `receivedAt`, never exporter-controlled time.

```ts
const cutoff = new Date(now.getTime() - policy.days * 86_400_000);
let deleted = 0;
for (let batchNumber = 0; batchNumber < 10; batchNumber += 1) {
  const rows = await db.flowRecord.findMany({
    where: { receivedAt: { lt: cutoff } },
    orderBy: { receivedAt: "asc" },
    take: 1_000,
    select: { id: true },
  });
  if (rows.length === 0) break;
  const result = await db.flowRecord.deleteMany({
    where: { id: { in: rows.map((row) => row.id) }, receivedAt: { lt: cutoff } },
  });
  deleted += result.count;
}
```
- [ ] **Step 5: Add daily scheduling and worker execution.** Dedupe `FLOW_RETENTION` for 24 hours, claim only its named job type, call the prune route using the worker `jobs` service scope, and validate `outcome`, deleted count, and duration on completion. Mirror the existing scheduler's active/recent-job guard:

```ts
const recent = await db.jobExecution.findFirst({
  where: {
    type: "FLOW_RETENTION",
    OR: [
      { status: { in: ["QUEUED", "RUNNING"] } },
      { status: { in: ["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"] },
        finishedAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
    ],
  },
  select: { id: true },
});
```

- [ ] **Step 6: Test bounded deletion and scheduling.** Verify each delete query is at most 1,000 IDs, one run never deletes more than 10,000, the next daily run can continue, unauthenticated calls fail, policy/prune writes are audited, and active/successful recent jobs suppress duplicates.
- [ ] **Step 7: Run `bun test tests/flow-retention.test.ts tests/flow-retention-api.test.ts tests/audit/protocol-flow-retention.test.ts`.** Expected: PASS for policy, authorization, auditing, chunk bounds, worker scheduling, and completion.
- [ ] **Step 8: Commit.** `git add src/lib/flows/retention.ts src/app/api/v1/flows/retention/route.ts src/app/api/v1/flows/retention/prune/route.ts src/app/api/v1/worker/tick/route.ts src/app/api/v1/worker/claim/route.ts src/app/api/v1/worker/complete/route.ts mini-services/worker/runner.ts tests/flow-retention.test.ts tests/flow-retention-api.test.ts tests/audit/protocol-flow-retention.test.ts && git commit -m "feat(netflow): add audited flow retention"`.

### Task 5: Operator guidance and full acceptance pass

**Files:**
- Modify: `docs/runbooks/network-lab.md`
- Create: `docs/runbooks/netflow-v5.md`
- Modify: `tests/protocol-collector.test.ts`
- Modify: `tests/protocol-ingest.test.ts`
- Modify: `tests/protocol-flow-drain.test.ts`
- Create: `tests/audit/netflow-v5-no-flow-api-change.test.ts`

- [ ] **Step 1: Document listener safety, default loopback binding, enabling/disabling NetFlow v5, validated payload behavior, queue retry/dead-letter visibility, retention setting/prune audit, and the 14-day default.** State that the API `/flows` remains simulated and physical exporter interoperability is unverified.
- [ ] **Step 2: Add a scope regression test and run focused acceptance tests.** Assert `src/app/api/v1/flows/route.ts` still calls `simulateDeviceFlows` and does not query `db.flowRecord`; then run `bun test tests/netflow-v5.test.ts tests/protocol-collector.test.ts tests/protocol-flow-batch.test.ts tests/protocol-ingest.test.ts tests/protocol-flow-drain.test.ts tests/flow-retention.test.ts tests/flow-retention-api.test.ts tests/audit/protocol-flow-retention.test.ts tests/audit/netflow-v5-no-flow-api-change.test.ts`.
- [ ] **Step 3: Run repository gates:** `bun run lint`, `bunx tsc --noEmit`, `bun run test`, `bunx prisma validate`, and the migration drift command from Task 2. Expected: all checks green on the exact task head.
- [ ] **Step 4: Review scope:** confirm `src/app/api/v1/flows/route.ts`, `src/lib/flows/simulate.ts`, and UI/hooks have no behavior change; confirm no raw packets, credentials, or signed URLs are stored.
- [ ] **Step 5: Commit.** `git add docs/runbooks/network-lab.md docs/runbooks/netflow-v5.md tests/protocol-collector.test.ts tests/protocol-ingest.test.ts tests/protocol-flow-drain.test.ts tests/audit/netflow-v5-no-flow-api-change.test.ts && git commit -m "docs(netflow): document v5 ingestion operations"`.

## Self-Review

- **Spec coverage:** decoder framing and field decoding are Task 1; strict bounded queue input and schema are Task 2; atomic replay-safe persistence and reporting are Task 3; the approved 14-day server-owned prune path is Task 4; operations and `/flows` non-regression checks are Task 5.
- **Migration safety:** existing queue rows remain valid with `flowBatchJson = NULL`; one forward-only migration creates the new table and indexes; every record is FK-linked to its queue row and uniquely indexed by record position.
- **Sequence policy:** persist the exporter sequence; do not use it as a dedupe key or reject gaps. A later task may add gap/restart diagnostics with explicit exporter identity and state.
- **Evidence limits:** test/harness success is not proof of exporter interoperability. Real exporter capture, physical-vendor certification, staging, and production remain external gates.
- **Scope:** NetFlow v9 templates, IPFIX, sFlow, rollups, sequence-gap diagnostics, exporter ownership/HA, UI changes, and replacement of `/api/v1/flows` simulation are not part of this plan.
