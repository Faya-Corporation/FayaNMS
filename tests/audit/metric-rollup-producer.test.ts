/**
 * RT-002 / F-002 — MetricRollup runtime producer.
 *
 * ADR-07 ("raw samples + rollups") was half-built: MetricRollup had exactly
 * one writer — the demo seed — so every 24H/7D/30D performance view, the
 * capacity forecast, the availability/CAPACITY reports and the dashboard
 * utilization trend read seed-only or empty data in any real deployment.
 *
 * These tests pin the new producer end to end:
 *   - the engine (src/lib/performance/rollup.ts) aggregates CLOSED
 *     5M/1H/1D buckets from raw MetricSamples (exact avg/max/min, nearest-
 *     rank p95, UTC-aligned periodStart), is idempotent on re-run
 *     (natural-key upsert — no duplicate rows), skips open buckets and
 *     converges a bounded backfill over runs (remaining → 0);
 *   - the evaluate-in-Next route / machine surface / tick scheduler /
 *     worker driver / completion contract are wired (source contracts,
 *     same style as tests/flow-retention-api.test.ts).
 *
 * DB-backed cases scope the aggregation to a dedicated throwaway device
 * (runRollupAggregation({ deviceIds: [id] })) so the shared demo fleet is
 * never touched; the device row is removed in afterAll (the Device FK
 * cascade reclaims its samples and rollups).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { db } from "../../src/lib/db";
import {
  ROLLUP_GRANULARITIES,
  ROLLUP_MAX_GROUPS_PER_RUN,
  isBucketClosed,
  rollupBucketStart,
  runRollupAggregation,
  type RollupSummary,
} from "../../src/lib/performance/rollup";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const VENDOR_KEY = "rollup-test-vendor";
const HOSTNAME = "rollup-test-device";

/* Deterministic sample set (all inside CLOSED buckets — placed 2 UTC days
 * back so even the 1D window has fully closed). base = 10:00 UTC of that day:
 *   5M bucket [base,        base +  5m):  10, 20, 30, 40 → avg 25, max 40, min 10, p95 40
 *   5M bucket [base + 30m,  base + 35m):  50, 60         → avg 55, max 60, min 50, p95 60
 *   1H bucket [base,        base +  1h):  all six       → avg 35, max 60, min 10, p95 60
 *   1D bucket [day,         day  + 24h):  all six       → avg 35, max 60, min 10, p95 60
 * Plus one sample inside the CURRENT (open) 5M bucket → never aggregated. */
let deviceId = "";
let dayStart = 0;
let base = 0;
let open5mStart = 0;

beforeAll(async () => {
  const vendor = await db.vendor.upsert({
    where: { key: VENDOR_KEY },
    update: {},
    create: { key: VENDOR_KEY, name: "Rollup Test Vendor", adapterKey: "generic" },
  });
  const device = await db.device.upsert({
    where: { hostname: HOSTNAME },
    update: {},
    create: { hostname: HOSTNAME, mgmtIp: "192.0.2.77", vendorId: vendor.id },
  });
  deviceId = device.id;

  const nowMs = Date.now();
  dayStart =
    Math.floor((nowMs - 2 * DAY_MS) / DAY_MS) * DAY_MS; // UTC midnight, 2 days back
  base = dayStart + 10 * HOUR_MS;
  open5mStart = Math.floor(nowMs / (5 * 60_000)) * (5 * 60_000);

  await db.metricSample.deleteMany({ where: { deviceId } });
  await db.metricRollup.deleteMany({ where: { deviceId } });
  const at = (offsetMs: number) => new Date(base + offsetMs);
  const samples = [
    { deviceId, metric: "CPU", value: 10, ts: at(0) },
    { deviceId, metric: "CPU", value: 20, ts: at(60_000) },
    { deviceId, metric: "CPU", value: 30, ts: at(120_000) },
    { deviceId, metric: "CPU", value: 40, ts: at(240_000) },
    { deviceId, metric: "CPU", value: 50, ts: at(30 * 60_000) },
    { deviceId, metric: "CPU", value: 60, ts: at(31 * 60_000) },
    // Open-bucket sample — must never produce a rollup row.
    { deviceId, metric: "CPU", value: 999, ts: new Date(open5mStart + 5_000) },
  ];
  await db.metricSample.createMany({ data: samples });
});

