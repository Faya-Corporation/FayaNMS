import { db } from "@/lib/db";
import { newCorrelationId } from "@/app/api/v1/_lib/api";
import { parsePolicyScope } from "@/app/api/v1/_lib/scope";
import {
  createIncidentForAlert,
  ALERT_SEVERITY_TO_INCIDENT,
} from "@/lib/incidents/create";

/**
 * Alert threshold evaluation engine (Task 5-a).
 *
 * Pure-Next implementation so it is reusable and reviewable: the worker
 * never opens SQLite — it claims an ALERT_EVALUATION job and calls
 * POST /api/v1/alerts/evaluate, which runs `runAlertEvaluation` below
 * (evaluate-in-Next, same architecture as the 3-c drift engine).
 *
 * Evaluation pipeline (documented choices):
 *   1. Load every ACTIVE AlertRule; resolve scopeJson → device set.
 *      Scope keys follow the 3-a conventions ({ siteCodes, criticalities,
 *      deviceRoles }); UNMANAGED devices are always excluded; OFFLINE
 *      devices are excluded for normal metrics but evaluated for the
 *      AVAILABILITY pseudo-metric (they are exactly its target).
 *   2. Threshold metrics (CPU, MEMORY, UTILIZATION_IN/OUT, LATENCY_MS,
 *      PACKET_LOSS, SESSIONS, TEMPERATURE): the rule breaches when the AVG
 *      of MetricSamples inside the rule's durationMinutes window satisfies
 *      the operator/threshold (avg-over-window — smooths the 5-min sample
 *      spikes, documented instead of "latest"). No samples in the window ⇒
 *      no fire and no resolve (sparse data never flaps the stream).
 *      Pseudo-metric AVAILABILITY: 0 when the device is OFFLINE or UNKNOWN
 *      with lastSeen older than 10 min, else 1 — state-based, no samples.
 *   3. Dedup: fingerprint dedupKey = "<deviceId>:<metric>:<ruleId>". An
 *      existing ACTIVE/ACKNOWLEDGED alert with the same key is updated
 *      (lastSeen + count) instead of duplicated. Legacy rows (ruleId set,
 *      dedupKey null — Phase-1 seed) are matched by deviceId+ruleId and
 *      migrated onto the fingerprint on first touch.
 *   4. Maintenance-window suppression: a device (or its site) inside an
 *      active MaintenanceWindow never fires — new alerts are born
 *      SUPPRESSED with suppressReason "Maintenance window: <name>", and
 *      existing ACTIVE engine alerts are suppressed the same way
 *      (ACKNOWLEDGED ones keep the human ownership and stay).
 *   5. Root/child grouping (Gate G5): when a device is unreachable, the
 *      AVAILABILITY rule produces the ROOT alert; any other rule breaching
 *      for the same device (and any existing ACTIVE engine alert on it)
 *      becomes/turns into a SUPPRESSED CHILD (parentAlertId set,
 *      suppressReason "Suppressed by root alert"). The root fires alone.
 *      While the root is open its children stay suppressed; after the root
 *      resolves, children re-activate if their own condition still holds,
 *      or resolve with it.
 *   6. Auto-resolve: a rule that no longer breaches resolves its open
 *      alert — threshold metrics need the recent window AND the previous
 *      equal window both non-breaching (2 consecutive windows); recovery
 *      of AVAILABILITY resolves immediately (state-based).
 *   7. Incident auto-creation: a NEW CRITICAL/HIGH alert (not a dedup
 *      update, not suppressed) on a device WITHOUT an open incident
 *      creates one through the shared module (src/lib/incidents/create.ts)
 *      — SEV1..SEV4 mapping + SLA due — and links Alert.incidentId.
 *      Incidents are human-resolved (5-b); the engine never closes them.
 *   8. Notifications: broadcast rows for CRITICAL/HIGH fires and for
 *      auto-created incidents (§74 surface, capped per run).
 *   9. Audit: ALERT_FIRED / ALERT_SUPPRESSED / ALERT_RESOLVED per alert
 *      plus one ALERT_EVALUATION_COMPLETED summary per run
 *      (actor "system:alert-engine").
 *
 * Flood caps per run: 50 new alerts, 10 incidents, 40 notifications.
 */

export const ALERT_RULE_METRICS = [
  "CPU",
  "MEMORY",
  "LATENCY_MS",
  "PACKET_LOSS",
  "UTILIZATION_IN",
  "UTILIZATION_OUT",
  "SESSIONS",
  "TEMPERATURE",
  "AVAILABILITY",
] as const;

