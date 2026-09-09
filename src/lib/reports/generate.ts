import { db } from "@/lib/db";
import { INCIDENT_OPEN_STATUSES } from "@/lib/incidents/lifecycle";
import {
  confidenceFromR2,
  fetchRollups,
  linearRegressionDaily,
  round1,
} from "@/lib/performance/core";

/**
 * Report generation (Task 9-a) — evaluate-in-Next helpers.
 *
 * Every generator reads live platform data and produces one tabular
 * artifact stored verbatim in the REPORT_RUN JobExecution's resultJson:
 *
 *   { reportType, generatedAt, range, format, columns: [{key,label}], rows: [...] }
 *
 * The generation math MIRRORS the established APIs so a report row always
 * reconciles with its source view:
 *   - AVAILABILITY        → /api/v1/performance/availability (mean of 1H
 *                           AVAILABILITY rollup avgs per device, downtime =
 *                           Σ (100 − avg)/100 × bucket minutes)
 *   - BACKUP_COMPLIANCE   → /api/v1/compliance/backup (24 h / 72 h bands
 *                           from device.lastBackupAt)
 *   - CHANGE_SUMMARY      → change-request counts by status × risk (30 d)
 *   - INCIDENT_SUMMARY    → incident counts by severity + MTTA/MTTR proxy
 *                           (30 d, same definitions as /incidents/stats)
 *   - CAPACITY            → /api/v1/performance/capacity (linear regression
 *                           over 1D rollup averages, horizon 80%)
 *
 * Artifacts are hard-capped at MAX_ROWS rows (fleet is ~70 devices; the cap
 * only matters as a safety net). Column labels are English data-file labels
 * — artifacts are LTR technical exports, same treatment as config backups.
 */

export const REPORT_TYPES = [
  "AVAILABILITY",
  "BACKUP_COMPLIANCE",
  "CHANGE_SUMMARY",
  "INCIDENT_SUMMARY",
  "CAPACITY",
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_FREQUENCIES = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
] as const;
export type ReportFrequency = (typeof REPORT_FREQUENCIES)[number];

