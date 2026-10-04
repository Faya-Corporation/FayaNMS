/**
 * Open-findings batch 22 — F-047 (P3, A3-11): unbounded ops tables / search
 * cost.
 *
 *   Four operational tables had no retention at all (AuditEvent,
 *   Notification, JobExecution, DiscoveryObservation — only
 *   RateLimitHit/LoginGuardState were ever swept), and the events search
 *   paid a stale-contract tax on top: the docstring still claimed "SQLite
 *   LIKE is case-insensitive" on a Postgres provider while `q` had silently
 *   become case-sensitive (Prisma `contains` → Postgres `LIKE`).
 *
 *   The closure (the BACKLOG plan's named decisions):
 *     1. Setting-backed ops-data retention sweep ("opsData.retention") for
 *        the three NON-append-only ops tables — terminal JobExecutions
 *        (30 d default), read Notifications (30 d), aged
 *        DiscoveryObservations (90 d) — tick-gated with the RT-016
 *        due-ness pattern (24 h, in-memory primary + persisted Setting
 *        fallback), chunked like RT-003 (≤ 1,000 rows/statement, ≤ 10,000
 *        rows/table/run, guarded deletes, one OPS_DATA_PRUNED summary audit
 *        row per run). AuditEvent is EXPLICITLY out of scope: it is the
 *        append-only, chain-stamped audit trail (RT-012/RT-013) — no
 *        retention timer may ever delete audit history.
 *     2. `q` case-insensitivity decided: `mode: "insensitive"` on all 17
 *        contains filters (ILIKE), the stale SQLite claim removed, and the
 *        cost honestly documented (bounded page size keeps it acceptable);
 *        the dedicated search column / pg_trgm GIN index stays a NAMED
 *        follow-up (ADR-events-search-contract.md), not a schema change.
 *
 *   Test style: pure pins for policy/gates, DB-backed pins for the sweep on
 *   SYNTHETIC FIXTURES ONLY (1990-anchored rows + a Setting override to
 *   3650-day windows, so the shared demo data is provably out of scope —
 *   the pre-seed foreign-row guard re-verifies it at runtime), and source
 *   pins for the tick wiring, the AuditEvent exclusion, the FK SetNull
 *   safety and the events search contract.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { db } from "../../src/lib/db";
import {
  DEFAULT_OPS_DATA_RETENTION,
  OPS_DATA_CHUNK_SIZE,
  OPS_DATA_DEDUPE_HOURS,
  OPS_DATA_MAX_DELETES_PER_RUN,
  OPS_DATA_RETENTION_KEY,
  TERMINAL_JOB_EXECUTION_STATUSES,
  deleteDiscoveryObservationsChunked,
  deleteReadNotificationsChunked,
  deleteTerminalJobExecutionsChunked,
  isJobExecutionExpired,
  isOpsDataPruneDue,
  markOpsDataPruned,
  opsDataCutoff,
  parseStoredOpsDataRetention,
  pruneOpsData,
  resetOpsDataPruneGateForTests,
} from "../../src/lib/ops/retention";

const DAY_MS = 86_400_000;
const JOB_CORR = "OPSRT-TEST-JOB";
const BULK_CORR = "OPSRT-BULK-JOB";
const OBS_CORR = "OPSRT-TEST-OBS";
const NOTIF_TITLE = "opsrt-test-notification";

/** 1990-anchored fixtures — older than anything a demo/CI seed can hold. */
const ANCIENT = new Date(Date.parse("1990-01-01T00:00:00Z"));
const ANCIENT_2 = new Date(Date.parse("1990-06-15T00:00:00Z"));
const BULK_ANCIENT = new Date(Date.parse("1991-01-01T00:00:00Z"));

const testStartedAt = new Date();
let settingSnapshot: { key: string; valueJson: string } | null = null;