export const ALERT_RULE_OPERATORS = ["GT", "LT", "GTE", "LTE", "EQ"] as const;

const AVAILABILITY_STALE_UNKNOWN_MIN = 10;

/** Engine-managed statuses considered "open" for dedup. */
const OPEN_STATUSES = ["ACTIVE", "ACKNOWLEDGED", "SUPPRESSED"] as const;

const MAINTENANCE_REASON_PREFIX = "Maintenance window: ";
export const ROOT_SUPPRESS_PREFIX = "Suppressed by root alert: ";

const MAX_NEW_ALERTS_PER_RUN = 50;
const MAX_INCIDENTS_PER_RUN = 10;
const MAX_NOTIFICATIONS_PER_RUN = 40;

/** Human label/unit per metric for alert messages + notifications. */
const METRIC_LABELS: Record<string, { label: string; unit: string }> = {
  CPU: { label: "CPU utilization", unit: "%" },
  MEMORY: { label: "Memory utilization", unit: "%" },
  LATENCY_MS: { label: "Latency", unit: " ms" },
  PACKET_LOSS: { label: "Packet loss", unit: "%" },
  UTILIZATION_IN: { label: "Inbound utilization", unit: "%" },
  UTILIZATION_OUT: { label: "Outbound utilization", unit: "%" },
  SESSIONS: { label: "Session count", unit: "" },
  TEMPERATURE: { label: "Temperature", unit: " °C" },
};

const OPERATOR_LABELS: Record<string, string> = {
  GT: ">",
  GTE: "≥",
  LT: "<",
  LTE: "≤",
  EQ: "=",
};

export interface AlertEvaluationSummary {
  evaluatedAt: string;
  triggeredBy: string;
  rulesEvaluated: number;
  devicesConsidered: number;
  fired: number;
  deduped: number;
  /** Existing alerts transitioned into SUPPRESSED this run (window / root). */
  suppressed: number;
  /** New alerts born SUPPRESSED as root-alert children. */
  childrenSuppressed: number;
  resolved: number;
  incidentsCreated: number;
  notificationsCreated: number;
  caps: { newAlerts: boolean; incidents: boolean; notifications: boolean };
}

interface EvalRule {
  id: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  durationMinutes: number;
  severity: string;
}

interface EvalDevice {
  id: string;
  hostname: string;
  status: string;
  lastSeen: Date | null;
  siteId: string | null;
}

interface ExistingAlert {
  id: string;
  deviceId: string;
  ruleId: string | null;
  dedupKey: string | null;
  status: string;
  suppressReason: string | null;
  parentAlertId: string | null;
}

function compare(a: number, operator: string, b: number): boolean {
  switch (operator) {
    case "GT":
      return a > b;
    case "GTE":
      return a >= b;
    case "LT":
      return a < b;
    case "LTE":
      return a <= b;
    case "EQ":
      return Math.abs(a - b) < 1e-9;
    default:
      return false;
  }
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** Pseudo-metric availability: 0 unreachable, 1 reachable. */
function availabilityOf(device: EvalDevice, now: Date): number {
  if (device.status === "OFFLINE") return 0;
  if (
    device.status === "UNKNOWN" &&
    (!device.lastSeen ||
      now.getTime() - device.lastSeen.getTime() >
        AVAILABILITY_STALE_UNKNOWN_MIN * 60_000)
  ) {
    return 0;
  }
  return 1;
}

/**
 * Device set for one rule. Reuses the 3-a scope parsing conventions
 * (siteCodes/criticalities via parsePolicyScope) and adds deviceRoles.
 * OFFLINE devices are excluded for everything except AVAILABILITY.
 */
async function ruleDeviceWhere(
  rule: EvalRule,
  scopeText: string | null | undefined
) {
  const scope = parsePolicyScope(scopeText);
  const roles =
    scopeText
      ? (() => {
          try {
            const parsed: unknown = JSON.parse(scopeText);
            const raw =
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>).deviceRoles
                : null;
            return Array.isArray(raw)
              ? raw.filter((r): r is string => typeof r === "string" && r.length > 0)
              : null;
          } catch {
            return null;
          }
        })()
      : null;

  const statusExclusions: string[] = ["UNMANAGED"];
  if (rule.metric !== "AVAILABILITY") statusExclusions.push("OFFLINE");

  return {
    AND: [
      { status: { notIn: statusExclusions } },
      ...(scope.criticalities
        ? [{ criticality: { in: scope.criticalities } }]
        : []),
      ...(scope.siteCodes && !scope.siteCodes.includes("*")
        ? [{ site: { code: { in: scope.siteCodes } } }]
        : []),
      ...(roles ? [{ role: { in: roles } }] : []),
    ],
  };
}

