/**
 * RT-011 / F-013 — snapshot retention prune must not cascade-delete live
 * config-management rows.
 *
 * ConfigSnapshot FKs are onDelete: Cascade from DriftRecord.currentSnapshotId
 * / DriftRecord.baselineSnapshotId and ConfigBaseline.snapshotId. The pruner
 * used to treat every HISTORICAL row past the retention window as freely
 * deletable, so a timed prune could silently cascade away:
 *   - an OPEN DriftRecord (the device reads compliant again with no
 *     resolve/accept action — drift-evaluate pins currentSnapshotId to the
 *     latest snapshot, which the NEXT backup demotes to HISTORICAL), and
 *   - an approved ConfigBaseline with its whole drift history.
 *
 * The guard (code-level, no schema change — the SetNull alternative is
 * BACKLOG hardening) removes snapshot ids referenced by OPEN drift records
 * or by any ConfigBaseline from the delete set before the delete transaction
 * runs, and reports both protection counts in the CONFIG_RETENTION_PRUNED
 * audit afterJson so operators can see WHY rows were retained.
 *
 * Test style: DB-backed against throwaway org/site/device chains, each test
 * scoped by its own site code so a prune run never touches another test's
 * rows or the demo fleet (tests/audit/metric-rollup-producer.test.ts harness
 * shape). The prune engine lives in src/lib/backups/retention.ts
 * (engine-in-lib, same shape as src/lib/protocol/queue-retention.ts) so the
 * tick route keeps only scheduling concerns.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { db } from "../../src/lib/db";
import {
  PRUNE_MAX_DELETES_PER_TICK,
  pruneRetention,
  type PrunePolicyRef,
} from "../../src/lib/backups/retention";

const DAY_MS = 86_400_000;
const ORG_NAME_PREFIX = "rt011-test-org-";
const VENDOR_KEY = "rt011-test-vendor";
const DEVICE_HOST_PREFIX = "rt011-test-device-";

const testStartedAt = new Date();
let vendorId = "";
let nextVersion = 1;

/** "30 days ago" style seed timestamps — always past the test cutoff. */
function oldDate(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * DAY_MS);
}

function policyForSite(siteCode: string): PrunePolicyRef {
  return {
    id: `rt011-policy-${siteCode}`,
    retentionDays: 7, // 7-day window: the ~30-day-old seed rows are past cutoff
    scopeJson: JSON.stringify({ siteCodes: [siteCode] }),
  };
}

/**
 * Isolated org + site + device for one test. The policy scope targets ONLY
 * this site code, so concurrent demo-fleet rows are unreachable.
 */