/** The sweep test's Setting override: 3650-day windows → ~2016 cutoff. */
const WIDE_OVERRIDE = {
  jobExecutionDays: 3650,
  notificationDays: 3650,
  discoveryObservationDays: 3650,
  enabled: true,
};

async function upsertSetting(policy: object): Promise<void> {
  await db.setting.upsert({
    where: { key: OPS_DATA_RETENTION_KEY },
    update: { valueJson: JSON.stringify(policy) },
    create: { key: OPS_DATA_RETENTION_KEY, valueJson: JSON.stringify(policy) },
  });
}

function jobRow(overrides: Record<string, unknown> = {}) {
  return {
    type: "SNMP_POLL",
    correlationId: JOB_CORR,
    ...overrides,
  };
}

async function seedJob(overrides: Record<string, unknown> = {}) {
  return db.jobExecution.create({ data: jobRow(overrides) });
}

async function seedBulkJobs(count: number): Promise<void> {
  const rows = Array.from({ length: count }, (_, i) =>
    jobRow({
      status: "SUCCEEDED",
      finishedAt: new Date(BULK_ANCIENT.getTime() + i),
      correlationId: BULK_CORR,
    })
  );
  for (let i = 0; i < rows.length; i += 2_500) {
    await db.jobExecution.createMany({ data: rows.slice(i, i + 2_500) });
  }
}

async function seedNotification(overrides: Record<string, unknown> = {}) {
  return db.notification.create({
    data: {
      kind: "SYSTEM",
      title: NOTIF_TITLE,
      body: "F-047 retention sweep synthetic fixture",
      ...overrides,
    },
  });
}

async function seedObservation(observedAt: Date) {
  return db.discoveryObservation.create({
    data: {
      correlationId: OBS_CORR,
      subnet: "192.0.2.0/24",
      ip: "192.0.2.99",
      hostname: "opsrt-test-host",
      reachable: true,
      openPortsJson: "[]",
      protocolsJson: "[]",
      confidence: 50,
      osFingerprint: "unknown",
      observedAt,
    },
  });
}

/**
 * Demo-data safety guard: with the ~2016 cutoff the sweep must find ZERO
 * pre-existing candidates. Re-verified at runtime so the live sweep test
 * can never delete shared demo rows, on this sandbox or anywhere else.
 */
async function foreignCandidatesAt(cut: Date): Promise<{
  jobs: number;
  notifications: number;
  observations: number;
}> {
  return {
    jobs: await db.jobExecution.count({
      where: { status: { in: TERMINAL_JOB_EXECUTION_STATUSES }, finishedAt: { lt: cut } },
    }),
    notifications: await db.notification.count({ where: { readAt: { lt: cut } } }),
    observations: await db.discoveryObservation.count({ where: { observedAt: { lt: cut } } }),
  };
}

beforeAll(async () => {
  settingSnapshot = await db.setting.findUnique({
    where: { key: OPS_DATA_RETENTION_KEY },
    select: { key: true, valueJson: true },
  });
  // Leftovers from an aborted earlier run must never skew the counts.
  await db.jobExecution.deleteMany({ where: { correlationId: { startsWith: "OPSRT-" } } });
  await db.notification.deleteMany({ where: { title: { startsWith: NOTIF_TITLE } } });
  await db.discoveryObservation.deleteMany({ where: { correlationId: { startsWith: OBS_CORR } } });
  resetOpsDataPruneGateForTests();
});

afterAll(async () => {
  resetOpsDataPruneGateForTests();
  await db.jobExecution.deleteMany({ where: { correlationId: { startsWith: "OPSRT-" } } });
  await db.notification.deleteMany({ where: { title: { startsWith: NOTIF_TITLE } } });
  await db.discoveryObservation.deleteMany({ where: { correlationId: { startsWith: OBS_CORR } } });
  // The summary audit rows this suite created (OPS_DATA_PRUNED did not
  // exist before this batch, and the gte bound keeps the delete surgical).
  await db.auditEvent.deleteMany({
    where: { action: "OPS_DATA_PRUNED", createdAt: { gte: testStartedAt } },
  });
  // Restore the pre-test "opsData.retention" Setting exactly as found.
  if (settingSnapshot) {
    await db.setting.update({
      where: { key: OPS_DATA_RETENTION_KEY },
      data: { valueJson: settingSnapshot.valueJson },
    });
  } else {
    await db.setting.deleteMany({ where: { key: OPS_DATA_RETENTION_KEY } });
  }
});

