/**
 * Open-findings batch 17 — F-046 (P3, effort M): alert evaluation N+1.
 *
 *   History: every 3-minute evaluation pass ran one `device.findMany` PER
 *   RULE (R round-trips just to build the (rule, device) pair list), one
 *   `alert.update` PER open breaching pair for the dedup refresh (uncapped —
 *   only NEW fires had a 50-cap), and an unbounded `metricSample.findMany`
 *   for the window averages. Fine at demo scale; degrades linearly with
 *   fleet×rules on any real deployment.
 *
 *   The closure (the BACKLOG plan's three moves, all outcome-preserving):
 *     1. ONE device query + in-memory scope filtering — the old
 *        `ruleDeviceWhere` Prisma-where builder became the exported pure
 *        `ruleDevicePredicate` (SQL-parity NULL/site handling pinned below)
 *        and `resolveRuleDevicePairs` walks the single device list
 *        rule-major, so pair-order semantics are unchanged.
 *     2. Dedup writes batched per write-payload group — `DedupUpdateBatch`
 *        flushes ONE `alert.updateMany` per (decision, suppressReason)
 *        group right after the pair walk; legacy rows still migrating onto
 *        the fingerprint dedupKey keep their exact per-row update (the key
 *        value is row-specific); a re-activated AVAILABILITY root is
 *        tracked in `pendingReactivatedRoots` so later `openRootExists`
 *        checks in the same pass see it exactly when the old inline write
 *        made it visible (RT-001 semantics untouched).
 *     3. Sample load row-capped at MAX_SAMPLES_PER_QUERY (20 000) — newest
 *        rows win (orderBy ts desc + take), `indexSamples` restores the
 *        ascending per-series structure; a truncated load can only drop
 *        previous-window rows, which lands in pass 2's documented
 *        sparse-data skip (never a false fire or false resolve).
 *
 *   Rig notes: the engine's DB is the shared live demo fleet (see RT-001's
 *   suite header), so a full runAlertEvaluation() pass would mutate
 *   unrelated demo alerts — the engine wiring is pinned by source contracts
 *   here (mirroring tests/audit/alert-suppression-reactivation.test.ts),
 *   while the extracted pure units (scope predicate, pair resolver, dedup
 *   batch, sample indexer) are behavior-pinned directly, including a
 *   per-row-vs-batched write parity simulation over a representative
 *   decision matrix (touch / ack / window-suppress / reactivate /
 *   unknown-suppression, plus the children-sweep interaction).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DedupUpdateBatch,
  MAX_SAMPLES_PER_QUERY,
  ROOT_SUPPRESS_PREFIX,
  indexSamples,
  resolveRuleDevicePairs,
  ruleDevicePredicate,
  type DedupUpdateGroupData,
  type EvalDevice,
  type EvalRule,
  type SampleRow,
} from "../../src/lib/alerts/evaluate";

/* ── fixtures ─────────────────────────────────────────────────────────── */

const NOW = new Date("2026-01-01T12:00:00Z");

const rule = (over: Partial<EvalRule> = {}): EvalRule => ({
  id: "r1",
  name: "cpu-hot",
  metric: "CPU",
  operator: "GT",
  threshold: 90,
  durationMinutes: 15,
  severity: "HIGH",
  ...over,
});

const device = (over: Partial<EvalDevice> = {}): EvalDevice => ({
  id: "d1",
  hostname: "h1",
  status: "ONLINE",
  lastSeen: NOW,
  siteId: "s1",
  criticality: "HIGH",
  role: "CORE_ROUTER",
  siteCode: "HQ",
  ...over,
});

const scopedRule = (base: EvalRule, scopeJson: string | null) => ({
  ...base,
  scopeJson,
});

/* ── 1. single device query: in-memory scope resolution (F-046 #1) ────── */

