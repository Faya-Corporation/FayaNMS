/**
 * RT-016 / F-018 — tick snapshot-prune due-ness gating + zero-query skips.
 *
 * The tick used to call pruneRetention on EVERY 30 s tick: per-policy scope
 * resolution + per-device findMany/count even when nothing was prunable —
 * 2,880×/day of DB load for work that can matter at most once per day per
 * policy. The prune is now gated by a 24 h due-ness window (in-memory
 * primary + persisted "snapshots.retention" Setting { lastPrunedAt } as the
 * restart-safe fallback — the metrics-prune route pattern), and the pruner
 * skips devices that cannot yield a candidate (no HISTORICAL rows, or below
 * the keep-minimum) with ZERO per-device queries off the back of ONE grouped
 * scan. Retention outcomes of a DUE run are unchanged (RT-011 composes).
 *
 * Test style: the gate helpers are exported from
 * src/lib/backups/retention.ts (engine-in-lib, RT-011 convention) so they
 * are unit-pinnable WITHOUT driving the whole tick POST (which would enqueue
 * jobs / mutate seeded rows). The route wiring (gate call + pruneSkipped
 * response field) is source-pinned config-hygiene style. DB rows are
 * throwaway; the shared demo fleet is never in scope.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { db } from "../../src/lib/db";
import {
  PRUNE_MIN_SNAPSHOTS_PER_DEVICE,
  SNAPSHOT_PRUNE_DEDUPE_HOURS,
  SNAPSHOT_PRUNE_SETTING_KEY,
  isSnapshotPruneDue,
  markSnapshotsPruned,
  pruneRetention,
  resetSnapshotPruneGateForTests,
  type PrunePolicyRef,
} from "../../src/lib/backups/retention";

const DAY_MS = 86_400_000;
const ORG_NAME_PREFIX = "rt016-test-org-";
const VENDOR_KEY = "rt016-test-vendor";
const DEVICE_HOST_PREFIX = "rt016-test-device-";

const testStartedAt = new Date();
let vendorId = "";
let nextVersion = 1;
let settingSnapshot: { key: string; valueJson: string } | null = null;

function oldDate(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * DAY_MS);
}

function policyForSite(siteCode: string): PrunePolicyRef {
  return {
    id: `rt016-policy-${siteCode}`,
    retentionDays: 7,
    scopeJson: JSON.stringify({ siteCodes: [siteCode] }),
  };
}

async function createIsolatedDevice(suffix: string): Promise<{
  siteCode: string;
  deviceId: string;
  policy: PrunePolicyRef;
}> {
  const siteCode = `RT016-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      mgmtIp: "192.0.2.12",
      status: "ONLINE",
      vendorId,
      siteId: site.id,
    },
    select: { id: true },
  });
  return { siteCode, deviceId: device.id, policy: policyForSite(siteCode) };
}

/** `count` HISTORICAL snapshots, all ~30 days old (past the 7-day cutoff). */
async function seedAgedSnapshots(deviceId: string, count = 3): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const version = nextVersion++;
    const row = await db.configSnapshot.create({
      data: {
        deviceId,
        version,
        rawText: `config v${version}`,
        sha256: `sha-rt016-${version}-${Date.now()}-${i}`,
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
    create: { key: VENDOR_KEY, name: "RT016 Test Vendor", adapterKey: "generic" },
  });
  vendorId = vendor.id;
  settingSnapshot = await db.setting.findUnique({
    where: { key: SNAPSHOT_PRUNE_SETTING_KEY },
    select: { key: true, valueJson: true },
  });
  resetSnapshotPruneGateForTests();
});

afterAll(async () => {
  resetSnapshotPruneGateForTests();
  await db.auditEvent.deleteMany({
    where: { action: "CONFIG_RETENTION_PRUNED", createdAt: { gte: testStartedAt } },
  });
  await db.device.deleteMany({ where: { hostname: { startsWith: DEVICE_HOST_PREFIX } } });
  await db.vendor.deleteMany({ where: { key: VENDOR_KEY } });
  await db.organization.deleteMany({ where: { name: { startsWith: ORG_NAME_PREFIX } } });
  if (settingSnapshot) {
    await db.setting.update({
      where: { key: SNAPSHOT_PRUNE_SETTING_KEY },
      data: { valueJson: settingSnapshot.valueJson },
    });
  } else {
    await db.setting.deleteMany({ where: { key: SNAPSHOT_PRUNE_SETTING_KEY } });
  }
});