/* ── policy resolution: defaults, overrides, corruption tolerance ───────── */

describe("F-047 ops-data retention policy (pure)", () => {
  test("defaults are the documented ones (30d / 30d / 90d, enabled)", () => {
    expect(DEFAULT_OPS_DATA_RETENTION).toEqual({
      jobExecutionDays: 30,
      notificationDays: 30,
      discoveryObservationDays: 90,
      enabled: true,
    });
    const fallback = parseStoredOpsDataRetention(null);
    expect(fallback).toMatchObject({
      jobExecutionDays: 30,
      notificationDays: 30,
      discoveryObservationDays: 90,
      enabled: true,
      lastPrunedAt: null,
      lastPruneResult: null,
    });
    // An ABSENT Setting row resolves to the same defaults (operator sees
    // the documented behavior; the sweep still runs).
    expect(parseStoredOpsDataRetention(undefined)).toEqual(fallback);
  });

  test("the Setting row overrides every knob (operator-overridable)", () => {
    const override = parseStoredOpsDataRetention(
      JSON.stringify({
        jobExecutionDays: 45,
        notificationDays: 60,
        discoveryObservationDays: 120,
        enabled: false,
      })
    );
    expect(override).toMatchObject({
      jobExecutionDays: 45,
      notificationDays: 60,
      discoveryObservationDays: 120,
      enabled: false,
    });
    // Bookkeeping round-trips through the same row (policy AND state).
    const stamped = parseStoredOpsDataRetention(
      JSON.stringify({
        ...WIDE_OVERRIDE,
        lastPrunedAt: "2026-10-03T00:00:00.000Z",
        lastPruneResult: { outcome: "pruned", jobExecutionsDeleted: 3 },
      })
    );
    expect(stamped.lastPrunedAt).toBe("2026-10-03T00:00:00.000Z");
    expect(stamped.lastPruneResult).toMatchObject({ outcome: "pruned" });
  });

  test("corrupt or out-of-contract values never throw — they fall back", () => {
    expect(parseStoredOpsDataRetention("not json").jobExecutionDays).toBe(30);
    expect(parseStoredOpsDataRetention("[]").enabled).toBe(true);
    // Days 0 is below the schema floor → the WHOLE policy falls back (a
    // silent zero-day wipe must be impossible).
    expect(
      parseStoredOpsDataRetention(
        JSON.stringify({ jobExecutionDays: 0, notificationDays: 30, discoveryObservationDays: 90, enabled: true })
      ).jobExecutionDays
    ).toBe(30);
    // Strict schema: unknown fields reject the payload (typo → defaults,
    // never a half-applied policy).
    expect(
      parseStoredOpsDataRetention(
        JSON.stringify({ jobExecutionDays: 45, notificationDays: 45, discoveryObservationDays: 45, enabled: true, jobDays: 45 })
      ).jobExecutionDays
    ).toBe(30);
  });

  test("pure expiry rule: terminal jobs age by finishedAt, others never", () => {
    const now = new Date();
    expect(TERMINAL_JOB_EXECUTION_STATUSES).toEqual(["SUCCEEDED", "FAILED", "DEAD", "CANCELLED"]);
    expect(opsDataCutoff(now, 30).getTime()).toBe(now.getTime() - 30 * DAY_MS);
    expect(isJobExecutionExpired("SUCCEEDED", new Date(now.getTime() - 31 * DAY_MS), 30, now)).toBe(true);
    expect(isJobExecutionExpired("SUCCEEDED", new Date(now.getTime() - 29 * DAY_MS), 30, now)).toBe(false);
    for (const status of ["FAILED", "DEAD", "CANCELLED"]) {
      expect(isJobExecutionExpired(status, ANCIENT, 30, now)).toBe(true);
    }
    // QUEUED/RUNNING rows are never candidates, no matter how old.
    for (const status of ["QUEUED", "RUNNING"]) {
      expect(isJobExecutionExpired(status, ANCIENT, 30, now)).toBe(false);
    }
    // A terminal row without a finish timestamp never expires.
    expect(isJobExecutionExpired("SUCCEEDED", null, 30, now)).toBe(false);
  });

  test("sweep bounds are chunked (RT-003 convention)", () => {
    expect(OPS_DATA_CHUNK_SIZE).toBe(1_000);
    expect(OPS_DATA_MAX_DELETES_PER_RUN).toBe(10_000);
    expect(OPS_DATA_DEDUPE_HOURS).toBe(24);
  });
});