/**
 * Run one full evaluation pass. `correlationId` ties audits together
 * (engine passes the job's correlation id; manual runs get ALR-XXXXXX).
 */
export async function runAlertEvaluation(options: {
  triggeredBy?: string;
  correlationId?: string;
}): Promise<AlertEvaluationSummary> {
  const now = new Date();
  const triggeredBy = options.triggeredBy ?? "MANUAL";
  const correlationId = options.correlationId ?? newCorrelationId("ALR");

  const summary: AlertEvaluationSummary = {
    evaluatedAt: now.toISOString(),
    triggeredBy,
    rulesEvaluated: 0,
    devicesConsidered: 0,
    fired: 0,
    deduped: 0,
    suppressed: 0,
    childrenSuppressed: 0,
    resolved: 0,
    incidentsCreated: 0,
    notificationsCreated: 0,
    caps: { newAlerts: false, incidents: false, notifications: false },
  };

  const rules = await db.alertRule.findMany({ where: { isActive: true } });
  if (rules.length === 0) {
    return summary;
  }
  summary.rulesEvaluated = rules.length;

  /* ── resolve scopes → device sets ──────────────────────────────────── */
  const deviceById = new Map<string, EvalDevice>();
  const pairs: Array<{ rule: EvalRule; device: EvalDevice }> = [];
  for (const rule of rules) {
    const where = await ruleDeviceWhere(rule, rule.scopeJson);
    const devices = await db.device.findMany({
      where,
      select: {
        id: true,
        hostname: true,
        status: true,
        lastSeen: true,
        siteId: true,
      },
    });
    for (const device of devices) {
      deviceById.set(device.id, device);
      pairs.push({ rule, device });
    }
  }
  summary.devicesConsidered = deviceById.size;
  if (pairs.length === 0) return summary;

  // AVAILABILITY (root) rules evaluate FIRST so dependent alerts fired in
  // the same pass are parented to the real root row, never a placeholder.
  pairs.sort(
    (a, b) =>
      (a.rule.metric === "AVAILABILITY" ? 0 : 1) -
      (b.rule.metric === "AVAILABILITY" ? 0 : 1)
  );

  /* ── maintenance windows (device-scoped + site-scoped) ─────────────── */
  const windows = await db.maintenanceWindow.findMany({
    where: {
      isActive: true,
      startsAt: { lte: now },
      endsAt: { gte: now },
    },
    select: { id: true, name: true, deviceId: true, siteId: true },
  });
  const windowByDevice = new Map<string, string>();
  const windowBySite = new Map<string, string>();
  for (const w of windows) {
    if (w.deviceId && !windowByDevice.has(w.deviceId)) {
      windowByDevice.set(w.deviceId, w.name);
    }
    if (w.siteId && !windowBySite.has(w.siteId)) {
      windowBySite.set(w.siteId, w.name);
    }
  }
  const maintenanceFor = (device: EvalDevice): string | null =>
    windowByDevice.get(device.id) ??
    (device.siteId ? windowBySite.get(device.siteId) : undefined) ??
    null;

  /* ── existing engine-managed alerts ────────────────────────────────── */
  const existingRows = await db.alert.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      OR: [
        { dedupKey: { not: null } },
        { ruleId: { not: null }, dedupKey: null },
      ],
    },
    select: {
      id: true,
      deviceId: true,
      ruleId: true,
      dedupKey: true,
      status: true,
      suppressReason: true,
      parentAlertId: true,
    },
  });
  const existingByKey = new Map<string, ExistingAlert>();
  const existingByDeviceRule = new Map<string, ExistingAlert>();
  for (const row of existingRows) {
    if (row.dedupKey && !existingByKey.has(row.dedupKey)) {
      existingByKey.set(row.dedupKey, row);
    }
    if (row.ruleId && !row.dedupKey) {
      const key = `${row.deviceId}:${row.ruleId}`;
      if (!existingByDeviceRule.has(key)) existingByDeviceRule.set(key, row);
    }
  }
  /** Root alert (AVAILABILITY) currently open per device — built as we go. */
  const openRootByDevice = new Map<string, ExistingAlert>();
  for (const row of existingRows) {
    if (
      row.dedupKey?.includes(":AVAILABILITY:") &&
      row.status === "ACTIVE" &&
      !openRootByDevice.has(row.deviceId)
    ) {
      openRootByDevice.set(row.deviceId, row);
    }
  }

  /* ── load samples for every needed (device, metric) combo ──────────── */
  const neededMetrics = new Set(
    rules.filter((r) => r.metric !== "AVAILABILITY").map((r) => r.metric)
  );
  const maxWindowMin = Math.max(
    ...rules.filter((r) => r.metric !== "AVAILABILITY").map((r) => r.durationMinutes),
    0
  );
  const samplesByDeviceMetric = new Map<string, Array<{ ts: Date; value: number }>>();
  if (neededMetrics.size > 0 && maxWindowMin > 0) {
    // Resolve pass needs the previous window too → load 2× the max window.
    const since = new Date(now.getTime() - 2 * maxWindowMin * 60_000);
    const samples = await db.metricSample.findMany({
      where: {
        deviceId: { in: [...deviceById.keys()] },
        metric: { in: [...neededMetrics] },
        ts: { gte: since },
      },
      select: { deviceId: true, metric: true, value: true, ts: true },
      orderBy: { ts: "asc" },
    });
    for (const s of samples) {
      const key = `${s.deviceId}:${s.metric}`;
      const list = samplesByDeviceMetric.get(key);
      if (list) list.push({ ts: s.ts, value: s.value });
      else samplesByDeviceMetric.set(key, [{ ts: s.ts, value: s.value }]);
    }
  }

  const windowAvg = (
    deviceId: string,
    metric: string,
    fromMs: number,
    toMs: number
  ): number | null => {
    const list = samplesByDeviceMetric.get(`${deviceId}:${metric}`) ?? [];
    const inWindow = list.filter(
      (s) => s.ts.getTime() >= fromMs && s.ts.getTime() < toMs
    );
    if (inWindow.length === 0) return null;
    return inWindow.reduce((sum, s) => sum + s.value, 0) / inWindow.length;
  };

  const breaches = (rule: EvalRule, device: EvalDevice): { breached: boolean; observed: number | null } => {
    if (rule.metric === "AVAILABILITY") {
      const availability = availabilityOf(device, now);
      return {
        breached: compare(availability, rule.operator, rule.threshold),
        observed: availability,
      };
    }
    const avg = windowAvg(
      device.id,
      rule.metric,
      now.getTime() - rule.durationMinutes * 60_000,
      now.getTime() + 1
    );
    return {
      breached: avg !== null && compare(avg, rule.operator, rule.threshold),
      observed: avg,
    };
  };

  const dedupKeyFor = (rule: EvalRule, deviceId: string): string =>
    `${deviceId}:${rule.metric}:${rule.id}`;

  const notify = async (row: {
    kind: string;
    title: string;
    body: string;
    link?: string;
    severity?: string;
  }): Promise<void> => {
    if (summary.notificationsCreated >= MAX_NOTIFICATIONS_PER_RUN) {
      summary.caps.notifications = true;
      return;
    }
    await db.notification.create({ data: { userId: null, ...row } });
    summary.notificationsCreated += 1;
  };

  /* ── pass 1: fires / dedup / suppression ───────────────────────────── */
  for (const { rule, device } of pairs) {
    const { breached, observed } = breaches(rule, device);
    const key = dedupKeyFor(rule, device.id);
    const existing =
      existingByKey.get(key) ?? existingByDeviceRule.get(`${device.id}:${rule.id}`);

    if (!breached) continue;

    if (existing) {
      // DEDUP — refresh the open alert instead of creating a duplicate.
      const suppressedByWindow =
        existing.status === "SUPPRESSED" &&
        (existing.suppressReason ?? "").startsWith(MAINTENANCE_REASON_PREFIX);
      const suppressedByRoot =
        existing.status === "SUPPRESSED" &&
        (existing.suppressReason ?? "").startsWith(ROOT_SUPPRESS_PREFIX);

      if (existing.status === "ACTIVE" || existing.status === "ACKNOWLEDGED") {
        const inMaintenance = maintenanceFor(device);
        if (existing.status === "ACTIVE" && inMaintenance) {
          // Existing ACTIVE alerts that fall inside a window are suppressed
          // too (ACKNOWLEDGED keeps human ownership — documented choice).
          await db.alert.update({
            where: { id: existing.id },
            data: {
              status: "SUPPRESSED",
              suppressReason: `${MAINTENANCE_REASON_PREFIX}${inMaintenance}`,
              lastSeen: now,
              count: { increment: 1 },
              dedupKey: key,
            },
          });
          summary.suppressed += 1;
        } else {
          await db.alert.update({
            where: { id: existing.id },
            data: { lastSeen: now, count: { increment: 1 }, dedupKey: key },
          });
          summary.deduped += 1;
        }
        if (rule.metric === "AVAILABILITY") openRootByDevice.set(device.id, existing);
        continue;
      }

      // SUPPRESSED — maintenance expiry re-activates; root release handled
      // by the children sweep below (root resolves first, next pass cleans).
      if (suppressedByWindow && !maintenanceFor(device)) {
        await db.alert.update({
          where: { id: existing.id },
          data: {
            status: "ACTIVE",
            suppressReason: null,
            lastSeen: now,
            count: { increment: 1 },
            dedupKey: key,
          },
        });
        summary.deduped += 1;
      } else {
        await db.alert.update({
          where: { id: existing.id },
          data: { lastSeen: now, count: { increment: 1 }, dedupKey: key },
        });
        summary.deduped += 1;
      }
      continue;
    }

    /* NEW FIRE */
    if (summary.fired + summary.childrenSuppressed >= MAX_NEW_ALERTS_PER_RUN) {
      summary.caps.newAlerts = true;
      continue;
    }

    const isAvailability = rule.metric === "AVAILABILITY";
    const maintenance = maintenanceFor(device);
    const root = isAvailability ? null : openRootByDevice.get(device.id) ?? null;

    let status = "ACTIVE";
    let suppressReason: string | null = null;
    let parentAlertId: string | null = null;

    if (maintenance) {
      status = "SUPPRESSED";
      suppressReason = `${MAINTENANCE_REASON_PREFIX}${maintenance}`;
      summary.suppressed += 1;
    } else if (root) {
      // Dependent alert on an unreachable device → suppressed CHILD (G5).
      status = "SUPPRESSED";
      suppressReason = `${ROOT_SUPPRESS_PREFIX}${root.id}`;
      parentAlertId = root.id;
      summary.childrenSuppressed += 1;
    } else {
      summary.fired += 1;
    }

    const label = METRIC_LABELS[rule.metric] ?? { label: rule.metric, unit: "" };
    const message = isAvailability
      ? `Device unreachable — availability ${fmt(observed ?? 0)} (${rule.operator} ${rule.threshold}) for ${rule.durationMinutes} min — rule "${rule.name}"`
      : `${label.label} ${fmt(observed ?? 0)}${label.unit} (${rule.operator} ${rule.threshold}${label.unit} for ${rule.durationMinutes} min) — rule "${rule.name}"`;

    const created = await db.alert.create({
      data: {
        deviceId: device.id,
        ruleId: rule.id,
        severity: rule.severity,
        message,
        status,
        suppressReason,
        parentAlertId,
        dedupKey: key,
        firstSeen: now,
        lastSeen: now,
        count: 1,
      },
      select: { id: true },
    });
    if (isAvailability && status === "ACTIVE") {
      // Root for this run — children fired later in the same pass (or the
      // children sweep below) parent onto this real row id.
      openRootByDevice.set(device.id, {
        id: created.id,
        deviceId: device.id,
        ruleId: rule.id,
        dedupKey: key,
        status: "ACTIVE",
        suppressReason: null,
        parentAlertId: null,
      });
    }

    await db.auditEvent.create({
      data: {
        actorName: "system:alert-engine",
        action: status === "ACTIVE" ? "ALERT_FIRED" : "ALERT_SUPPRESSED",
        resourceType: "Alert",
        resourceId: created.id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          rule: rule.name,
          metric: rule.metric,
          severity: rule.severity,
          status,
          observed,
          suppressReason,
          parentAlertId,
        }),
      },
    });

    /* Incident auto-creation + notifications — only for real fires. */
    if (status === "ACTIVE" && (rule.severity === "CRITICAL" || rule.severity === "HIGH")) {
      const openIncident = await db.incidentDevice.count({
        where: {
          deviceId: device.id,
          incident: { status: { notIn: ["RESOLVED", "CLOSED"] } },
        },
      });
      if (
        openIncident === 0 &&
        summary.incidentsCreated < MAX_INCIDENTS_PER_RUN
      ) {
        const result = await createIncidentForAlert({
          alert: {
            id: created.id,
            severity: rule.severity,
            message,
            deviceId: device.id,
          },
          device: {
            id: device.id,
            hostname: device.hostname,
            siteId: device.siteId,
          },
          source: "ALERT",
          correlationId,
        });
        if (result.created) {
          summary.incidentsCreated += 1;
          await notify({
            kind: "INCIDENT",
            title: `Incident ${result.incident?.number} auto-created`,
            body: `${device.hostname}: ${message}`,
            link: "ops.incidents",
            severity: result.incident?.severity,
          });
        }
      }
      await notify({
        kind: "ALERT",
        title: `${rule.severity} alert: ${label.label} on ${device.hostname}`,
        body: message,
        link: "ops.alerts",
        severity: rule.severity,
      });
    }
  }

  /* ── children sweep: existing ACTIVE alerts on unreachable devices ── */
  for (const [deviceId, root] of openRootByDevice) {
    if (!root.id) continue;
    const device = deviceById.get(deviceId);
    if (!device || maintenanceFor(device)) continue;
    const activeOnDevice = existingRows.filter(
      (row) =>
        row.deviceId === deviceId &&
        row.id !== root.id &&
        (row.status === "ACTIVE" || row.status === "ACKNOWLEDGED") &&
        !row.dedupKey?.includes(":AVAILABILITY:")
    );
    for (const row of activeOnDevice) {
      if (row.status !== "ACTIVE") continue; // ACKNOWLEDGED keeps ownership
      await db.alert.update({
        where: { id: row.id },
        data: {
          status: "SUPPRESSED",
          suppressReason: `${ROOT_SUPPRESS_PREFIX}${root.id}`,
          parentAlertId: root.id,
        },
      });
      summary.suppressed += 1;
    }
  }

  /* ── pass 2: auto-resolve ──────────────────────────────────────────── */
  const ruleById = new Map(rules.map((r) => [r.id as string, r]));
  for (const existing of existingRows) {
    if (existing.status !== "ACTIVE" && existing.status !== "ACKNOWLEDGED") continue;
    if (!existing.ruleId) continue;
    const rule = ruleById.get(existing.ruleId);
    if (!rule) continue; // rule deleted/inactive — alert is human-managed
    const device = deviceById.get(existing.deviceId);
    if (!device) continue;

    let recovered = false;
    if (rule.metric === "AVAILABILITY") {
      recovered = availabilityOf(device, now) === 1;
    } else {
      // 2 consecutive windows OK: recent window AND the one before it.
      const recent = windowAvg(
        device.id,
        rule.metric,
        now.getTime() - rule.durationMinutes * 60_000,
        now.getTime() + 1
      );
      const previous = windowAvg(
        device.id,
        rule.metric,
        now.getTime() - 2 * rule.durationMinutes * 60_000,
        now.getTime() - rule.durationMinutes * 60_000
      );
      if (recent === null || previous === null) continue; // sparse data → skip
      recovered =
        !compare(recent, rule.operator, rule.threshold) &&
        !compare(previous, rule.operator, rule.threshold);
    }
    if (!recovered) continue;

    await db.alert.update({
      where: { id: existing.id },
      data: { status: "RESOLVED", suppressReason: null },
    });
    summary.resolved += 1;
    await db.auditEvent.create({
      data: {
        actorName: "system:alert-engine",
        action: "ALERT_RESOLVED",
        resourceType: "Alert",
        resourceId: existing.id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          rule: rule.name,
          metric: rule.metric,
          reason: "condition recovered",
        }),
      },
    });
  }

  /* ── summary audit ─────────────────────────────────────────────────── */
  await db.auditEvent.create({
    data: {
      actorName: "system:alert-engine",
      action: "ALERT_EVALUATION_COMPLETED",
      resourceType: "AlertRule",
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        triggeredBy,
        rulesEvaluated: summary.rulesEvaluated,
        devicesConsidered: summary.devicesConsidered,
        fired: summary.fired,
        deduped: summary.deduped,
        suppressed: summary.suppressed,
        childrenSuppressed: summary.childrenSuppressed,
        resolved: summary.resolved,
        incidentsCreated: summary.incidentsCreated,
        notificationsCreated: summary.notificationsCreated,
      }),
    },
  });

  return summary;
}

/** Re-export for the manual escalation route (single severity map source). */
export { ALERT_SEVERITY_TO_INCIDENT };
