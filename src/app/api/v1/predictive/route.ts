import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, requestContext } from "../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * Predictive health — deterministic device risk scoring (Phase 12-c)
 *
 * GET /api/v1/predictive            → risk for every analyzable device
 * GET /api/v1/predictive?siteId=…   → risk for one site's devices
 *
 * ── FORMULA "v1" (transparent, dependency-free ML-lite — no model file,
 *    no randomness; the same data always produces the same score) ──
 *
 * score_raw = cpuTrend + alertPressure + backupReliability + drift
 *           + interfaceErrors          (each factor capped below, sum ≤ 100)
 * score     = clamp(0, 100, round(score_raw)) then the STATUS OVERRIDE.
 *
 * 1. cpuTrend (max 30) — resource pressure from the last 24 h.
 *    Series source: MetricRollup granularity "1H" (24 buckets, the denser
 *    Task-6 tier for this window); devices with < 6 rollup buckets for a
 *    metric fall back to raw MetricSample for that metric. Missing series
 *    contribute 0 — a device is never punished for absent telemetry.
 *    Per metric (CPU weight 0.6 → max 18, MEMORY weight 0.4 → max 12):
 *      current    = newest bucket avg (0–100)
 *      slope/day  = least-squares slope over the window × 24 (manual, ~8 lines)
 *      level      = clamp((current − 40) / 55, 0, 1)     → ≥95% saturates
 *      rise       = clamp(slopePerDay / 3, 0, 1)         → ≥ +3%/day saturates
 *      metricPts  = 10 × level + 5 × level × rise        → max 15 per metric
 *    i.e. points grow with the CURRENT LEVEL amplified by a RISING trend
 *    ("high and climbing" scores highest; low-and-flat scores ~0).
 *
 * 2. alertPressure (max 25) — open alerts weighted by severity:
 *    CRITICAL 10 · HIGH 6 · MEDIUM 3 · LOW 1 · INFO 0.
 *    activePts = min(20, Σ weights of ACTIVE alerts).
 *    agingPts  = min(5, 1.5 × acknowledged-but-unresolved alerts older
 *                    than 24 h (acknowledgedAt ?? firstSeen)).
 *    SUPPRESSED / RESOLVED alerts are excluded (suppression is planned
 *    risk-absorption, not risk).
 *
 * 3. backupReliability (max 20) — consecutive FAILED CONFIG_BACKUP job
 *    executions per device (targetType DEVICE, targetId = deviceId; newest
 *    first, skip QUEUED/RUNNING, stop at the first SUCCEEDED):
 *      base = min(16, streak × 6)
 *      ×1.25 when the newest failure is policy-scheduled (payloadJson
 *        carries "policyId") — failed schedules put the whole scope at risk
 *      = 10 when streak = 0 but backupCompliance = NEVER_BACKED_UP
 *      capped at 20.
 *
 * 4. drift (max 15) — configuration drift recurrence:
 *      openPts       = min(9, 6 × OPEN DriftRecords)
 *      recurrencePts = min(6, 3 × (detections in last 7 d − 1))
 *    → repeated re-detections on the same device keep adding pressure.
 *
 * 5. interfaceErrors (max 10) — MetricSample carries no CRC/error counter
 *    metrics in this schema (CPU, MEMORY, UTILIZATION_IN/OUT, LATENCY_MS,
 *    PACKET_LOSS, AVAILABILITY only), so the proxy is interface faults:
 *    interfaces with adminStatus UP whose operStatus ∉ {UP, NOT_PRESENT}.
 *    factor = min(10, 5 × downCount).
 *
 * STATUS OVERRIDE (documented):
 *    OFFLINE      → score = max(score + 15, 80) capped at 100 — an
 *                   unreachable device is inherently the fleet's top risk.
 *    MAINTENANCE  → score = round(score × 0.7) — planned work dampens risk
 *                   (alerts suppressed, change activity expected).
 *    UNMANAGED    → excluded from analysis entirely (no telemetry, no
 *                   expected backups — scoring would be meaningless).
 *
 * BANDS: score ≥ 60 "critical" · ≥ 35 "high" · ≥ 10 "moderate" · else "low"
 * (percent-of-max thresholds: a single HIGH alert or hot CPU = moderate —
 * several compounding factors = high; typical healthy fleets score low).
 *
 * All queries are bounded: the fleet (~30 rows), 24 h of 1H rollups
 * (≤ fleet × 2 × 24), a capped open-alert read, a capped recent
 * CONFIG_BACKUP history, 7 d of drift records and a grouped interface read.
 * Read-only GET → no audit event (app convention). Caching follows the
 * other GET routes: `dynamic = "force-dynamic"` (the client fetches with
 * cache: "no-store").
 * ───────────────────────────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Rollup buckets below this per metric → raw-sample fallback for it. */