/* ── RT-016-style due-ness gate ─────────────────────────────────────────── */

describe("F-047 ops-data retention due-ness gate", () => {
  test("fresh process + no Setting → due; a run stamps both gate layers", async () => {
    resetOpsDataPruneGateForTests();
    await db.setting.deleteMany({ where: { key: OPS_DATA_RETENTION_KEY } });
    const now = new Date();
    expect(await isOpsDataPruneDue(now)).toBe(true);

    await upsertSetting({ ...WIDE_OVERRIDE }); // knobs-only, no lastPrunedAt
    await markOpsDataPruned(now);
    // In-memory primary: one second later the tick is NOT due.
    expect(await isOpsDataPruneDue(new Date(now.getTime() + 1_000))).toBe(false);
    // The Setting fallback was written — and MERGED with the operator's
    // knobs (marking the gate must not clobber the policy).
    const row = await db.setting.findUnique({ where: { key: OPS_DATA_RETENTION_KEY } });
    const stored = parseStoredOpsDataRetention(row?.valueJson);
    expect(stored.lastPrunedAt).not.toBeNull();
    expect(stored.jobExecutionDays).toBe(3650);
    expect(stored.notificationDays).toBe(3650);
    expect(stored.discoveryObservationDays).toBe(3650);
  });

  test("restart safety — a fresh process still skips within the window", async () => {
    const now = new Date();
    await markOpsDataPruned(now);
    resetOpsDataPruneGateForTests(); // simulate restart: in-memory state gone
    expect(await isOpsDataPruneDue(new Date(now.getTime() + 1_000))).toBe(false);
  });

  test("due again after the window; corrupt state never wedges the gate", async () => {
    resetOpsDataPruneGateForTests();
    const stale = new Date(Date.now() - (OPS_DATA_DEDUPE_HOURS + 1) * 3_600_000);
    await upsertSetting({ ...WIDE_OVERRIDE, lastPrunedAt: stale.toISOString() });
    expect(await isOpsDataPruneDue(new Date())).toBe(true);
    // Corrupt/absent timestamp → due (fail-open, like snapshots.retention).
    await upsertSetting({ ...WIDE_OVERRIDE, lastPrunedAt: "not-a-date" });
    expect(await isOpsDataPruneDue(new Date())).toBe(true);
    await db.setting.update({
      where: { key: OPS_DATA_RETENTION_KEY },
      data: { valueJson: "broken-json" },
    });
    expect(await isOpsDataPruneDue(new Date())).toBe(true);
  });
});

/* ── the sweep itself (DB, synthetic fixtures only) ─────────────────────── */