describe("RT-016 snapshot prune due-ness gate", () => {
  test("a run stamps the gate; the next tick within the window skips", async () => {
    resetSnapshotPruneGateForTests();
    const now = new Date();
    // Fresh process + no Setting → due.
    expect(await isSnapshotPruneDue(now)).toBe(true);

    await markSnapshotsPruned(now);
    // In-memory primary: one second later the tick is NOT due.
    expect(await isSnapshotPruneDue(new Date(now.getTime() + 1_000))).toBe(false);
    // The Setting write happened (restart-safe layer).
    const row = await db.setting.findUnique({
      where: { key: SNAPSHOT_PRUNE_SETTING_KEY },
      select: { valueJson: true },
    });
    expect(row?.valueJson ?? "").toContain("lastPrunedAt");
  });

  test("restart safety — a fresh process still skips within the window", async () => {
    const now = new Date();
    await markSnapshotsPruned(now);
    // Simulate a restart: fresh module state (in-memory timestamp gone).
    resetSnapshotPruneGateForTests();
    expect(await isSnapshotPruneDue(new Date(now.getTime() + 1_000))).toBe(false);
  });

  test("prune runs again after the window elapses (over-gating negative case)", async () => {
    resetSnapshotPruneGateForTests();
    const stale = new Date(Date.now() - (SNAPSHOT_PRUNE_DEDUPE_HOURS + 1) * 3_600_000);
    await db.setting.upsert({
      where: { key: SNAPSHOT_PRUNE_SETTING_KEY },
      update: { valueJson: JSON.stringify({ lastPrunedAt: stale.toISOString() }) },
      create: { key: SNAPSHOT_PRUNE_SETTING_KEY, valueJson: JSON.stringify({ lastPrunedAt: stale.toISOString() }) },
    });
    expect(await isSnapshotPruneDue(new Date())).toBe(true);
    // A corrupt/absent timestamp must never wedge the gate closed.
    await db.setting.update({
      where: { key: SNAPSHOT_PRUNE_SETTING_KEY },
      data: { valueJson: JSON.stringify({ lastPrunedAt: "not-a-date" }) },
    });
    expect(await isSnapshotPruneDue(new Date())).toBe(true);
    await db.setting.update({
      where: { key: SNAPSHOT_PRUNE_SETTING_KEY },
      data: { valueJson: "broken-json" },
    });
    expect(await isSnapshotPruneDue(new Date())).toBe(true);
  });

  test("the tick route wires the gate and reports the skip", () => {
    const route = readFileSync("src/app/api/v1/worker/tick/route.ts", "utf8");
    expect(route).toContain("await isSnapshotPruneDue(now)");
    expect(route).toContain("await markSnapshotsPruned(now)");
    expect(route).toContain("pruneSkipped");
    expect(route).toContain("pruneSkipped: true and issues ZERO snapshot queries");
    // The gate lives next to the pruner engine (RT-011 engine-in-lib shape).
    const lib = readFileSync("src/lib/backups/retention.ts", "utf8");
    expect(lib).toContain('SNAPSHOT_PRUNE_SETTING_KEY = "snapshots.retention"');
    expect(lib).toContain("SNAPSHOT_PRUNE_DEDUPE_HOURS = 24");
  });

  test("non-prunable devices cost zero candidate queries (grouped status guard)", () => {
    // The binding requirement, pinned at the source: ONE grouped scan split
    // by status; devices with no HISTORICAL rows (or below the keep-minimum)
    // are skipped before any per-device findMany/count.
    const lib = readFileSync("src/lib/backups/retention.ts", "utf8");
    expect(lib).toContain('by: ["deviceId", "status"]');
    expect(lib).toContain("historicalCountByDevice");
    expect(lib).toContain("if ((historicalCountByDevice.get(deviceId) ?? 0) === 0) continue;");
    expect(lib).toContain("if (maxDeletable <= 0) continue;");
    expect(PRUNE_MIN_SNAPSHOTS_PER_DEVICE).toBe(2);
  });

  test("prune semantics unchanged when due (newest-HISTORICAL protection intact)", async () => {
    const { deviceId, policy } = await createIsolatedDevice("due-run");
    const ids = await seedAgedSnapshots(deviceId, 3);

    // A due run (gate helpers are orthogonal to the engine) behaves exactly
    // as before RT-016: keep-minimum 2 + newest-HISTORICAL protection →
    // exactly one of the three aged rows is deletable.
    const outcome = await pruneRetention([policy], new Date());
    expect(outcome.pruned).toBe(1);
    expect(await db.configSnapshot.count({ where: { deviceId } })).toBe(2);
    const remaining = await db.configSnapshot.findMany({
      where: { deviceId },
      select: { id: true },
    });
    expect(remaining.map((row) => row.id)).toContain(ids[2]);

    // Devices that cannot prune stay untouched at zero cost: a CURRENT-only
    // device (no HISTORICAL rows at all) and a below-keep-minimum device.
    const currentOnly = await createIsolatedDevice("current-only");
    await db.configSnapshot.create({
      data: {
        deviceId: currentOnly.deviceId,
        version: nextVersion++,
        rawText: "running config",
        sha256: `sha-rt016-current-${Date.now()}`,
        sizeBytes: 14,
        status: "CURRENT",
        createdAt: oldDate(30),
      },
    });
    const twoRows = await createIsolatedDevice("keep-minimum");
    await seedAgedSnapshots(twoRows.deviceId, 2);

    const outcome2 = await pruneRetention(
      [policy, currentOnly.policy, twoRows.policy],
      new Date()
    );
    expect(outcome2.pruned).toBe(0);
    expect(
      await db.configSnapshot.count({ where: { deviceId: currentOnly.deviceId } })
    ).toBe(1);
    expect(
      await db.configSnapshot.count({ where: { deviceId: twoRows.deviceId } })
    ).toBe(2);
  });
});