const MIN_ROLLUP_POINTS = 6;
/** Open-alert rows and backup-job rows read at most (fleet is ~30). */
const ALERT_CAP = 500;
const JOB_CAP = 800;
const DRIFT_CAP = 500;

const ALERT_SEVERITY_WEIGHT: Record<string, number> = {
  CRITICAL: 10,
  HIGH: 6,
  MEDIUM: 3,
  LOW: 1,
  INFO: 0,
};

const querySchema = z.object({
  siteId: z.string().trim().min(1).max(64).optional(),
});

/* ── output schema (Zod-validated response contract) ── */

const FACTOR_KEYS = [
  "cpuTrend",
  "alertPressure",
  "backupReliability",
  "drift",
  "interfaceErrors",
] as const;

const factorSchema = z.object({
  points: z.number().min(0),
  max: z.number(),
});
const cpuTrendSchema = factorSchema.extend({
  cpu: z.number().nullable(),
  memory: z.number().nullable(),
  risePerDay: z.number().nullable(),
});
const alertPressureSchema = factorSchema.extend({
  active: z.number().int().min(0),
  acknowledged: z.number().int().min(0),
  worstSeverity: z.string().nullable(),
});
const backupSchema = factorSchema.extend({
  failureStreak: z.number().int().min(0),
  policyScheduled: z.boolean(),
  neverBackedUp: z.boolean(),
});
const driftSchema = factorSchema.extend({
  open: z.number().int().min(0),
  recent7d: z.number().int().min(0),
});
const ifaceSchema = factorSchema.extend({
  downInterfaces: z.number().int().min(0),
});

const deviceSchema = z.object({
  deviceId: z.string(),
  hostname: z.string(),
  vendor: z.string(),
  site: z
    .object({ id: z.string(), name: z.string(), code: z.string() })
    .nullable(),
  status: z.string(),
  score: z.number().int().min(0).max(100),
  band: z.enum(["low", "moderate", "high", "critical"]),
  topFactor: z.object({
    factor: z.enum(FACTOR_KEYS),
    /** English canonical detail (fallback — same contract as status labels). */
    detail: z.string(),
    /** i18n key under the "predictive" namespace for localized rendering. */
    detailKey: z.string(),
    /** Numbers only — the view interpolates them into the localized string. */
    detailParams: z.record(z.string(), z.number()),
  }),
  factors: z.object({
    cpuTrend: cpuTrendSchema,
    alertPressure: alertPressureSchema,
    backupReliability: backupSchema,
    drift: driftSchema,
    interfaceErrors: ifaceSchema,
  }),
});

const outputSchema = z.object({
  devices: z.array(deviceSchema),
  meta: z.object({
    computedAt: z.string(),
    formula: z.literal("v1"),
    deviceCount: z.number().int().min(0),
  }),
});

/* ── tiny least-squares slope (per index step; x = 0..n-1 chronological) ── */

function slopePerIndex(values: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const meanX = (n - 1) / 2;
  const meanY = values.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (i - meanX) ** 2;
    sxy += (i - meanX) * (values[i] - meanY);
  }
  return sxx === 0 ? null : sxy / sxx;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Level/rise scoring per the formula block above. Max 15 per metric. */