describe("F-047 ops-data retention sweep (DB, synthetic fixtures)", () => {
  test("chunked sweep: per-run cap respected, backlog converges, guards hold", async () => {
    const now = new Date();
    const cut = opsDataCutoff(now, 3650);
    // Demo-data safety guard: the ~2016 cutoff must match ZERO pre-existing
    // rows (probe: demo data is days old; on any other environment this
    // skips the live assertions rather than risking shared rows).
    const foreign = await foreignCandidatesAt(cut);
    if (foreign.jobs !== 0 || foreign.notifications !== 0 || foreign.observations !== 0) {
      console.log("F-047 test: foreign candidates present — skipping live sweep assertions", foreign);
      return;
    }

    await upsertSetting(WIDE_OVERRIDE);

    // Expired (terminal, 1990/1991-anchored): 4 singles + 10,005 bulk.
    await seedJob({ status: "SUCCEEDED", finishedAt: ANCIENT });
    await seedJob({ status: "FAILED", finishedAt: ANCIENT });
    await seedJob({ status: "DEAD", finishedAt: ANCIENT });
    await seedJob({ status: "CANCELLED", finishedAt: ANCIENT_2 });
    await seedBulkJobs(OPS_DATA_MAX_DELETES_PER_RUN + 5);
    // Survivors: non-terminal rows are NEVER candidates (even ancient), a
    // fresh terminal row is inside the window.
    const queued = await seedJob({ status: "QUEUED", scheduledAt: ANCIENT });
    const running = await seedJob({ status: "RUNNING", scheduledAt: ANCIENT });
    const fresh = await seedJob({ status: "SUCCEEDED", finishedAt: new Date(now.getTime() - DAY_MS) });
    // Read notifications: 2 ancient (expired), 1 ancient-but-unread + 1
    // fresh-read (survivors — unread rows are never candidates).
    await seedNotification({ readAt: ANCIENT });
    await seedNotification({ readAt: ANCIENT_2, kind: "ALERT" });
    const unread = await seedNotification({ readAt: null, createdAt: ANCIENT });
    const freshRead = await seedNotification({ readAt: new Date(now.getTime() - DAY_MS) });
    // Discovery observations: 2 ancient (expired), 1 fresh (survivor).
    await seedObservation(ANCIENT);
    await seedObservation(ANCIENT_2);
    const freshObs = await seedObservation(new Date(now.getTime() - DAY_MS));

    const first = await pruneOpsData({ now, triggeredBy: "F047-TEST" });
    expect(first.outcome).toBe("pruned");
    // The per-run cap (not the data) stopped the job sweep: 4 + 10,005
    // expired − 10,000 deleted = 9 left for the next run.
    expect(first.jobExecutionsDeleted).toBe(OPS_DATA_MAX_DELETES_PER_RUN);
    expect(first.notificationsDeleted).toBe(2);
    expect(first.discoveryObservationsDeleted).toBe(2);

    // Guards held: non-terminal ancient rows and fresh rows all survived.
    expect(await db.jobExecution.count({ where: { correlationId: { startsWith: "OPSRT-" } } })).toBe(12);
    expect(await db.jobExecution.findUnique({ where: { id: queued.id } })).not.toBeNull();
    expect(await db.jobExecution.findUnique({ where: { id: running.id } })).not.toBeNull();
    expect(await db.jobExecution.findUnique({ where: { id: fresh.id } })).not.toBeNull();
    expect(await db.notification.findUnique({ where: { id: unread.id } })).not.toBeNull();
    expect(await db.notification.findUnique({ where: { id: freshRead.id } })).not.toBeNull();
    expect(await db.discoveryObservation.findUnique({ where: { id: freshObs.id } })).not.toBeNull();

    // The backlog converges on the next run.
    const second = await pruneOpsData({ now, triggeredBy: "F047-TEST" });
    expect(second.jobExecutionsDeleted).toBe(9);
    expect(second.notificationsDeleted).toBe(0);
    expect(second.discoveryObservationsDeleted).toBe(0);
    expect(
      await db.jobExecution.count({
        where: { correlationId: { startsWith: "OPSRT-" }, finishedAt: { lt: cut } },
      })
    ).toBe(0);

    // Bookkeeping: Setting carries knobs + lastPruneResult; ONE summary
    // audit row per run (never per deleted row).
    const setting = await db.setting.findUnique({ where: { key: OPS_DATA_RETENTION_KEY } });
    const stored = parseStoredOpsDataRetention(setting?.valueJson);
    expect(stored.lastPrunedAt).not.toBeNull();
    expect(stored.jobExecutionDays).toBe(3650); // knobs survived the stamp
    expect(stored.lastPruneResult).toMatchObject({
      outcome: "pruned",
      jobExecutionsDeleted: 9,
      triggeredBy: "F047-TEST",
    });
    const audit = await db.auditEvent.findFirst({
      where: { action: "OPS_DATA_PRUNED", correlationId: second.correlationId },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorName).toBe("system:ops-retention-worker");
    expect(audit!.resourceType).toBe("Setting");
    expect(audit!.resourceId).toBe(OPS_DATA_RETENTION_KEY);
    expect(JSON.parse(audit!.afterJson ?? "{}")).toMatchObject({ jobExecutionsDeleted: 9 });
  });

  test("enabled:false disables the deletes but still stamps bookkeeping", async () => {
    const now = new Date();
    await upsertSetting({
      jobExecutionDays: 1,
      notificationDays: 1,
      discoveryObservationDays: 1,
      enabled: false,
    });
    const job = await seedJob({ status: "SUCCEEDED", finishedAt: ANCIENT });
    const result = await pruneOpsData({ now, triggeredBy: "F047-TEST-DISABLED" });
    expect(result.outcome).toBe("disabled");
    expect(result.jobExecutionsDeleted).toBe(0);
    expect(result.notificationsDeleted).toBe(0);
    expect(result.discoveryObservationsDeleted).toBe(0);
    expect(await db.jobExecution.findUnique({ where: { id: job.id } })).not.toBeNull();
    const audit = await db.auditEvent.findFirst({
      where: { action: "OPS_DATA_PRUNED", correlationId: result.correlationId },
    });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.afterJson ?? "{}")).toMatchObject({ outcome: "disabled" });
    // Own-fixture cleanup: this leftover expired row must not leak into the
    // later helper-level assertions (they assert exact global counts).
    await db.jobExecution.delete({ where: { id: job.id } });
  });

  test("chunked helpers honor their cutoffs directly (deterministic seams)", async () => {
    const now = new Date();
    const cut = opsDataCutoff(now, 3650);
    // Same demo-data safety guard as the sweep test: the helpers delete by
    // global cutoff, so they may only run when the cutoff matches ZERO
    // pre-existing rows.
    const foreign = await foreignCandidatesAt(cut);
    if (foreign.jobs !== 0 || foreign.notifications !== 0 || foreign.observations !== 0) {
      console.log("F-047 test: foreign candidates present — skipping helper assertions", foreign);
      return;
    }
    await upsertSetting(WIDE_OVERRIDE);
    const job = await seedJob({ status: "FAILED", finishedAt: ANCIENT });
    await seedNotification({ readAt: ANCIENT });
    await seedObservation(ANCIENT);
    expect(await deleteTerminalJobExecutionsChunked(cut)).toBe(1);
    expect(await deleteReadNotificationsChunked(cut)).toBe(1);
    expect(await deleteDiscoveryObservationsChunked(cut)).toBe(1);
    // Re-running is a no-op; a fresh row is out of scope.
    expect(await deleteTerminalJobExecutionsChunked(cut)).toBe(0);
    expect(await deleteReadNotificationsChunked(cut)).toBe(0);
    expect(await deleteDiscoveryObservationsChunked(cut)).toBe(0);
    expect(await db.jobExecution.findUnique({ where: { id: job.id } })).toBeNull();
  });
});