describe("F-046 scope resolution — one device query, in-memory filter", () => {
  test("non-AVAILABILITY rules exclude OFFLINE and UNMANAGED, keep the rest", () => {
    const matches = ruleDevicePredicate(rule(), null);
    expect(matches(device())).toBe(true);
    expect(matches(device({ status: "OFFLINE" }))).toBe(false);
    expect(matches(device({ status: "UNMANAGED" }))).toBe(false);
    expect(matches(device({ status: "DEGRADED" }))).toBe(true);
    expect(matches(device({ status: "MAINTENANCE" }))).toBe(true);
  });

  test("AVAILABILITY rules keep OFFLINE devices (they are exactly its target)", () => {
    const matches = ruleDevicePredicate(rule({ metric: "AVAILABILITY" }), null);
    expect(matches(device({ status: "OFFLINE" }))).toBe(true);
    expect(matches(device({ status: "UNMANAGED" }))).toBe(false);
  });

  test("siteCodes filter matches by site code; siteless devices stay out (SQL IN/NULL parity)", () => {
    const matches = ruleDevicePredicate(
      rule(),
      JSON.stringify({ siteCodes: ["HQ"] })
    );
    expect(matches(device({ siteCode: "HQ", siteId: "s1" }))).toBe(true);
    expect(matches(device({ siteCode: "BR", siteId: "s2" }))).toBe(false);
    // a device with no site at all never matched `site: { code: { in } }`.
    expect(matches(device({ siteCode: null, siteId: null }))).toBe(false);
  });

  test('siteCodes "*" (and absent scope) includes siteless devices', () => {
    const wildcard = ruleDevicePredicate(
      rule(),
      JSON.stringify({ siteCodes: ["*"] })
    );
    const noScope = ruleDevicePredicate(rule(), null);
    for (const matches of [wildcard, noScope]) {
      expect(matches(device({ siteCode: null, siteId: null }))).toBe(true);
      expect(matches(device({ siteCode: "ANY" }))).toBe(true);
    }
  });

  test("criticalities filter (canonical + legacy singular key) and NULL parity", () => {
    const canonical = ruleDevicePredicate(
      rule(),
      JSON.stringify({ criticalities: ["CRITICAL"] })
    );
    const legacy = ruleDevicePredicate(
      rule(),
      JSON.stringify({ criticality: ["CRITICAL"] })
    );
    for (const matches of [canonical, legacy]) {
      expect(matches(device({ criticality: "CRITICAL" }))).toBe(true);
      expect(matches(device({ criticality: "HIGH" }))).toBe(false);
    }
  });

  test("deviceRoles filter excludes roleless devices (SQL IN/NULL parity)", () => {
    const matches = ruleDevicePredicate(
      rule(),
      JSON.stringify({ deviceRoles: ["EDGE_ROUTER"] })
    );
    expect(matches(device({ role: "EDGE_ROUTER" }))).toBe(true);
    expect(matches(device({ role: "CORE_ROUTER" }))).toBe(false);
    expect(matches(device({ role: null }))).toBe(false);
  });

  test("malformed scopeJson degrades to status-only filtering", () => {
    const matches = ruleDevicePredicate(rule(), "{definitely not json");
    expect(matches(device())).toBe(true);
    expect(matches(device({ siteCode: null, role: null }))).toBe(true);
    expect(matches(device({ status: "OFFLINE" }))).toBe(false);
  });

  test("resolveRuleDevicePairs builds rule-major pairs + the union device map", () => {
    const rules = [
      scopedRule(rule({ id: "r-cpu", metric: "CPU" }), JSON.stringify({ siteCodes: ["HQ"] })),
      scopedRule(rule({ id: "r-av", metric: "AVAILABILITY" }), null),
    ];
    const devices = [
      device({ id: "d1", siteCode: "HQ" }),
      device({ id: "d2", siteCode: "HQ", status: "OFFLINE" }),
      device({ id: "d3", siteCode: "BR" }),
      device({ id: "d4", siteCode: "HQ", status: "UNMANAGED" }),
    ];

    const { deviceById, pairs } = resolveRuleDevicePairs(rules, devices);

    // rule-major walk: the CPU rule's matches first, then AVAILABILITY's.
    expect(pairs.map(({ rule: r, device: d }) => `${r.id}:${d.id}`)).toEqual([
      "r-cpu:d1", // d2 OFFLINE excluded, d3 site mismatch, d4 UNMANAGED
      "r-av:d1",
      "r-av:d2", // OFFLINE kept for AVAILABILITY
      "r-av:d3",
    ]);
    // union map: every device matched by ≥1 rule, exactly once each.
    expect([...deviceById.keys()].sort()).toEqual(["d1", "d2", "d3"]);
    // (d1 matched by both rules → 2 pairs, 1 map entry — devicesConsidered.)
    expect(deviceById.size).toBe(3);
  });

  test("source pin: the engine resolves scopes from ONE device query", () => {
    const source = readFileSync("src/lib/alerts/evaluate.ts", "utf8");
    const compact = source.replace(/\s+/g, " ");
    // the old per-rule query loop is gone — exactly one device.findMany.
    expect((source.match(/db\.device\.findMany/g) ?? []).length).toBe(1);
    expect(source).not.toContain("ruleDeviceWhere");
    // the single query feeds the in-memory resolver with the filter inputs.
    expect(compact).toContain("resolveRuleDevicePairs(rules, scopedDevices)");
    expect(compact).toContain("criticality: true");
    expect(compact).toContain("role: true");
    expect(compact).toContain("site: { select: { code: true } }");
  });
});