afterAll(async () => {
  // Device FK cascade reclaims samples + rollups.
  await db.device.deleteMany({ where: { hostname: HOSTNAME } });
  await db.vendor.deleteMany({ where: { key: VENDOR_KEY } });
});

async function rollupsFor(granularity: string) {
  return db.metricRollup.findMany({
    where: { deviceId, metric: "CPU", granularity },
    orderBy: { periodStart: "asc" },
  });
}

describe("rollup aggregation engine (MetricSample → MetricRollup)", () => {
  test("aggregates closed 5M/1H/1D buckets from raw samples", async () => {
    const summary = await runRollupAggregation({ deviceIds: [deviceId] });
    expect(summary.groupsUpserted).toBe(4); // 2× 5M + 1× 1H + 1× 1D
    expect(summary.remaining).toBe(0);
    expect(summary.bounded).toBe(false);

    const fivem = await rollupsFor("5M");
    expect(fivem).toHaveLength(2);
    const first = fivem.find((r) => r.periodStart.getTime() === base);
    expect(first).toMatchObject({ avg: 25, max: 40, min: 10, p95: 40 });
    const second = fivem.find((r) => r.periodStart.getTime() === base + 30 * 60_000);
    expect(second).toMatchObject({ avg: 55, max: 60, min: 50, p95: 60 });

    const hour = await rollupsFor("1H");
    expect(hour).toHaveLength(1);
    expect(hour[0].periodStart.getTime()).toBe(base);
    expect(hour[0]).toMatchObject({ avg: 35, max: 60, min: 10, p95: 60 });

    const day = await rollupsFor("1D");
    expect(day).toHaveLength(1);
    expect(day[0].periodStart.getTime()).toBe(dayStart);
    expect(day[0]).toMatchObject({ avg: 35, max: 60, min: 10, p95: 60 });
  });

  test("is idempotent on re-run (no duplicate rows, same numbers)", async () => {
    const before = await Promise.all([
      rollupsFor("5M"),
      rollupsFor("1H"),
      rollupsFor("1D"),
    ]);
    const summary = await runRollupAggregation({ deviceIds: [deviceId] });
    // Buckets already correct → nothing written, nothing left over.
    expect(summary.groupsUpserted).toBe(0);
    expect(summary.remaining).toBe(0);
    const after = await Promise.all([
      rollupsFor("5M"),
      rollupsFor("1H"),
      rollupsFor("1D"),
    ]);
    expect(after.flat().map((r) => r.id)).toEqual(before.flat().map((r) => r.id));
    for (let i = 0; i < before.flat().length; i += 1) {
      expect(after.flat()[i]).toMatchObject({
        avg: before.flat()[i].avg,
        max: before.flat()[i].max,
        min: before.flat()[i].min,
        p95: before.flat()[i].p95,
      });
    }
  });

  test("never aggregates a bucket whose window has not closed", async () => {
    await runRollupAggregation({ deviceIds: [deviceId] });
    const all = await db.metricRollup.findMany({ where: { deviceId } });
    const starts = new Set(all.map((r) => `${r.granularity}:${r.periodStart.getTime()}`));
    expect(starts.has(`5M:${open5mStart}`)).toBe(false);
    expect(starts.has(`1H:${Math.floor(Date.now() / HOUR_MS) * HOUR_MS}`)).toBe(false);
    expect(starts.has(`1D:${Math.floor(Date.now() / DAY_MS) * DAY_MS}`)).toBe(false);
    expect(all.every((r) => r.avg !== 999)).toBe(true);
  });

  test("bounded run reports remaining and converges over repeated runs", async () => {
    // Start from a clean slate so the backfill is observable.
    await db.metricRollup.deleteMany({ where: { deviceId } });
    const cap = 2;
    const runs: RollupSummary[] = [];
    for (let i = 0; i < 5; i += 1) {
      const run = await runRollupAggregation({ deviceIds: [deviceId], maxGroups: cap });
      runs.push(run);
      if (run.remaining === 0) break;
    }
    expect(runs[0].bounded).toBe(true);
    expect(runs[0].groupsUpserted).toBe(cap);
    expect(runs[0].remaining).toBe(2);
    expect(runs.at(-1)?.remaining).toBe(0);
    const total = await db.metricRollup.count({ where: { deviceId } });
    expect(total).toBe(4); // converged, no duplicates
  });
});