/* ── wiring + contract pins (source) ────────────────────────────────────── */

test("the sweep is wired into the worker tick path, due-ness gated", () => {
  const tick = readFileSync("src/app/api/v1/worker/tick/route.ts", "utf8");
  expect(tick).toContain('from "@/lib/ops/retention"');
  expect(tick).toContain("await isOpsDataPruneDue(now)");
  expect(tick).toContain('pruneOpsData({ now, triggeredBy: "TICK" })');
  expect(tick).toContain("await markOpsDataPruned(now)");
  // A skipped run is visible in the response (zero-query contract, RT-016).
  expect(tick).toContain("opsPruneSkipped");
  expect(tick).toContain("opsJobExecutionsDeleted");
  expect(tick).toContain("opsNotificationsDeleted");
  expect(tick).toContain("opsDiscoveryObservationsDeleted");
  // The tick comment states the audit-chain exclusion explicitly.
  expect(tick).toContain("AuditEvent is NEVER swept");
});

test("AuditEvent is NEVER a retention target (append-only chain, RT-012/RT-013)", () => {
  // Source walk across the whole server surface: no delete of any kind may
  // target the audit chain.
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.isFile()) {
        const src = readFileSync(p, "utf8");
        if (src.includes("auditEvent.deleteMany") || src.includes("auditEvent.delete(")) {
          hits.push(p);
        }
      }
    }
  };
  walk("src");
  expect(hits).toEqual([]);
  // The engine says WHY, out loud, where a future maintainer will read it.
  const lib = readFileSync("src/lib/ops/retention.ts", "utf8");
  expect(lib).toContain("AuditEvent is deliberately OUT OF SCOPE");
  expect(lib).toContain("RT-012");
  expect(lib).toContain("RT-013");
});