/* ── 2. batched dedup writes (F-046 #2) ───────────────────────────────── */

const recordingExecutor = () => {
  const calls: Array<{ ids: string[]; data: DedupUpdateGroupData }> = [];
  return {
    calls,
    executor: {
      updateMany: async (args: {
        where: { id: { in: string[] } };
        data: DedupUpdateGroupData;
      }) => {
        calls.push({ ids: [...args.where.id.in], data: args.data });
        return { count: args.where.id.in.length };
      },
    },
  };
};

describe("F-046 dedup write batching — one updateMany per payload group", () => {
  test("same-payload rows (ACTIVE/ACK/SUPPRESSED touches) collapse into ONE updateMany", async () => {
    const batch = new DedupUpdateBatch();
    const touch = { lastSeen: NOW, count: { increment: 1 } };
    batch.add("dedup:touch", touch, "a1");
    batch.add("dedup:touch", touch, "a2");
    batch.add("dedup:touch", touch, "a3");

    const { calls, executor } = recordingExecutor();
    expect(await batch.flush(executor)).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].ids).toEqual(["a1", "a2", "a3"]);
    expect(calls[0].data).toEqual(touch);
  });

  test("window suppression groups per window NAME (the reason embeds it)", async () => {
    const batch = new DedupUpdateBatch();
    const windowData = (name: string) => ({
      status: "SUPPRESSED",
      suppressReason: `Maintenance window: ${name}`,
      lastSeen: NOW,
      count: { increment: 1 },
    });
    batch.add("suppress:window:win-a", windowData("win-a"), "a1");
    batch.add("suppress:window:win-a", windowData("win-a"), "a2");
    batch.add("suppress:window:win-b", windowData("win-b"), "a3");

    const { calls, executor } = recordingExecutor();
    expect(await batch.flush(executor)).toBe(2);
    expect(calls.map((c) => c.ids)).toEqual([["a1", "a2"], ["a3"]]);
    expect(calls[0].data.status).toBe("SUPPRESSED");
    expect(calls[0].data.suppressReason).toBe("Maintenance window: win-a");
    expect(calls[1].data.suppressReason).toBe("Maintenance window: win-b");
  });

  test("reactivation group carries the exact RT-001 outcome payload", async () => {
    const batch = new DedupUpdateBatch();
    batch.add("reactivate:root-release", {
      status: "ACTIVE",
      suppressReason: null,
      parentAlertId: null,
      lastSeen: NOW,
      count: { increment: 1 },
    }, "child-1");

    const { calls, executor } = recordingExecutor();
    expect(await batch.flush(executor)).toBe(1);
    expect(calls[0]).toEqual({
      ids: ["child-1"],
      data: {
        status: "ACTIVE",
        suppressReason: null,
        parentAlertId: null,
        lastSeen: NOW,
        count: { increment: 1 },
      },
    });
  });

  test("empty buffer flushes nothing", async () => {
    const batch = new DedupUpdateBatch();
    expect(batch.groupCount).toBe(0);
    const { calls, executor } = recordingExecutor();
    expect(await batch.flush(executor)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  /* Outcome parity: the pre-F-046 engine applied one alert.update PER pair,
   * inline; the F-046 engine buffers identical payloads and flushes them as
   * one updateMany per group BEFORE the children sweep. Both strategies must
   * land every row in the same final state. */
  interface SimRow {
    id: string;
    status: string;
    suppressReason: string | null;
    parentAlertId: string | null;
    lastSeen: Date | null;
    count: number;
    dedupKey: string | null;
  }

  const newRow = (id: string, status: string, suppressReason: string | null): SimRow => ({
    id,
    status,
    suppressReason,
    parentAlertId: null,
    lastSeen: null,
    count: 1,
    dedupKey: `${id}:CPU:r1`,
  });

  const applyData = (row: SimRow, data: DedupUpdateGroupData, dedupKey: string) => {
    if (data.status !== undefined) row.status = data.status;
    if (data.suppressReason !== undefined) row.suppressReason = data.suppressReason;
    if (data.parentAlertId !== undefined) row.parentAlertId = data.parentAlertId;
    if (data.lastSeen) row.lastSeen = data.lastSeen;
    if (data.count) row.count += data.count.increment;
    if (dedupKey !== "") row.dedupKey = dedupKey;
  };

  /** The old strategy: one awaited per-row update per decision. */
  const runPerRow = (rows: SimRow[], decisions: Array<{ row: SimRow; data: DedupUpdateGroupData }>) => {
    for (const { row, data } of decisions) applyData(row, data, row.dedupKey ?? "");
  };

  /** The new strategy: buffer into payload groups, flush once per group. */
  const runBatched = async (
    rows: SimRow[],
    decisions: Array<{ row: SimRow; groupKey: string; data: DedupUpdateGroupData }>
  ) => {
    const batch = new DedupUpdateBatch();
    for (const { row, groupKey, data } of decisions) {
      batch.add(groupKey, data, row.id);
    }
    const { calls, executor } = recordingExecutor();
    await batch.flush(executor);
    for (const call of calls) {
      for (const id of call.ids) {
        const row = rows.find((r) => r.id === id);
        if (row) applyData(row, call.data, "");
      }
    }
    return calls.length;
  };

  test("representative matrix: per-row writes and batched groups reach identical states", async () => {
    const touch = { lastSeen: NOW, count: { increment: 1 } };
    const windowData = (name: string) => ({
      status: "SUPPRESSED",
      suppressReason: `Maintenance window: ${name}`,
      lastSeen: NOW,
      count: { increment: 1 },
    });
    const reactivate = {
      status: "ACTIVE",
      suppressReason: null,
      parentAlertId: null,
      lastSeen: NOW,
      count: { increment: 1 },
    };
    const buildDecisions = () => {
      const rows = [
        newRow("r1", "ACTIVE", null), // plain touch (ACTIVE)
        newRow("r2", "ACKNOWLEDGED", null), // ack touch
        newRow("r3", "ACTIVE", null), // ACTIVE + window win-a
        newRow("r4", "ACTIVE", null), // ACTIVE + window win-b
        newRow("r5", "SUPPRESSED", `${ROOT_SUPPRESS_PREFIX}root-9`), // RT-001 reactivation
        newRow("r6", "SUPPRESSED", "Manual: operator"), // unknown reason → touch only
      ];
      return {
        rows,
        perRow: [
          { row: rows[0], data: touch },
          { row: rows[1], data: touch },
          { row: rows[2], data: windowData("win-a") },
          { row: rows[3], data: windowData("win-b") },
          { row: rows[4], data: reactivate },
          { row: rows[5], data: touch },
        ],
        batched: [
          { row: rows[0], groupKey: "dedup:touch", data: touch },
          { row: rows[1], groupKey: "dedup:touch", data: touch },
          { row: rows[2], groupKey: "suppress:window:win-a", data: windowData("win-a") },
          { row: rows[3], groupKey: "suppress:window:win-b", data: windowData("win-b") },
          { row: rows[4], groupKey: "reactivate:root-release", data: reactivate },
          { row: rows[5], groupKey: "dedup:touch", data: touch },
        ],
      };
    };

    // Old engine: 6 breaching pairs → 6 round-trips.
    const oldRun = buildDecisions();
    runPerRow(oldRun.rows, oldRun.perRow);

    // New engine: same decisions → 4 group writes (touch, win-a, win-b,
    // reactivate), flushed before the children sweep.
    const newRun = buildDecisions();
    const batchedWrites = await runBatched(newRun.rows, newRun.batched);
    expect(batchedWrites).toBe(4);

    // Children sweep analogue (the engine flushes BEFORE the sweep): an
    // unreachable device's ACTIVE alert gets SUPPRESSED by its root — the
    // touch group deliberately carries no status so the sweep still wins.
    const sweep = (rows: SimRow[]) => {
      const r1 = rows.find((r) => r.id === "r1");
      if (r1 && r1.status === "ACTIVE") {
        r1.status = "SUPPRESSED";
        r1.suppressReason = `${ROOT_SUPPRESS_PREFIX}root-9`;
        r1.parentAlertId = "root-9";
      }
    };
    sweep(oldRun.rows);
    sweep(newRun.rows);

    expect(newRun.rows).toEqual(oldRun.rows);
    // spot-check the reactivation parity explicitly (RT-001 outcome):
    const reactivated = newRun.rows.find((r) => r.id === "r5");
    expect(reactivated).toMatchObject({
      status: "ACTIVE",
      suppressReason: null,
      parentAlertId: null,
      count: 2,
    });
  });

  test("source pin: the engine buffers dedup writes and flushes before the children sweep", () => {
    const source = readFileSync("src/lib/alerts/evaluate.ts", "utf8");
    const compact = source.replace(/\s+/g, " ");
    // pass-1 dedup branches route through the buffer helper…
    expect((compact.match(/await bufferDedupWrite\(/g) ?? []).length).toBe(4);
    // …with the legacy dedupKey migration kept as the exact per-row update.
    expect(compact).toContain("if (existing.dedupKey !== key)");
    expect(compact).toContain("data: { ...data, dedupKey: key }");
    // flushed before the children sweep, after the pair walk.
    const flushAt = source.indexOf("await dedupBatch.flush(db.alert);");
    const sweepAt = source.indexOf("children sweep: existing ACTIVE alerts");
    expect(flushAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(flushAt);
  });

  test("source pin: RT-001 reactivation visibility survives the batching", () => {
    const source = readFileSync("src/lib/alerts/evaluate.ts", "utf8");
    const compact = source.replace(/\s+/g, " ");
    // The re-activated AVAILABILITY root is registered where the old inline
    // write made it DB-visible — later openRootExists checks must see it.
    expect(compact).toContain("pendingReactivatedRoots.has(device.id)");
    expect(compact).toContain("pendingReactivatedRoots.add(device.id)");
    // The RT-001 decision call itself is byte-identical.
    expect(compact).toContain(
      "shouldReactivateSuppressedRow( existing.status, existing.suppressReason, maintenanceFor(device) !== null, await openRootExists(device) )"
    );
    // The reactivation payload still clears suppression + parent link.
    const start = compact.indexOf("shouldReactivateSuppressedRow( existing.status");
    const reactivateBlock = compact.slice(start, start + 1_200);
    expect(reactivateBlock).toContain('status: "ACTIVE"');
    expect(reactivateBlock).toContain("suppressReason: null");
    expect(reactivateBlock).toContain("parentAlertId: null");
  });
});

/* ── 3. sample load take cap (F-046 #3) ───────────────────────────────── */

describe("F-046 sample load cap", () => {
  test("cap value: 20 000 rows — documented headroom over any rule window", () => {
    // 5-min cadence ⇒ 20 000 rows ≈ 69 days of continuous history for ONE
    // (device, metric) series; every rule window is minutes-to-hours.
    expect(MAX_SAMPLES_PER_QUERY).toBe(20_000);
  });

  test("source pin: the sample query is row-bounded, newest rows first", () => {
    const source = readFileSync("src/lib/alerts/evaluate.ts", "utf8");
    expect(source).toContain("orderBy: { ts: \"desc\" }");
    expect(source).toContain("take: MAX_SAMPLES_PER_QUERY");
    expect(source).toContain("samplesByDeviceMetric = indexSamples(samples)");
  });

  test("indexSamples restores the ascending per-series order from the desc fetch", () => {
    const samples: SampleRow[] = [
      { deviceId: "d1", metric: "CPU", value: 30, ts: new Date("2026-01-01T12:10:00Z") },
      { deviceId: "d1", metric: "CPU", value: 20, ts: new Date("2026-01-01T12:05:00Z") },
      { deviceId: "d1", metric: "CPU", value: 10, ts: new Date("2026-01-01T12:00:00Z") },
      { deviceId: "d2", metric: "MEMORY", value: 50, ts: new Date("2026-01-01T12:05:00Z") },
    ];
    const indexed = indexSamples(samples);
    expect([...indexed.keys()].sort()).toEqual(["d1:CPU", "d2:MEMORY"]);
    const cpu = indexed.get("d1:CPU") ?? [];
    expect(cpu.map((s) => s.value)).toEqual([10, 20, 30]); // asc, per series
  });

  test("behavior AT the cap: the oldest row is the one dropped, newest kept, asc restored", () => {
    // Build cap+1 rows ascending; the capped query (orderBy ts desc + take)
    // returns the newest MAX rows newest-first — exactly the desc slice.
    const total = MAX_SAMPLES_PER_QUERY + 1;
    const ascending: SampleRow[] = Array.from({ length: total }, (_, i) => ({
      deviceId: "d-cap",
      metric: "CPU",
      value: i,
      ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)), // 1-second cadence for the test
    }));
    const cappedFetch = [...ascending].reverse().slice(0, MAX_SAMPLES_PER_QUERY);

    const indexed = indexSamples(cappedFetch);
    const list = indexed.get("d-cap:CPU") ?? [];
    expect(list).toHaveLength(MAX_SAMPLES_PER_QUERY);
    expect(list[0]?.value).toBe(1); // row 0 (oldest) dropped
    expect(list[list.length - 1]?.value).toBe(total - 1); // newest kept
    // ascending restored in memory despite the desc fetch
    expect(list[0]!.ts.getTime()).toBeLessThan(list[list.length - 1]!.ts.getTime());

    // window math parity: the average over the kept rows is identical to
    // ascending indexing of the same newest rows (order-independence).
    const ascOfSameRows = indexSamples([...cappedFetch].reverse());
    const avg = (rows: Array<{ value: number }>) =>
      rows.reduce((sum, s) => sum + s.value, 0) / rows.length;
    expect(avg(list)).toBe(avg(ascOfSameRows.get("d-cap:CPU") ?? []));
  });
});