async function createIsolatedDevice(suffix: string): Promise<{
  siteCode: string;
  deviceId: string;
  policy: PrunePolicyRef;
}> {
  const siteCode = `RT011-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const org = await db.organization.create({
    data: { name: `${ORG_NAME_PREFIX}${siteCode}` },
    select: { id: true },
  });
  const site = await db.site.create({
    data: { name: siteCode, code: siteCode, organizationId: org.id },
    select: { id: true },
  });
  const device = await db.device.create({
    data: {
      hostname: `${DEVICE_HOST_PREFIX}${suffix}-${Date.now()}`,
      mgmtIp: "192.0.2.11",
      status: "ONLINE",
      vendorId,
      siteId: site.id,
    },
    select: { id: true },
  });
  return { siteCode, deviceId: device.id, policy: policyForSite(siteCode) };
}

/**
 * Three HISTORICAL snapshots, all far past any cutoff. Returns their ids in
 * creation order [oldest … newest]; the newest is the device's global
 * newest HISTORICAL row (never deletable per the existing safety cap).
 */
async function seedAgedSnapshots(deviceId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const version = nextVersion++;
    const row = await db.configSnapshot.create({
      data: {
        deviceId,
        version,
        rawText: `config v${version}`,
        sha256: `sha-rt011-${version}-${Date.now()}-${i}`,
        sizeBytes: 16,
        status: "HISTORICAL",
        createdAt: oldDate(30 - i),
      },
      select: { id: true },
    });
    ids.push(row.id);
  }
  return ids;
}

beforeAll(async () => {
  const vendor = await db.vendor.upsert({
    where: { key: VENDOR_KEY },
    update: {},
    create: { key: VENDOR_KEY, name: "RT011 Test Vendor", adapterKey: "generic" },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  // Device cascade reclaims snapshots/baselines/drift records; audits and
  // the org chain (which cascades sites) are removed explicitly.
  await db.auditEvent.deleteMany({
    where: { action: "CONFIG_RETENTION_PRUNED", createdAt: { gte: testStartedAt } },
  });
  await db.device.deleteMany({ where: { hostname: { startsWith: DEVICE_HOST_PREFIX } } });
  await db.vendor.deleteMany({ where: { key: VENDOR_KEY } });
  await db.organization.deleteMany({ where: { name: { startsWith: ORG_NAME_PREFIX } } });
});

async function pruneAudits() {
  return db.auditEvent.findMany({
    where: {
      action: "CONFIG_RETENTION_PRUNED",
      createdAt: { gte: testStartedAt },
    },
    orderBy: { createdAt: "asc" },
  });
}

describe("RT-011 snapshot prune cascade guard (DB)", () => {
  test("open drift record protects its snapshots from pruning", async () => {
    const { deviceId, policy } = await createIsolatedDevice("open-drift");
    const [v1, v2] = await seedAgedSnapshots(deviceId);
    void v1;
    // 3 total − keep-minimum 2 = 1 → the only candidate is the middle row
    // (the newest HISTORICAL is always protected). An OPEN drift record pins
    // that candidate → the prune must delete NOTHING and report why.
    await db.driftRecord.create({
      data: {
        deviceId,
        baselineSnapshotId: v1,
        currentSnapshotId: v2,
        status: "OPEN",
        detectedAt: new Date(),
      },
    });

    const outcome = await pruneRetention([policy], new Date());

    expect(outcome.pruned).toBe(0);
    expect(outcome.protectedByOpenDrift).toBe(1);
    const drift = await db.driftRecord.findFirst({ where: { deviceId } });
    expect(drift?.status).toBe("OPEN");
    const snapshotsLeft = await db.configSnapshot.count({ where: { deviceId } });
    expect(snapshotsLeft).toBe(3);

    // Audit summary exposes the protection count (zero-delete runs that
    // PROTECTED rows still report — that is the operator-facing "why").
    const audits = await pruneAudits();
    const after = JSON.parse(audits.at(-1)!.afterJson ?? "{}") as Record<string, number>;
    expect(after.protectedByOpenDrift).toBe(1);
    expect(after.protectedByBaseline).toBe(0);
    expect(after.count).toBe(0);
  });

  test("resolved drift record releases its snapshots", async () => {
    const { deviceId, policy } = await createIsolatedDevice("resolved-drift");
    const [v1, v2] = await seedAgedSnapshots(deviceId);
    await db.driftRecord.create({
      data: {
        deviceId,
        baselineSnapshotId: v1,
        currentSnapshotId: v2,
        status: "RESOLVED",
        detectedAt: new Date(),
        resolvedAt: new Date(),
      },
    });

    const outcome = await pruneRetention([policy], new Date());

    // Negative case for over-protection: a RESOLVED record does not hold
    // snapshots — the single candidate prunes normally.
    expect(outcome.pruned).toBe(1);
    expect(outcome.protectedByOpenDrift).toBe(0);
    const remaining = await db.configSnapshot.findMany({
      where: { deviceId },
      select: { id: true },
    });
    expect(remaining.map((row) => row.id)).not.toContain(v2);
  });

  test("approved baseline's snapshot is protected", async () => {
    const { deviceId, policy } = await createIsolatedDevice("baseline");
    const [, v2] = await seedAgedSnapshots(deviceId);
    await db.configBaseline.create({
      data: { deviceId, snapshotId: v2, approvedAt: new Date(), note: "rt011 baseline" },
    });

    const outcome = await pruneRetention([policy], new Date());

    expect(outcome.pruned).toBe(0);
    expect(outcome.protectedByBaseline).toBe(1);
    const baseline = await db.configBaseline.findFirst({
      where: { deviceId },
      select: { snapshotId: true },
    });
    expect(baseline?.snapshotId).toBe(v2);
    const stillThere = await db.configSnapshot.findUnique({ where: { id: v2 } });
    expect(stillThere?.status).toBe("HISTORICAL");

    const audits = await pruneAudits();
    const after = JSON.parse(audits.at(-1)!.afterJson ?? "{}") as Record<string, number>;
    expect(after.protectedByBaseline).toBe(1);
    expect(after.count).toBe(0);
  });

  test("unreferenced aged snapshots still prune (core loop unchanged)", async () => {
    const { deviceId, policy } = await createIsolatedDevice("plain");
    const ids = await seedAgedSnapshots(deviceId);
    const newest = ids[2];

    const outcome = await pruneRetention([policy], new Date());

    // Keep-minimum 2 + newest-HISTORICAL protection: exactly one of the
    // three aged rows is deletable and must be pruned.
    expect(outcome.pruned).toBe(1);
    expect(outcome.protectedByOpenDrift).toBe(0);
    expect(outcome.protectedByBaseline).toBe(0);
    const after = await db.configSnapshot.count({ where: { deviceId } });
    expect(after).toBe(2);
    const remaining = await db.configSnapshot.findMany({
      where: { deviceId },
      select: { id: true },
    });
    expect(remaining.map((row) => row.id)).toContain(newest);
  });

  test("protected snapshots do not consume the tick deletion budget", async () => {
    // Device A: only candidate is protected by an OPEN drift record.
    // Device B (same policy scope): plain prunable candidate — the budget
    // must still reach B even though A contributed a protected id.
    const a = await createIsolatedDevice("budget-protected");
    const [a1, a2] = await seedAgedSnapshots(a.deviceId);
    await db.driftRecord.create({
      data: {
        deviceId: a.deviceId,
        baselineSnapshotId: a1,
        currentSnapshotId: a2,
        status: "OPEN",
        detectedAt: new Date(),
      },
    });
    const b = await createIsolatedDevice("budget-prunable");
    const bIds = await seedAgedSnapshots(b.deviceId);
    const bCandidate = bIds[1]; // same shape: the one deletable row

    const outcome = await pruneRetention([a.policy, b.policy], new Date());

    expect(outcome.pruned).toBe(1);
    expect(outcome.protectedByOpenDrift).toBe(1);
    expect(await db.configSnapshot.findUnique({ where: { id: a2 } })).not.toBeNull();
    expect(await db.configSnapshot.findUnique({ where: { id: bCandidate } })).toBeNull();
    // Budget constant itself is untouched by the guard.
    expect(PRUNE_MAX_DELETES_PER_TICK).toBe(50);
  });
});

describe("RT-011 source contracts", () => {
  const REPO_ROOT = path.resolve(import.meta.dir, "../..");

  function readRepoFile(relativePath: string): string {
    return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  }

  test("guard queries OPEN drift records and ConfigBaseline refs against the delete set", () => {
    const lib = readRepoFile("src/lib/backups/retention.ts");
    expect(lib).toContain('status: "OPEN"');
    expect(lib).toContain("currentSnapshotId: { in: deleteIds }");
    expect(lib).toContain("baselineSnapshotId: { in: deleteIds }");
    expect(lib).toContain("configBaseline.findMany");
    expect(lib).toContain("protectedByOpenDrift");
    expect(lib).toContain("protectedByBaseline");
  });

  test("the delete stays guarded by status HISTORICAL (promotion-safe CAS)", () => {
    const lib = readRepoFile("src/lib/backups/retention.ts");
    expect(lib).toContain('status: "HISTORICAL"');
  });

  test("the tick route no longer hosts the pruner inline (engine-in-lib)", () => {
    const route = readRepoFile("src/app/api/v1/worker/tick/route.ts");
    expect(route).toContain('from "@/lib/backups/retention"');
    expect(route).not.toContain("async function pruneRetention");
    // Route header documents the retention semantics (protection rules).
    expect(route).toContain("OPEN DriftRecord");
  });
});