function metricPressure(current: number, slopePerDay: number): number {
  const level = clamp01((current - 40) / 55);
  const rise = clamp01(slopePerDay / 3);
  return 10 * level + 5 * level * rise;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    siteId: url.searchParams.get("siteId") ?? undefined,
  });
  if (!parsed.success) {
    return fail(
      "INVALID_QUERY",
      firstIssueMessage(parsed.error),
      400,
      requestContext(request)
    );
  }
  const { siteId } = parsed.data;

  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * HOUR_MS);
  const since7d = new Date(now.getTime() - 7 * DAY_MS);

  const devices = await db.device.findMany({
    where: siteId ? { siteId } : undefined,
    select: {
      id: true,
      hostname: true,
      status: true,
      backupCompliance: true,
      vendor: { select: { name: true } },
      site: { select: { id: true, name: true, code: true } },
    },
    orderBy: { hostname: "asc" },
  });
  const analyzed = devices.filter((d) => d.status !== "UNMANAGED");
  const analyzedIds = analyzed.map((d) => d.id);

  /* ── 1. cpu/mem trend series (rollups first, raw-sample fallback) ── */
  const rollups = analyzedIds.length
    ? await db.metricRollup.findMany({
        where: {
          deviceId: { in: analyzedIds },
          granularity: "1H",
          metric: { in: ["CPU", "MEMORY"] },
          periodStart: { gte: since24h },
        },
        select: { deviceId: true, metric: true, periodStart: true, avg: true },
      })
    : [];

  // deviceId → metric → chronological avg values
  const rollupSeries = new Map<string, Map<string, number[]>>();
  for (const row of rollups) {
    let byMetric = rollupSeries.get(row.deviceId);
    if (!byMetric) {
      byMetric = new Map();
      rollupSeries.set(row.deviceId, byMetric);
    }
    const points = byMetric.get(row.metric) ?? [];
    points.push(row.avg);
    byMetric.set(row.metric, points);
  }

  // Raw-sample fallback only where a metric lacks enough rollup buckets.
  const fallbackIds = analyzedIds.filter((id) => {
    const byMetric = rollupSeries.get(id);
    return (
      !byMetric ||
      (byMetric.get("CPU")?.length ?? 0) < MIN_ROLLUP_POINTS ||
      (byMetric.get("MEMORY")?.length ?? 0) < MIN_ROLLUP_POINTS
    );
  });
  const samples = fallbackIds.length
    ? await db.metricSample.findMany({
        where: {
          deviceId: { in: fallbackIds },
          metric: { in: ["CPU", "MEMORY"] },
          ts: { gte: since24h },
        },
        select: { deviceId: true, metric: true, value: true, ts: true },
        orderBy: { ts: "asc" },
      })
    : [];

  const sampleSeries = new Map<string, Map<string, number[]>>();
  for (const row of samples) {
    let byMetric = sampleSeries.get(row.deviceId);
    if (!byMetric) {
      byMetric = new Map();
      sampleSeries.set(row.deviceId, byMetric);
    }
    const points = byMetric.get(row.metric) ?? [];
    points.push(row.value);
    byMetric.set(row.metric, points);
  }

  /** Final 24 h series per device+metric: rollups when dense enough, else raw. */
  const seriesFor = (deviceId: string, metric: string): number[] | null => {
    const rollupPts = rollupSeries.get(deviceId)?.get(metric);
    if (rollupPts && rollupPts.length >= MIN_ROLLUP_POINTS) return rollupPts;
    const rawPts = sampleSeries.get(deviceId)?.get(metric);
    return rawPts && rawPts.length >= 3 ? rawPts : null;
  };

  /* ── 2. open alerts (ACTIVE + ACKNOWLEDGED) ── */
  const alerts = analyzedIds.length
    ? await db.alert.findMany({
        where: {
          deviceId: { in: analyzedIds },
          status: { in: ["ACTIVE", "ACKNOWLEDGED"] },
        },
        select: {
          deviceId: true,
          severity: true,
          status: true,
          firstSeen: true,
          acknowledgedAt: true,
        },
        orderBy: { lastSeen: "desc" },
        take: ALERT_CAP,
      })
    : [];

  /* ── 3. recent CONFIG_BACKUP history (newest first) ── */
  const backupJobs = analyzedIds.length
    ? await db.jobExecution.findMany({
        where: {
          type: "CONFIG_BACKUP",
          targetType: "DEVICE",
          targetId: { in: analyzedIds },
          status: { in: ["SUCCEEDED", "FAILED"] },
          finishedAt: { not: null },
        },
        select: { targetId: true, status: true, payloadJson: true },
        orderBy: { finishedAt: "desc" },
        take: JOB_CAP,
      })
    : [];

  /* ── 4. drift: open (any age) + detections in the last 7 d ── */
  const [openDriftGroups, recentDrifts] = analyzedIds.length
    ? await Promise.all([
        db.driftRecord.groupBy({
          by: ["deviceId"],
          _count: { _all: true },
          where: { deviceId: { in: analyzedIds }, status: "OPEN" },
        }),
        db.driftRecord.findMany({
          where: { deviceId: { in: analyzedIds }, detectedAt: { gte: since7d } },
          select: { deviceId: true },
          take: DRIFT_CAP,
        }),
      ])
    : [[] as Array<{ deviceId: string; _count: { _all: number } }>, [] as Array<{ deviceId: string }>];

  /* ── 5. interface faults (admin UP but not operating) ── */
  const downIfaceGroups = analyzedIds.length
    ? await db.deviceInterface.groupBy({
        by: ["deviceId"],
        _count: { _all: true },
        where: {
          deviceId: { in: analyzedIds },
          adminStatus: "UP",
          operStatus: { notIn: ["UP", "NOT_PRESENT"] },
        },
      })
    : [];

  // Indexes
  const openDriftByDevice = new Map(
    openDriftGroups.map((g) => [g.deviceId, g._count._all])
  );
  const recentDriftByDevice = new Map<string, number>();
  for (const row of recentDrifts) {
    recentDriftByDevice.set(
      row.deviceId,
      (recentDriftByDevice.get(row.deviceId) ?? 0) + 1
    );
  }
  const downIfaceByDevice = new Map(
    downIfaceGroups.map((g) => [g.deviceId, g._count._all])
  );
  const alertByDevice = new Map<string, typeof alerts>();
  for (const alert of alerts) {
    const list = alertByDevice.get(alert.deviceId) ?? [];
    list.push(alert);
    alertByDevice.set(alert.deviceId, list);
  }
  // Per-device newest-first CONFIG_BACKUP outcome streak (single pass).
  const streakByDevice = new Map<
    string,
    { streak: number; policyScheduled: boolean }
  >();
  const deviceIdsWithJobs = new Set<string>();
  for (const job of backupJobs) {
    if (job.targetId) deviceIdsWithJobs.add(job.targetId);
  }
  for (const deviceId of deviceIdsWithJobs) {
    let streak = 0;
    let policyScheduled = false;
    for (const job of backupJobs) {
      if (job.targetId !== deviceId) continue;
      if (job.status === "SUCCEEDED") break;
      streak += 1;
      if (
        typeof job.payloadJson === "string" &&
        job.payloadJson.includes('"policyId"')
      ) {
        policyScheduled = true;
      }
    }
    streakByDevice.set(deviceId, { streak, policyScheduled });
  }

  /* ── score every device ── */
  const rows = analyzed.map((device) => {
    // 1. cpu/mem trend
    const cpuSeries = seriesFor(device.id, "CPU");
    const memSeries = seriesFor(device.id, "MEMORY");
    const cpuCurrent = cpuSeries ? cpuSeries[cpuSeries.length - 1] : null;
    const memCurrent = memSeries ? memSeries[memSeries.length - 1] : null;
    const cpuSlope = cpuSeries ? slopePerIndex(cpuSeries) : null;
    const memSlope = memSeries ? slopePerIndex(memSeries) : null;
    const cpuPts =
      cpuCurrent !== null && cpuSlope !== null
        ? metricPressure(cpuCurrent, cpuSlope * 24)
        : 0;
    const memPts =
      memCurrent !== null && memSlope !== null
        ? metricPressure(memCurrent, memSlope * 24)
        : 0;
    const cpuTrend = Math.min(30, (cpuPts / 15) * 18 + (memPts / 15) * 12);
    const risePerDay =
      cpuSlope !== null
        ? round1(cpuSlope * 24)
        : memSlope !== null
          ? round1(memSlope * 24)
          : null;

    // 2. alert pressure
    const deviceAlerts = alertByDevice.get(device.id) ?? [];
    const active = deviceAlerts.filter((a) => a.status === "ACTIVE");
    const acknowledged = deviceAlerts.filter((a) => a.status === "ACKNOWLEDGED");
    const activePts = Math.min(
      20,
      active.reduce(
        (sum, a) => sum + (ALERT_SEVERITY_WEIGHT[a.severity] ?? 0),
        0
      )
    );
    const agingCutoff = now.getTime() - DAY_MS;
    const agingCount = acknowledged.filter(
      (a) => (a.acknowledgedAt ?? a.firstSeen).getTime() < agingCutoff
    ).length;
    const alertPressure = Math.min(
      25,
      activePts + Math.min(5, agingCount * 1.5)
    );
    const severityRank = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
    const worstOf = (list: typeof deviceAlerts) =>
      severityRank.find((sev) => list.some((a) => a.severity === sev)) ?? null;
    const worstSeverity =
      active.length > 0
        ? worstOf(active)
        : acknowledged.length > 0
          ? worstOf(acknowledged)
          : null;

    // 3. backup reliability
    const backupState = streakByDevice.get(device.id) ?? {
      streak: 0,
      policyScheduled: false,
    };
    const neverBackedUp =
      backupState.streak === 0 && device.backupCompliance === "NEVER_BACKED_UP";
    let backupReliability = Math.min(16, backupState.streak * 6);
    if (backupState.streak > 0 && backupState.policyScheduled) {
      backupReliability = Math.max(8, Math.round(backupReliability * 1.25));
    }
    if (neverBackedUp) backupReliability = Math.max(backupReliability, 10);
    backupReliability = Math.min(20, backupReliability);

    // 4. drift recurrence
    const openDrifts = openDriftByDevice.get(device.id) ?? 0;
    const recentDrifts7d = recentDriftByDevice.get(device.id) ?? 0;
    const drift = Math.min(
      15,
      Math.min(9, openDrifts * 6) +
        Math.min(6, Math.max(0, recentDrifts7d - 1) * 3)
    );

    // 5. interface faults
    const downInterfaces = downIfaceByDevice.get(device.id) ?? 0;
    const interfaceErrors = Math.min(10, downInterfaces * 5);

    // status override + band
    let score = Math.round(
      Math.min(
        100,
        cpuTrend + alertPressure + backupReliability + drift + interfaceErrors
      )
    );
    if (device.status === "OFFLINE") {
      score = Math.min(100, Math.max(score + 15, 80));
    } else if (device.status === "MAINTENANCE") {
      score = Math.round(score * 0.7);
    }

    const factors = {
      cpuTrend: {
        points: round1(cpuTrend),
        max: 30,
        cpu: cpuCurrent === null ? null : round1(cpuCurrent),
        memory: memCurrent === null ? null : round1(memCurrent),
        risePerDay,
      },
      alertPressure: {
        points: round1(alertPressure),
        max: 25,
        active: active.length,
        acknowledged: acknowledged.length,
        worstSeverity,
      },
      backupReliability: {
        points: backupReliability,
        max: 20,
        failureStreak: backupState.streak,
        policyScheduled: backupState.policyScheduled,
        neverBackedUp,
      },
      drift: {
        points: drift,
        max: 15,
        open: openDrifts,
        recent7d: recentDrifts7d,
      },
      interfaceErrors: { points: interfaceErrors, max: 10, downInterfaces },
    };

    // topFactor = the largest contributor (ties resolved by FACTOR_KEYS order)
    const topFactorKey = FACTOR_KEYS.reduce(
      (best, key) => (factors[key].points > factors[best].points ? key : best),
      FACTOR_KEYS[0]
    );
    const { detail, detailParams } = topFactorDetail(topFactorKey, factors);

    const band =
      score >= 60
        ? "critical"
        : score >= 35
          ? "high"
          : score >= 10
            ? "moderate"
            : "low";

    return {
      deviceId: device.id,
      hostname: device.hostname,
      vendor: device.vendor.name,
      site: device.site,
      status: device.status,
      score,
      band,
      topFactor: {
        factor: topFactorKey,
        detail,
        detailKey: `predictive.detail.${topFactorKey}`,
        detailParams,
      },
      factors,
    };
  });

  // Ranked: score desc, hostname asc for a fully deterministic order.
  rows.sort(
    (a, b) => b.score - a.score || a.hostname.localeCompare(b.hostname)
  );

  const payload = outputSchema.parse({
    devices: rows,
    meta: {
      computedAt: now.toISOString(),
      formula: "v1",
      deviceCount: rows.length,
    },
  });

  return ok(payload, undefined, 200, requestContext(request));
}

