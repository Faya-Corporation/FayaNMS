import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { csvParam, fail, firstIssueMessage, ok } from "../_lib/api";
import {
  authErrorToFail,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { scopedDeviceWhere, sessionSiteScope } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/dashboard?range=24h|7d
 *
 * Single aggregate payload powering the Dashboard view. All numbers are
 * computed live from the seeded database. The range param selects the
 * utilization-trend window; 7d reads 1D rollups and falls back (clamps)
 * to the available 24h of 1H data when no daily rollups exist yet.
 *
 * F-008 phase 1 (read-plane defense-in-depth): the handler verifies the
 * human session itself (requireSessionRead) — the proxy matcher stays the
 * coarse gate, not the only check, for the dashboard read domain.
 *
 * F-031 wave-9 (read-plane migration): every device-derived leg composes
 * the session scope — KPI counts (status/compliance/lastBackup aggregates
 * via scopedDeviceWhere; alert/drift counts via their device relation),
 * the utilization trend and capacity risks (bounded to the session's
 * device ids) and the incident/change lists (via their `site` relation,
 * the same codes the claims resolve to). Wildcard sessions (no `sites`
 * claim — the single-tenant default) keep the byte-unchanged query
 * shapes; deny-all sessions get zeroed KPIs and empty lists.
 *
 * RESIDUALS (honest, authorization-matrix §5.1):
 * - `kpis.activeJobs` stays GLOBAL: JobExecution rows carry no site
 *   linkage and the count exposes no resource identity.
 * - `recentActivity` (AuditEvent stream): rows carry NO site linkage and
 *   `resourceLabel` is free text that frequently names out-of-scope
 *   resources (device hostnames from the alert/snapshot/drift/job/ZTP
 *   writers, user emails, CI labels). Sites-limited sessions therefore
 *   receive the stream with resourceLabel STRIPPED (actor/action/result/
 *   time survive — no cross-scope identity); wildcard sessions keep the
 *   verbatim labels. The deep fix (a site dimension on audit rows) is a
 *   deferred owner decision.
 */

const OPEN_INCIDENT_STATUSES = [
  "NEW",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "MITIGATING",
  "MONITORING",
];

const UPCOMING_CHANGE_STATUSES = ["APPROVED", "SCHEDULED", "PRE_CHECK"];

const SEVERITY_RANK: Record<string, number> = {
  SEV1: 0,
  SEV2: 1,
  SEV3: 2,
  SEV4: 3,
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

const rangeSchema = z.object({
  range: z
    .enum(["15m", "1h", "6h", "24h", "7d", "30d", "custom"])
    .default("24h"),
});

export async function GET(request: Request) {
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const url = new URL(request.url);
  const parsed = rangeSchema.safeParse({ range: url.searchParams.get("range") ?? undefined });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const rawRange = parsed.data.range;
  const requestedRange = ["7d", "30d"].includes(rawRange) ? "7d" : "24h";

  // ── F-031 wave-9: resolve the session scope once for every leg ──────
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const isWildcard = scope.mode === "wildcard";
  // Sites-mode only: the session's device ids bound the metric-derived
  // legs (utilization trend, capacity risks). Deny-all → [] → empty.
  const scopeDeviceIds: string[] | null = isWildcard
    ? null
    : (
        await db.device.findMany({
          where: scopedDeviceWhere(scopeClaims, {}),
          select: { id: true },
        })
      ).map((d) => d.id);

  // ── KPI counts (independent → parallel) ──────────────────────────────
  const [
    statusGroups,
    criticalAlerts,
    activeAlerts,
    activeIncidents,
    pendingApprovals,
    activeJobs,
    driftCount,
    complianceGroups,
    lastBackupAgg,
  ] = await Promise.all([
    db.device.groupBy({
      by: ["status"],
      _count: { _all: true },
      ...(isWildcard ? {} : { where: scopedDeviceWhere(scopeClaims, {}) }),
    }),
    db.alert.count({
      where: {
        status: "ACTIVE",
        severity: "CRITICAL",
        ...(isWildcard ? {} : { device: scopedDeviceWhere(scopeClaims, {}) }),
      },
    }),
    db.alert.count({
      where: {
        status: "ACTIVE",
        ...(isWildcard ? {} : { device: scopedDeviceWhere(scopeClaims, {}) }),
      },
    }),
    db.incident.count({
      where: {
        status: { in: OPEN_INCIDENT_STATUSES },
        ...(isWildcard ? {} : { site: { code: { in: scope.codes } } }),
      },
    }),
    db.changeRequest.count({
      where: {
        status: "AWAITING_APPROVAL",
        ...(isWildcard ? {} : { site: { code: { in: scope.codes } } }),
      },
    }),
    // GLOBAL by design (residual): JobExecution has no site linkage and
    // the bare count exposes no resource identity — see the header note.
    db.jobExecution.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
    db.driftRecord.count({
      where: {
        status: "OPEN",
        ...(isWildcard ? {} : { device: scopedDeviceWhere(scopeClaims, {}) }),
      },
    }),
    db.device.groupBy({
      by: ["backupCompliance"],
      _count: { _all: true },
      where: isWildcard
        ? { status: { not: "UNMANAGED" } }
        : scopedDeviceWhere(scopeClaims, { status: { not: "UNMANAGED" } }),
    }),
    db.device.aggregate({
      _max: { lastBackupAt: true },
      where: isWildcard
        ? { status: { not: "UNMANAGED" }, lastBackupAt: { not: null } }
        : scopedDeviceWhere(scopeClaims, {
            status: { not: "UNMANAGED" },
            lastBackupAt: { not: null },
          }),
    }),
  ]);

  const countByStatus = new Map<string, number>(
    statusGroups.map((row) => [row.status, row._count._all])
  );
  const managedDevices = statusGroups
    .filter((row) => row.status !== "UNMANAGED")
    .reduce((sum, row) => sum + row._count._all, 0);

  const complianceCount = (key: string): number =>
    complianceGroups
      .filter((row) => row.backupCompliance === key)
      .reduce((sum, row) => sum + row._count._all, 0);
  const compliant = complianceCount("COMPLIANT");

  const kpis = {
    managedDevices,
    online: countByStatus.get("ONLINE") ?? 0,
    offline:
      (countByStatus.get("OFFLINE") ?? 0) + (countByStatus.get("UNKNOWN") ?? 0),
    criticalAlerts,
    activeAlerts,
    activeIncidents,
    pendingApprovals,
    activeJobs,
    backupCompliancePct:
      managedDevices > 0 ? round1((compliant / managedDevices) * 100) : 0,
    driftCount,
  };

  // ── Utilization trend (rollups grouped by period, averaged across devices) ──
  let range = requestedRange;
  let trendClamped = false;
  const HOURS_MS = 3_600_000;

  const fetchTrend = async (granularity: "1H" | "1D", hours: number) => {
    const since = new Date(Date.now() - hours * HOURS_MS);
    return db.metricRollup.findMany({
      where: {
        granularity,
        metric: { in: ["CPU", "MEMORY"] },
        periodStart: { gte: since },
        // F-031 wave-9: sites-limited sessions trend THEIR devices only.
        ...(scopeDeviceIds ? { deviceId: { in: scopeDeviceIds } } : {}),
      },
      orderBy: { periodStart: "asc" },
      select: { metric: true, periodStart: true, avg: true },
    });
  };

  let rollups = await fetchTrend(
    requestedRange === "7d" ? "1D" : "1H",
    requestedRange === "7d" ? 168 : 24
  );
  if (requestedRange === "7d" && rollups.length === 0) {
    // No daily rollups yet — clamp to the available 24h of hourly data.
    rollups = await fetchTrend("1H", 24);
    range = "24h";
    trendClamped = true;
  }

  type TrendBucket = {
    cpuSum: number;
    cpuCount: number;
    memorySum: number;
    memoryCount: number;
  };
  const buckets = new Map<string, TrendBucket>();
  for (const row of rollups) {
    const key = row.periodStart.toISOString();
    const bucket = buckets.get(key) ?? {
      cpuSum: 0,
      cpuCount: 0,
      memorySum: 0,
      memoryCount: 0,
    };
    if (row.metric === "CPU") {
      bucket.cpuSum += row.avg;
      bucket.cpuCount += 1;
    } else if (row.metric === "MEMORY") {
      bucket.memorySum += row.avg;
      bucket.memoryCount += 1;
    }
    buckets.set(key, bucket);
  }
  const utilizationTrend = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, bucket]) => ({
      period,
      cpu: bucket.cpuCount > 0 ? round1(bucket.cpuSum / bucket.cpuCount) : 0,
      memory:
        bucket.memoryCount > 0
          ? round1(bucket.memorySum / bucket.memoryCount)
          : 0,
    }));

  // ── Health distribution (all devices incl. unmanaged) ────────────────
  const healthDistribution = statusGroups
    .map((row) => ({ status: row.status, count: row._count._all }))
    .sort((a, b) => b.count - a.count);

  // ── Open incidents (top 5 by severity then recency) ──────────────────
  // F-031 wave-9: the site relation carries the scope (the same codes the
  // KPI count uses); wildcard keeps the byte-unchanged where.
  const openIncidents = await db.incident.findMany({
    where: {
      status: { in: OPEN_INCIDENT_STATUSES },
      ...(isWildcard ? {} : { site: { code: { in: scope.codes } } }),
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      number: true,
      title: true,
      severity: true,
      status: true,
      createdAt: true,
      slaDueAt: true,
    },
  });
  const activeIncidentsList = openIncidents
    .sort((a, b) => {
      const rankDiff =
        (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      if (rankDiff !== 0) return rankDiff;
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .slice(0, 5);

  // ── Upcoming changes ──────────────────────────────────────────────────
  const upcomingChanges = await db.changeRequest.findMany({
    where: {
      status: { in: UPCOMING_CHANGE_STATUSES },
      ...(isWildcard ? {} : { site: { code: { in: scope.codes } } }),
    },
    orderBy: { scheduledStart: "asc" },
    take: 5,
    select: {
      id: true,
      number: true,
      title: true,
      riskLevel: true,
      scheduledStart: true,
      status: true,
    },
  });

  // ── Capacity risks (peak 24h utilization rollups > 75%) ─────────────
  // Diurnal traffic means a single "latest hour" snapshot can be empty at
  // night; we therefore rank devices by their PEAK avg within the last 24h
  // of 1H rollups ("recent periodStart max").
  const utilSince = new Date(Date.now() - 24 * HOURS_MS);
  const utilRows = await db.metricRollup.findMany({
    where: {
      granularity: "1H",
      metric: { in: ["UTILIZATION_IN", "UTILIZATION_OUT"] },
      periodStart: { gte: utilSince },
      avg: { gt: 75 },
      // F-031 wave-9: capacity risks name hostnames — sites-limited
      // sessions rank THEIR devices only.
      ...(scopeDeviceIds ? { deviceId: { in: scopeDeviceIds } } : {}),
    },
    orderBy: { avg: "desc" },
    take: 40,
    select: {
      deviceId: true,
      metric: true,
      avg: true,
      device: { select: { hostname: true } },
    },
  });
  const seenUtil = new Set<string>();
  const capacityRisks: {
    deviceId: string;
    hostname: string;
    metric: string;
    value: number;
  }[] = [];
  for (const row of utilRows) {
    const key = `${row.deviceId}:${row.metric}`;
    if (seenUtil.has(key)) continue; // rows are sorted desc → first hit is the peak
    seenUtil.add(key);
    capacityRisks.push({
      deviceId: row.deviceId,
      hostname: row.device.hostname,
      metric: row.metric,
      value: round1(row.avg),
    });
    if (capacityRisks.length === 5) break;
  }

  // ── Recent activity (latest audit events) ─────────────────────────────
  // F-031 wave-9 residual: AuditEvent rows have no site linkage and
  // resourceLabel is free text that can name out-of-scope devices (and
  // users). Sites-limited sessions get the stream with resourceLabel
  // stripped; wildcard keeps the verbatim labels (parity).
  const recentActivityRows = await db.auditEvent.findMany({
    orderBy: { createdAt: "desc" },
    take: 12,
    select: {
      id: true,
      actorName: true,
      action: true,
      resourceLabel: true,
      result: true,
      createdAt: true,
    },
  });
  const recentActivity = recentActivityRows.map((row) => ({
    ...row,
    resourceLabel: isWildcard ? row.resourceLabel : null,
  }));

  return ok(
    {
      kpis,
      utilizationTrend,
      healthDistribution,
      activeIncidentsList,
      upcomingChanges,
      backupCompliance: {
        compliant,
        overdue: complianceCount("OVERDUE"),
        failed: complianceCount("FAILED"),
        never: complianceCount("NEVER_BACKED_UP"),
        unknown: complianceCount("UNKNOWN"),
        lastSuccessfulBackupAt: lastBackupAgg._max.lastBackupAt,
      },
      capacityRisks,
      recentActivity,
    },
    { range, requested: csvParam(url.searchParams.get("range"))?.[0] ?? "24h", clamped: trendClamped }
  );
}
