/**
 * RT-015 / F-017 (+ linked F-049, F-050) — batched metric retention prune
 * and the additive hot-path index migration.
 *
 * The prune used ONE unbounded deleteMany per section — a first run after
 * enabling (or after a gap) would delete millions of MetricSample rows in a
 * single statement. It now deletes in chunks of 1,000 with a 50,000-row
 * per-run cap (flow-retention pattern); a backlog converges on the next
 * run. The same migration adds the MetricRollup(granularity, metric,
 * periodStart) index (prune + no-deviceId readers) and Device(mgmtIp)
 * (per-ingest-event lookup).
 *
 * Test style: DB-backed. Helper-level tests drive the exported chunked
 * prune functions directly (deterministic — no 60 s throttle involved);
 * one route POST proves the end-to-end wiring + response contract. All rows
 * are throwaway (own vendor/device); cutoffs are chosen so the shared demo
 * rows (prune bait is only 20/100 days old) are never in scope.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

import { db } from "../../src/lib/db";
import {
  METRIC_RETENTION_CHUNK_SIZE,
  METRIC_RETENTION_MAX_DELETES_PER_RUN,
  METRICS_RETENTION_KEY,
  parseStoredRetention,
  pruneMetricRollupsChunked,
  pruneMetricSamplesChunked,
} from "../../src/lib/performance/retention";

const VENDOR_KEY = "rt015-test-vendor";
const MIGRATION_DIR = "20260924000000_rt015_hot_path_indexes";

const testStartedAt = new Date();
let vendorId = "";
let deviceId = "";
let adminJwt = "";

/** 400 days ago — far beyond any retention window, older than all demo rows. */
const AGED = new Date(Date.now() - 400 * 86_400_000);
/** 300 days ago — between my aged rows and everything the demo seeded. */
const CUTOFF = new Date(Date.now() - 300 * 86_400_000);

let settingSnapshot: { key: string; valueJson: string } | null = null;
let dbUp = true;

/**
 * Mint a worker service JWT (same shape the mini-services worker sends;
 * requireServiceOrPermission reserves Bearer for SERVICE tokens — session
 * JWTs only work on session-permission routes).
 */