/* ── top-factor details: English fallback + numeric i18n params ── */

type FactorKey = (typeof FACTOR_KEYS)[number];
type FactorSet = {
  cpuTrend: {
    points: number;
    cpu: number | null;
    memory: number | null;
    risePerDay: number | null;
  };
  alertPressure: { points: number; active: number; acknowledged: number };
  backupReliability: {
    points: number;
    failureStreak: number;
    policyScheduled: boolean;
    neverBackedUp: boolean;
  };
  drift: { points: number; open: number; recent7d: number };
  interfaceErrors: { points: number; downInterfaces: number };
};

function topFactorDetail(
  factor: FactorKey,
  factors: FactorSet
): { detail: string; detailParams: Record<string, number> } {
  switch (factor) {
    case "cpuTrend": {
      const f = factors.cpuTrend;
      return {
        detail:
          f.cpu === null
            ? "No CPU/memory telemetry in the last 24 h"
            : `CPU ${f.cpu}% · memory ${f.memory ?? "—"}% · ${
                f.risePerDay !== null && f.risePerDay > 0
                  ? `+${f.risePerDay}%/day`
                  : "stable"
              } (24 h trend)`,
        detailParams: {
          cpu: f.cpu ?? 0,
          mem: f.memory ?? 0,
          rise: f.risePerDay ?? 0,
        },
      };
    }
    case "alertPressure": {
      const f = factors.alertPressure;
      return {
        detail: `${f.active} active alert${f.active === 1 ? "" : "s"} · ${f.acknowledged} acknowledged`,
        detailParams: { active: f.active, ack: f.acknowledged },
      };
    }
    case "backupReliability": {
      const f = factors.backupReliability;
      return {
        detail:
          f.failureStreak > 0
            ? `${f.failureStreak} consecutive failed backup${f.failureStreak === 1 ? "" : "s"}${
                f.policyScheduled ? " (policy-scheduled)" : ""
              }`
            : "Never backed up",
        detailParams: { streak: f.failureStreak },
      };
    }
    case "drift": {
      const f = factors.drift;
      return {
        detail: `${f.open} open drift${f.open === 1 ? "" : "s"} · ${f.recent7d} detection${
          f.recent7d === 1 ? "" : "s"
        } in 7 d`,
        detailParams: { open: f.open, recent: f.recent7d },
      };
    }
    case "interfaceErrors": {
      const f = factors.interfaceErrors;
      return {
        detail: `${f.downInterfaces} interface${f.downInterfaces === 1 ? "" : "s"} down while admin UP`,
        detailParams: { down: f.downInterfaces },
      };
    }
  }
}