export const REPORT_FORMATS = ["PDF", "XLSX", "CSV", "JSON"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ReportColumn {
  key: string;
  label: string;
}

export interface ReportRow {
  [key: string]: string | number | null;
}

export interface ReportArtifact {
  reportType: string;
  generatedAt: string;
  range: string;
  format: string;
  columns: ReportColumn[];
  rows: ReportRow[];
}

const MAX_ROWS = 500;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Backup bands — same windows as /api/v1/compliance/backup. */
const COMPLIANT_WINDOW_MS = 24 * HOUR_MS;
const AT_RISK_WINDOW_MS = 72 * HOUR_MS;

/** Capacity forecast horizon (same default as the capacity API). */
const CAPACITY_HORIZON_PCT = 80;
const CAPACITY_MIN_POINTS = 5;
const CAPACITY_MIN_CURRENT_PCT = 40;

/**
 * Expected analysis window for a schedule — shown in the runs history
 * before the first artifact exists (derived from type + frequency, same
 * mapping the generators use).
 */
export function expectedRangeFor(
  reportType: string,
  frequency: string
): string {
  if (reportType === "AVAILABILITY") {
    return frequency === "DAILY" ? "LAST_24_HOURS" : "LAST_7_DAYS";
  }
  if (reportType === "BACKUP_COMPLIANCE") return "CURRENT_SNAPSHOT";
  return "LAST_30_DAYS";
}

/* ───────────────────────── AVAILABILITY ───────────────────────── */

async function generateAvailability(
  frequency: string,
  format: string
): Promise<ReportArtifact> {
  const days = frequency === "DAILY" ? 1 : 7;
  const since = new Date(Date.now() - days * DAY_MS);
  const bucketMinutes = HOUR_MS / 60_000;

  const [devices, slaSetting] = await Promise.all([
    db.device.findMany({
      select: {
        id: true,
        hostname: true,
        status: true,
        site: { select: { code: true, name: true } },
      },
      orderBy: { hostname: "asc" },
    }),
    db.setting.findUnique({ where: { key: "performance.sla.target" } }),
  ]);

  const slaTargetPct = (() => {
    const raw = slaSetting?.valueJson
      ? Number(JSON.parse(slaSetting.valueJson))
      : Number.NaN;
    return Number.isFinite(raw) ? raw : 99.9;
  })();

  const monitored = devices.filter((d) => d.status !== "UNMANAGED");
  const monitoredById = new Map(monitored.map((d) => [d.id, d]));

  // Per-device uptime = mean of the 1H AVAILABILITY rollup bucket avgs
  // (same derivation as /api/v1/performance/availability).
  const rollups = await fetchRollups("1H", since, ["AVAILABILITY"]);
  const valuesByDevice = new Map<string, number[]>();
  for (const row of rollups) {
    if (!monitoredById.has(row.deviceId)) continue;
    const values = valuesByDevice.get(row.deviceId) ?? [];
    values.push(row.avg);
    valuesByDevice.set(row.deviceId, values);
  }

  const perDevice: ReportRow[] = [];
  for (const device of monitored) {
    const values = valuesByDevice.get(device.id);
    if (!values || values.length === 0) continue;
    const uptimePct = round1(
      values.reduce((acc, v) => acc + v, 0) / values.length
    );
    const downtimeMinutes = round1(
      values.reduce((acc, avg) => acc + (100 - avg) / 100, 0) * bucketMinutes
    );
    const state =
      uptimePct >= 99.5 ? "UP" : uptimePct > 5 ? "DEGRADED" : "DOWN";
    perDevice.push({
      hostname: device.hostname,
      site: device.site?.code ?? "—",
      uptimePct,
      downtimeMinutes,
      state,
      slaDelta: round1(uptimePct - slaTargetPct),
    });
  }
  perDevice.sort((a, b) => Number(a.uptimePct) - Number(b.uptimePct));
  const rows = perDevice.slice(0, MAX_ROWS);

  return {
    reportType: "AVAILABILITY",
    generatedAt: new Date().toISOString(),
    range: expectedRangeFor("AVAILABILITY", frequency),
    format,
    columns: [
      { key: "hostname", label: "Device" },
      { key: "site", label: "Site" },
      { key: "uptimePct", label: "Uptime %" },
      { key: "downtimeMinutes", label: "Downtime (min)" },
      { key: "state", label: "State" },
      { key: "slaDelta", label: `SLA delta (vs ${slaTargetPct}%)` },
    ],
    rows,
  };
}

/* ───────────────────────── BACKUP_COMPLIANCE ───────────────────────── */

async function generateBackupCompliance(
  format: string
): Promise<ReportArtifact> {
  const now = Date.now();
  const compliantCutoff = new Date(now - COMPLIANT_WINDOW_MS);
  const atRiskCutoff = new Date(now - AT_RISK_WINDOW_MS);

  const devices = await db.device.findMany({
    where: { status: { not: "UNMANAGED" } },
    select: {
      id: true,
      hostname: true,
      lastBackupAt: true,
      site: { select: { code: true, name: true } },
    },
    orderBy: { hostname: "asc" },
  });

  // Same banding as /api/v1/compliance/backup: COMPLIANT ≤ 24 h,
  // OVERDUE 24–72 h, STALE > 72 h, NEVER_BACKED_UP.
  const rows: ReportRow[] = devices
    .map((device) => {
      const last = device.lastBackupAt;
      let band: string;
      if (!last) band = "NEVER_BACKED_UP";
      else if (last >= compliantCutoff) band = "COMPLIANT";
      else if (last >= atRiskCutoff) band = "OVERDUE";
      else band = "STALE";
      const ageHours = last ? round1((now - last.getTime()) / HOUR_MS) : null;
      return {
        hostname: device.hostname,
        site: device.site?.code ?? "—",
        lastBackupAt: last ? last.toISOString() : null,
        ageHours,
        band,
        compliant: band === "COMPLIANT" ? "YES" : "NO",
      };
    })
    .sort((a, b) => {
      // Worst first: never backed up, then oldest lastBackupAt.
      const aAge = a.ageHours;
      const bAge = b.ageHours;
      if (aAge === null && bAge === null) {
        return String(a.hostname).localeCompare(String(b.hostname));
      }
      if (aAge === null) return -1;
      if (bAge === null) return 1;
      return bAge - aAge;
    })
    .slice(0, MAX_ROWS);

  return {
    reportType: "BACKUP_COMPLIANCE",
    generatedAt: new Date().toISOString(),
    range: "CURRENT_SNAPSHOT",
    format,
    columns: [
      { key: "hostname", label: "Device" },
      { key: "site", label: "Site" },
      { key: "lastBackupAt", label: "Last successful backup (UTC)" },
      { key: "ageHours", label: "Age (hours)" },
      { key: "band", label: "Band" },
      { key: "compliant", label: "Compliant (≤24h)" },
    ],
    rows,
  };
}

/* ───────────────────────── CHANGE_SUMMARY ───────────────────────── */

async function generateChangeSummary(
  frequency: string,
  format: string
): Promise<ReportArtifact> {
  const since = new Date(Date.now() - 30 * DAY_MS);

  const changes = await db.changeRequest.findMany({
    where: { createdAt: { gte: since } },
    select: { status: true, riskLevel: true },
  });

  const byStatus = new Map<string, Record<string, number>>();
  for (const change of changes) {
    const entry =
      byStatus.get(change.status) ??
      { low: 0, medium: 0, high: 0, critical: 0, total: 0 };
    const risk = change.riskLevel.toLowerCase();
    if (
      risk === "low" ||
      risk === "medium" ||
      risk === "high" ||
      risk === "critical"
    ) {
      entry[risk] += 1;
    }
    entry.total += 1;
    byStatus.set(change.status, entry);
  }

  const rows: ReportRow[] = [...byStatus.entries()]
    .map(([status, counts]): ReportRow => ({
      status,
      low: counts.low,
      medium: counts.medium,
      high: counts.high,
      critical: counts.critical,
      total: counts.total,
    }))
    .sort((a, b) => Number(b.total) - Number(a.total))
    .slice(0, MAX_ROWS);

  return {
    reportType: "CHANGE_SUMMARY",
    generatedAt: new Date().toISOString(),
    range: expectedRangeFor("CHANGE_SUMMARY", frequency),
    format,
    columns: [
      { key: "status", label: "Change status" },
      { key: "low", label: "Low risk" },
      { key: "medium", label: "Medium risk" },
      { key: "high", label: "High risk" },
      { key: "critical", label: "Critical risk" },
      { key: "total", label: "Total (30d)" },
    ],
    rows,
  };
}

/* ───────────────────────── INCIDENT_SUMMARY ───────────────────────── */

async function generateIncidentSummary(
  frequency: string,
  format: string
): Promise<ReportArtifact> {
  const now = new Date();
  const since = new Date(now.getTime() - 30 * DAY_MS);

  const incidents = await db.incident.findMany({
    where: { createdAt: { gte: since } },
    select: {
      severity: true,
      status: true,
      createdAt: true,
      acknowledgedAt: true,
      resolvedAt: true,
      slaDueAt: true,
    },
  });

  const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;
  const openStatuses = new Set<string>(INCIDENT_OPEN_STATUSES);

  interface SeverityBucket {
    created: number;
    open: number;
    resolved: number;
    breached: number;
    mttaTotalMs: number;
    mttaSamples: number;
    mttrTotalMs: number;
    mttrSamples: number;
  }
  const bySeverity = new Map<string, SeverityBucket>();
  for (const incident of incidents) {
    const bucket =
      bySeverity.get(incident.severity) ??
      {
        created: 0,
        open: 0,
        resolved: 0,
        breached: 0,
        mttaTotalMs: 0,
        mttaSamples: 0,
        mttrTotalMs: 0,
        mttrSamples: 0,
      };
    bucket.created += 1;
    const isOpen = openStatuses.has(incident.status);
    if (isOpen) bucket.open += 1;
    if (incident.resolvedAt) {
      bucket.resolved += 1;
      bucket.mttrTotalMs +=
        incident.resolvedAt.getTime() - incident.createdAt.getTime();
      bucket.mttrSamples += 1;
      if (
        incident.slaDueAt &&
        incident.resolvedAt > new Date(incident.slaDueAt)
      ) {
        bucket.breached += 1;
      }
    } else if (isOpen && incident.slaDueAt && incident.slaDueAt < now) {
      bucket.breached += 1;
    }
    if (incident.acknowledgedAt) {
      bucket.mttaTotalMs +=
        incident.acknowledgedAt.getTime() - incident.createdAt.getTime();
      bucket.mttaSamples += 1;
    }
    bySeverity.set(incident.severity, bucket);
  }

  const severityOrder = ["SEV1", "SEV2", "SEV3", "SEV4"];
  const rows: ReportRow[] = [...bySeverity.entries()]
    .sort(
      (a, b) =>
        severityOrder.indexOf(a[0]) - severityOrder.indexOf(b[0]) ||
        a[0].localeCompare(b[0])
    )
    .map(([severity, bucket]) => ({
      severity,
      created: bucket.created,
      open: bucket.open,
      resolved: bucket.resolved,
      breached: bucket.breached,
      mttaMinutes:
        bucket.mttaSamples > 0
          ? minutes(bucket.mttaTotalMs / bucket.mttaSamples)
          : null,
      mttrMinutes:
        bucket.mttrSamples > 0
          ? minutes(bucket.mttrTotalMs / bucket.mttrSamples)
          : null,
    }))
    .slice(0, MAX_ROWS);

  return {
    reportType: "INCIDENT_SUMMARY",
    generatedAt: new Date().toISOString(),
    range: expectedRangeFor("INCIDENT_SUMMARY", frequency),
    format,
    columns: [
      { key: "severity", label: "Severity" },
      { key: "created", label: "Created (30d)" },
      { key: "open", label: "Still open" },
      { key: "resolved", label: "Resolved" },
      { key: "breached", label: "SLA breached" },
      { key: "mttaMinutes", label: "MTTA (min)" },
      { key: "mttrMinutes", label: "MTTR (min)" },
    ],
    rows,
  };
}

/* ───────────────────────── CAPACITY ───────────────────────── */

async function generateCapacity(
  frequency: string,
  format: string
): Promise<ReportArtifact> {
  const days = 30;
  const since = new Date(Date.now() - days * DAY_MS);

  const devices = await db.device.findMany({
    select: { id: true, hostname: true, site: { select: { code: true } } },
    orderBy: { hostname: "asc" },
  });
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  const rollups = await fetchRollups("1D", since, [
    "CPU",
    "MEMORY",
    "UTILIZATION_IN",
    "UTILIZATION_OUT",
  ]);

  // Combined per-day UTILIZATION (max of both directions) — same as the
  // capacity API; CPU/MEMORY keep their own daily series.
  const utilCombined = new Map<string, Map<number, number>>();
  const seriesData = new Map<string, Map<string, Array<{ ts: number; value: number }>>>();
  for (const row of rollups) {
    if (!deviceById.has(row.deviceId)) continue;
    if (row.metric === "UTILIZATION_IN" || row.metric === "UTILIZATION_OUT") {
      let byDay = utilCombined.get(row.deviceId);
      if (!byDay) {
        byDay = new Map();
        utilCombined.set(row.deviceId, byDay);
      }
      const ts = row.periodStart.getTime();
      byDay.set(ts, Math.max(byDay.get(ts) ?? 0, row.avg));
      continue;
    }
    let byMetric = seriesData.get(row.deviceId);
    if (!byMetric) {
      byMetric = new Map();
      seriesData.set(row.deviceId, byMetric);
    }
    const points = byMetric.get(row.metric) ?? [];
    points.push({ ts: row.periodStart.getTime(), value: row.avg });
    byMetric.set(row.metric, points);
  }

  interface CapacityRow {
    hostname: string;
    site: string | null;
    metric: string;
    currentPct: number;
    slopePerDay: number;
    daysToThreshold: number | null;
    confidence: string;
    sortKey: number;
  }

  const pool: CapacityRow[] = [];

  const consider = (
    device: (typeof devices)[number],
    metric: string,
    points: Array<{ ts: number; value: number }>
  ) => {
    if (points.length < CAPACITY_MIN_POINTS) return;
    const chronological = [...points].sort((a, b) => a.ts - b.ts);
    const values = chronological.map((p) => p.value);
    const regression = linearRegressionDaily(values);
    if (!regression) return;
    const current = values[values.length - 1];
    const slopePerDay = regression.slopePerDay;

    let daysToThreshold: number | null = null;
    if (slopePerDay > 0 && current < CAPACITY_HORIZON_PCT) {
      daysToThreshold = (CAPACITY_HORIZON_PCT - current) / slopePerDay;
    }
    // Risk-pool gate (frozen contract on the capacity API).
    if (current < CAPACITY_MIN_CURRENT_PCT && slopePerDay <= 0) return;

    pool.push({
      hostname: device.hostname,
      site: device.site?.code ?? null,
      metric,
      currentPct: round1(current),
      slopePerDay: Math.round(slopePerDay * 1000) / 1000,
      daysToThreshold:
        daysToThreshold === null ? null : Math.round(daysToThreshold * 10) / 10,
      confidence: confidenceFromR2(regression.r2),
      sortKey:
        daysToThreshold === null ? Number.POSITIVE_INFINITY : daysToThreshold,
    });
  };

  for (const device of devices) {
    const byMetric = seriesData.get(device.id);
    if (byMetric) {
      for (const metric of ["CPU", "MEMORY"]) {
        const points = byMetric.get(metric);
        if (points) consider(device, metric, points);
      }
    }
    const utilByDay = utilCombined.get(device.id);
    if (utilByDay && utilByDay.size > 0) {
      consider(
        device,
        "UTILIZATION",
        [...utilByDay.entries()].map(([ts, value]) => ({ ts, value }))
      );
    }
  }

  pool.sort((a, b) => a.sortKey - b.sortKey);

  const rows: ReportRow[] = pool.slice(0, MAX_ROWS).map((row) => ({
    hostname: row.hostname,
    site: row.site,
    metric: row.metric,
    currentPct: row.currentPct,
    slopePerDay: row.slopePerDay,
    daysToThreshold: row.daysToThreshold,
    confidence: row.confidence,
  }));

  return {
    reportType: "CAPACITY",
    generatedAt: new Date().toISOString(),
    range: expectedRangeFor("CAPACITY", frequency),
    format,
    columns: [
      { key: "hostname", label: "Device" },
      { key: "site", label: "Site" },
      { key: "metric", label: "Metric" },
      { key: "currentPct", label: "Current %" },
      { key: "slopePerDay", label: "Slope %/day" },
      { key: "daysToThreshold", label: `Days to ${CAPACITY_HORIZON_PCT}%` },
      { key: "confidence", label: "Confidence" },
    ],
    rows,
  };
}

/* ───────────────────────── entry point ───────────────────────── */

/**
 * Generate a report artifact from live data. Throws on unknown types and
 * on data-layer failures — the caller maps errors to the job's failure path.
 */
export async function generateReport(
  reportType: string,
  opts: { frequency?: string; format?: string } = {}
): Promise<ReportArtifact> {
  const frequency = opts.frequency ?? "WEEKLY";
  const format = opts.format ?? "JSON";
  switch (reportType) {
    case "AVAILABILITY":
      return generateAvailability(frequency, format);
    case "BACKUP_COMPLIANCE":
      return generateBackupCompliance(format);
    case "CHANGE_SUMMARY":
      return generateChangeSummary(frequency, format);
    case "INCIDENT_SUMMARY":
      return generateIncidentSummary(frequency, format);
    case "CAPACITY":
      return generateCapacity(frequency, format);
    default:
      throw new Error(`Unsupported report type: ${reportType}`);
  }
}

/**
 * Render an artifact as RFC-4180 CSV (CRLF line endings, quote/double-quote
 * escaping). Null/undefined cells become empty values. Direction-agnostic:
 * cell values are data (ISO timestamps, hostnames, numbers), so the file
 * reads identically in LTR and RTL contexts.
 */
export function artifactToCsv(artifact: ReportArtifact): string {
  const escape = (value: ReportRow[string] | undefined): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [
    artifact.columns.map((column) => escape(column.label)).join(","),
  ];
  for (const row of artifact.rows) {
    lines.push(
      artifact.columns.map((column) => escape(row[column.key])).join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}