function mintServiceJwt(): string {
  const secret = process.env.FAYANMS_SERVICE_SECRET ?? "";
  const nowS = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      iss: "fayanms:worker",
      sub: "rt015-test-service",
      aud: "fayanms:internal",
      iat: nowS,
      exp: nowS + 300,
      jti: randomUUID(), // wave-11 replay guard: jti binds to a mint cycle — unique per mint
      scopes: ["metrics"],
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${signature}`;
}

async function seedSamples(count: number, ts: Date, offsetStepMs = 1): Promise<void> {
  for (let i = 0; i < count; i += 5_000) {
    const rows = Array.from({ length: Math.min(5_000, count - i) }, (_, j) => ({
      deviceId,
      metric: j % 2 === 0 ? "CPU" : "MEMORY",
      value: 10 + ((i + j) % 80),
      ts: new Date(ts.getTime() + (i + j) * offsetStepMs),
    }));
    await db.metricSample.createMany({ data: rows });
  }
}

async function countSamples(ts: Date): Promise<number> {
  return db.metricSample.count({ where: { deviceId, ts: { lt: ts } } });
}

beforeAll(async () => {
  const vendor = await db.vendor.upsert({
    where: { key: VENDOR_KEY },
    update: {},
    create: { key: VENDOR_KEY, name: "RT015 Test Vendor", adapterKey: "generic" },
  });
  vendorId = vendor.id;
  const device = await db.device.create({
    data: {
      hostname: `rt015-test-device-${Date.now()}`,
      mgmtIp: "192.0.2.88",
      status: "ONLINE",
      vendorId,
    },
    select: { id: true },
  });
  deviceId = device.id;
  settingSnapshot = await db.setting.findUnique({
    where: { key: METRICS_RETENTION_KEY },
    select: { key: true, valueJson: true },
  });
  // No user fixture needed: this file mints a SERVICE token, not a session
  // JWT. The CI gate replays only `migrate deploy` on a fresh database (no
  // demo seed), so nothing here may assume seeded rows.
  adminJwt = mintServiceJwt();
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbUp = false;
  }
});

afterAll(async () => {
  await db.metricSample.deleteMany({ where: { deviceId } });
  await db.metricRollup.deleteMany({ where: { deviceId } });
  await db.auditEvent.deleteMany({
    where: { action: "METRIC_RETENTION_PRUNED", createdAt: { gte: testStartedAt } },
  });
  // Restore the pre-test "metrics.retention" Setting exactly as found
  // (valueJson is NOT NULL — a missing row means delete).
  if (settingSnapshot) {
    await db.setting.update({
      where: { key: METRICS_RETENTION_KEY },
      data: { valueJson: settingSnapshot.valueJson },
    });
  } else {
    await db.setting.deleteMany({ where: { key: METRICS_RETENTION_KEY } });
  }
  await db.device.deleteMany({ where: { id: deviceId } });
  await db.vendor.deleteMany({ where: { key: VENDOR_KEY } });
});

describe("RT-015 batched metric prune + hot-path indexes", () => {
  test("prune deletes in chunks, respects the per-run cap, and converges on the next run", async () => {
    expect(METRIC_RETENTION_CHUNK_SIZE).toBe(1_000);
    expect(METRIC_RETENTION_MAX_DELETES_PER_RUN).toBe(50_000);

    // 50,010 aged rows: an unbounded delete would remove them all in one
    // statement — the chunked prune must stop at exactly the cap.
    await seedSamples(50_010, AGED);
    expect(await countSamples(CUTOFF)).toBe(50_010);

    const first = await pruneMetricSamplesChunked(CUTOFF);
    expect(first).toBe(METRIC_RETENTION_MAX_DELETES_PER_RUN);
    expect(await countSamples(CUTOFF)).toBe(10);

    // The backlog converges on the next run.
    const second = await pruneMetricSamplesChunked(CUTOFF);
    expect(second).toBe(10);
    expect(await countSamples(CUTOFF)).toBe(0);
  });

  test("fresh samples survive the cutoff (negative case)", async () => {
    await seedSamples(5, new Date(Date.now() - 86_400_000));
    const deleted = await pruneMetricSamplesChunked(CUTOFF);
    expect(deleted).toBe(0);
    const fresh = await db.metricSample.count({
      where: { deviceId, ts: { gte: CUTOFF } },
    });
    expect(fresh).toBe(5);
  });

  test("rollup prunes per granularity with correct counts", async () => {
    const periods = (count: number, base: Date) =>
      Array.from({ length: count }, (_, i) => new Date(base.getTime() + i * 3_600_000));
    for (const granularity of ["5M", "1H", "1D"] as const) {
      await db.metricRollup.createMany({
        data: periods(5, AGED).map((periodStart, i) => ({
          deviceId,
          metric: "CPU",
          granularity,
          periodStart,
          avg: i,
          max: i,
          min: i,
          p95: i,
        })),
      });
    }
    // Fresh 5M rollups (same device, same metric — inside the window).
    await db.metricRollup.createMany({
      data: periods(2, new Date(Date.now() - 3_600_000)).map((periodStart, i) => ({
        deviceId,
        metric: "CPU",
        granularity: "5M" as const,
        periodStart,
        avg: i,
        max: i,
        min: i,
        p95: i,
      })),
    });

    expect(await pruneMetricRollupsChunked("5M", CUTOFF)).toBe(5);
    expect(await pruneMetricRollupsChunked("1H", CUTOFF)).toBe(5);
    expect(await pruneMetricRollupsChunked("1D", CUTOFF)).toBe(5);
    // Re-running is a no-op once the aged rows are gone.
    expect(await pruneMetricRollupsChunked("5M", CUTOFF)).toBe(0);
    // Fresh 5M rows survive.
    expect(
      await db.metricRollup.count({ where: { deviceId, granularity: "5M" } })
    ).toBe(2);
  });

  test("migration is purely additive and schema carries the @@index entries", () => {
    const dir = `prisma/migrations/${MIGRATION_DIR}`;
    expect(readdirSync("prisma/migrations")).toContain(MIGRATION_DIR);
    const sql = readFileSync(`${dir}/migration.sql`, "utf8");
    // Only CREATE INDEX statements among executable SQL (comments stripped
    // BEFORE statement splitting — comment prose may contain ";").
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements.length).toBe(2);
    for (const statement of statements) {
      expect(statement).toMatch(/^CREATE INDEX /);
      expect(statement).not.toMatch(/DROP|ALTER|NOT NULL|CONCURRENTLY/);
    }
    expect(sql).toContain(`"MetricRollup_granularity_metric_periodStart_idx"`);
    expect(sql).toContain(`"Device_mgmtIp_idx"`);

    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const rollupBlock = schema.slice(
      schema.indexOf("model MetricRollup"),
      schema.indexOf("model Notification")
    );
    expect(rollupBlock).toContain("@@index([granularity, metric, periodStart])");
    const deviceBlock = schema.slice(
      schema.indexOf("model Device {"),
      schema.indexOf("model DeviceInterface")
    );
    expect(deviceBlock).toContain("@@index([mgmtIp])");
  });

  test("the two indexes exist in the database (post-deploy)", async () => {
    if (!dbUp) {
      console.log("RT-015: DB unreachable — skipping pg_indexes assertion");
      return;
    }
    const rows = (await db.$queryRaw`SELECT indexname FROM pg_indexes WHERE indexname IN ('MetricRollup_granularity_metric_periodStart_idx', 'Device_mgmtIp_idx')`) as Array<{
      indexname: string;
    }>;
    const names = rows.map((row) => row.indexname).sort();
    expect(names).toEqual(["Device_mgmtIp_idx", "MetricRollup_granularity_metric_periodStart_idx"]);
  });

  test("prune route stays chunked end-to-end with an unchanged contract", async () => {
    // Bounded policy: 3650 days ≈ year 2016 cutoff — deletes ONLY my 1990-era
    // rows; every demo row (newest is ~100 days old) is out of scope.
    const policy = {
      raw: { days: 3650, enabled: true },
      rollup5M: { days: 3650, enabled: true },
      rollup1H: { days: 3650, enabled: true },
      rollup1D: { days: 3650, enabled: true },
      lastPrunedAt: null,
      lastPruneResult: null,
    };
    await db.setting.upsert({
      where: { key: METRICS_RETENTION_KEY },
      update: { valueJson: JSON.stringify(policy) },
      create: { key: METRICS_RETENTION_KEY, valueJson: JSON.stringify(policy) },
    });

    const ancient = new Date(Date.parse("1990-01-01T00:00:00Z"));
    await seedSamples(25, ancient, 1_000);
    for (const granularity of ["5M", "1H", "1D"] as const) {
      await db.metricRollup.create({
        data: {
          deviceId,
          metric: "CPU",
          granularity,
          periodStart: ancient,
          avg: 1,
          max: 1,
          min: 1,
          p95: 1,
        },
      });
    }

    const { POST } = await import("../../src/app/api/v1/metrics/retention/prune/route");
    const response = await POST(
      new Request("http://localhost:3000/api/v1/metrics/retention/prune", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminJwt}` },
        body: JSON.stringify({ triggeredBy: "RT015-TEST" }),
      })
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: Record<string, number>;
    };
    expect(body.success).toBe(true);
    expect(body.data.metricSamplesDeleted).toBe(25);
    expect(body.data.rollup5MDeleted).toBe(1);
    expect(body.data.rollup1HDeleted).toBe(1);
    expect(body.data.rollup1DDeleted).toBe(1);
    expect(typeof body.data.durationMs).toBe("number");

    // Bookkeeping: Setting updated + audit row, exactly as before RT-015.
    const setting = await db.setting.findUnique({ where: { key: METRICS_RETENTION_KEY } });
    const stored = parseStoredRetention(setting?.valueJson);
    expect(stored.lastPrunedAt).not.toBeNull();
    const auditRow = await db.auditEvent.findFirst({
      where: { action: "METRIC_RETENTION_PRUNED", createdAt: { gte: testStartedAt } },
      select: { id: true, afterJson: true },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow!.afterJson ?? "").toContain("RT015-TEST");
  });
});