describe("bucket math (pure)", () => {
  test("rollupBucketStart is UTC-aligned per granularity", () => {
    expect(ROLLUP_GRANULARITIES).toEqual(["5M", "1H", "1D"]);
    const ts = Date.UTC(2026, 8, 21, 10, 7, 43, 123);
    expect(rollupBucketStart(ts, "5M")).toBe(Date.UTC(2026, 8, 21, 10, 5, 0, 0));
    expect(rollupBucketStart(ts, "1H")).toBe(Date.UTC(2026, 8, 21, 10, 0, 0, 0));
    expect(rollupBucketStart(ts, "1D")).toBe(Date.UTC(2026, 8, 21, 0, 0, 0, 0));
  });

  test("isBucketClosed treats the exact window end as closed", () => {
    expect(isBucketClosed(1_000, "5M", 1_000 + 300_000)).toBe(true);
    expect(isBucketClosed(1_000, "5M", 999 + 300_000)).toBe(false);
  });

  test("the per-run cap constant is bounded", () => {
    expect(ROLLUP_MAX_GROUPS_PER_RUN).toBe(5_000);
  });
});

/* ── wiring contracts ─────────────────────────────────────────────────── */

const compact = (s: string) => s.replace(/\s+/g, " ");

test("a runtime producer for MetricRollup exists in src/ (not only the seed)", () => {
  const engine = readFileSync("src/lib/performance/rollup.ts", "utf8");
  expect(engine).toContain("metricRollup.upsert");
  expect(engine).toContain("ROLLUP_AGGREGATION_COMPLETED");
  expect(engine).toContain("p95: percentile95(");
});

test("aggregate route is dual-gated and overlap-guarded", () => {
  const route = readFileSync("src/app/api/v1/metrics/rollup/aggregate/route.ts", "utf8");
  expect(route).toContain('requireServiceOrPermission(request, "metrics.prune", "metrics")');
  expect(route).toContain('"ROLLUP_THROTTLED"');
  expect(route).toContain("429");
  expect(route).toContain("runRollupAggregation");
});

test("aggregate route rejects anonymous callers", async () => {
  const { POST } = await import("../../src/app/api/v1/metrics/rollup/aggregate/route");
  const response = await POST(new Request("http://localhost/api/v1/metrics/rollup/aggregate", { method: "POST" }));
  expect(response.status).toBe(401);
  const body = await response.json();
  expect(body.success).toBe(false);
});

test("route and machine surface are registered in the proxy", () => {
  const proxy = readFileSync("src/proxy.ts", "utf8");
  expect(proxy.split('"/api/v1/metrics/rollup/aggregate"').length - 1).toBe(2);
  expect(proxy).toContain('"/api/v1/metrics/retention/prune"');
});

test("tick enqueues at most one ROLLUP_AGGREGATION per dedupe window", () => {
  const tick = readFileSync("src/app/api/v1/worker/tick/route.ts", "utf8");
  expect(tick).toContain("ROLLUP_DEDUPE_MIN = 5");
  expect(tick).toContain('type: "ROLLUP_AGGREGATION"');
  // F-052: the five SYSTEM singleton enqueues now run inside the
  // advisory-locked transaction — the dedupe read/create use the tx client.
  expect(tick).toContain("enqueueRollupAggregation(tx, now)");
  expect(tick).toContain("rollupEnqueued");
  // Same dedupe shape as METRIC_RETENTION / FLOW_RETENTION.
  expect(tick).toContain('status: { in: ["QUEUED", "RUNNING"] }');
});

test("worker runner claims and dispatches ROLLUP_AGGREGATION", () => {
  const runner = readFileSync("mini-services/worker/runner.ts", "utf8");
  expect(runner).toContain('job.type === "ROLLUP_AGGREGATION"');
  expect(runner).toContain('"/api/v1/metrics/rollup/aggregate"');
  expect(runner).toContain('triggeredBy: "JOB"');
  // A throttled run is a graceful success (mirrors METRIC_RETENTION).
  expect(runner).toContain("ROLLUP_THROTTLED");
  const claimBody = compact(runner.slice(runner.indexOf("types: ["), runner.indexOf('"] as', runner.indexOf("types: [") + 8)));
  expect(claimBody).toContain('"ROLLUP_AGGREGATION"');
});

test("worker completion contract accepts the rollup summary", () => {
  const complete = readFileSync("src/app/api/v1/worker/complete/route.ts", "utf8");
  expect(complete).toContain('job.type === "ROLLUP_AGGREGATION"');
  expect(complete).toContain('z.enum(["aggregated", "throttled"])');
});