test("FK safety: nothing cascades when a terminal JobExecution is swept", () => {
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  const snapshotBlock = schema.slice(
    schema.indexOf("model ConfigSnapshot"),
    schema.indexOf("model ConfigSnapshot") + 3_500
  );
  expect(snapshotBlock).toContain(
    "job            JobExecution?  @relation(fields: [jobId], references: [id], onDelete: SetNull)"
  );
  const observationBlock = schema.slice(
    schema.indexOf("model DiscoveryObservation"),
    schema.indexOf("model ProtocolEventQueue")
  );
  expect(observationBlock).toContain(
    "job            JobExecution? @relation(fields: [jobId], references: [id], onDelete: SetNull)"
  );
});

test("events search: q is CASE-INSENSITIVE on Postgres (17 insensitive contains)", () => {
  const route = readFileSync("src/app/api/v1/events/route.ts", "utf8");
  // 6 (listWhere) + 6 (scopeWhere) + 5 (actor facet, minus its own
  // dimension) — every single `contains` filter is insensitive.
  expect(route.split('{ contains: q, mode: "insensitive" }').length - 1).toBe(17);
  expect(route.split("{ contains: q }").length - 1).toBe(0);
  // The stale provider claim is gone (the docstring may reference the
  // history, but never states the old claim as current behavior); the
  // contract is now stated in place.
  expect(route).not.toContain("(SQLite LIKE is case-insensitive)");
  expect(route).toContain("CASE-INSENSITIVE substring match");
  expect(route).toContain('mode: "insensitive"');
  // Cost honesty + the named follow-up are documented where the decision
  // lives.
  expect(route).toContain("ILIKE");
  expect(route).toContain("pg_trgm");
  expect(route).toContain("docs/adr/ADR-events-search-contract.md");
});

test("the trigram / dedicated-search-column follow-up is a documented ADR, not a schema change", () => {
  const adr = readFileSync("docs/adr/ADR-events-search-contract.md", "utf8");
  expect(adr).toContain("Status: Accepted");
  expect(adr).toContain("pg_trgm");
  expect(adr).toContain("dedicated normalized search column");
  // No schema change in this batch: AuditEvent carries no new columns/index.
  const schema = readFileSync("prisma/schema.prisma", "utf8");
  expect(schema).not.toContain("searchText");
});
