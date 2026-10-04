import { Prisma } from "@prisma/client";

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
 *      While the root is open its children stay suppressed; once no
 *      AVAILABILITY root is open for the device anymore, root-suppressed
 *      children re-activate on the next pass when their own condition still
 *      breaches, or auto-resolve when it has recovered (maintenance windows
 *      keep precedence — a window-suppressed row is owned by the window).
 *      A recovered root-suppressed child resolves with its parent link and
 *      suppress reason cleared.
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
 *
 * F-046 batching (outcome-preserving): rule scopes resolve from ONE
 * device.findMany + in-memory filtering (ruleDevicePredicate /
 * resolveRuleDevicePairs — the pair walk stays rule-major); the dedup
 * refresh writes are buffered per write-payload group and flushed as ONE
 * alert.updateMany per group after the pair walk (DedupUpdateBatch — legacy
 * rows still migrating onto the fingerprint dedupKey keep their per-row
 * update; pendingReactivatedRoots reproduces the old inline-write visibility
 * for openRootExists); the sample load is row-capped at
 * MAX_SAMPLES_PER_QUERY keeping the NEWEST rows.
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

/* ── suppression lifecycle predicates (RT-001/F-001) ───────────────────
 *
 * Exported pure helpers so the regression suite
 * (tests/audit/alert-suppression-reactivation.test.ts) can pin the exact
 * branch policy that used to be buried — and for root-suppressed rows,
 * dead — inside the evaluation passes.
 */

/** Row is SUPPRESSED by a maintenance window ("Maintenance window: …"). */
export function isWindowSuppressed(
  status: string,
  suppressReason: string | null
): boolean {
  return (
    status === "SUPPRESSED" &&
    (suppressReason ?? "").startsWith(MAINTENANCE_REASON_PREFIX)
  );
}

/** Row is SUPPRESSED by a root alert ("Suppressed by root alert: …"). */
export function isRootSuppressed(
  status: string,
  suppressReason: string | null
): boolean {
  return (
    status === "SUPPRESSED" &&
    (suppressReason ?? "").startsWith(ROOT_SUPPRESS_PREFIX)
  );
}

/**
 * Pass-1 reactivation policy for a still-breaching SUPPRESSED row:
 *   - a window-suppressed row re-activates when its window ended;
 *   - a root-suppressed row re-activates when no AVAILABILITY root is open
 *     for the device anymore (G5 release);
 *   - an active maintenance window keeps precedence in both cases;
 *   - anything else (unknown/manual suppression reason) stays untouched.
 */
export function shouldReactivateSuppressedRow(
  status: string,
  suppressReason: string | null,
  maintenanceActive: boolean,
  openRootExists: boolean
): boolean {
  if (status !== "SUPPRESSED" || maintenanceActive) return false;
  if (isWindowSuppressed(status, suppressReason)) return true;
  return isRootSuppressed(status, suppressReason) && !openRootExists;
}

/**
 * Pass-2 auto-resolve eligibility: open engine rows plus root-suppressed
 * children (previously unreachable — zombie SUPPRESSED rows). A
 * maintenance-suppressed row is owned by its window and is never
 * auto-resolved by recovery.
 */
export function isAutoResolveCandidate(
  status: string,
  suppressReason: string | null
): boolean {
  if (status === "ACTIVE" || status === "ACKNOWLEDGED") return true;
  return isRootSuppressed(status, suppressReason);
}

const MAX_NEW_ALERTS_PER_RUN = 50;
const MAX_INCIDENTS_PER_RUN = 10;
const MAX_NOTIFICATIONS_PER_RUN = 40;

/**
 * F-046: hard row cap on the evaluation's metricSample load — applied PER
 * (device, metric) SERIES, not fleet-wide. At the fleet's 5-minute
 * collection cadence 20 000 rows ≈ 69 days of continuous history for one
 * series — far above any rule window — so the cap only binds on runaway
 * retention gaps, bounding memory/IO per pass.
 *
 * Wave-6 correction: the cap originally rode a fleet-wide `take` on the
 * single aggregate query. Whenever 20 000 < fleet rows but the recent
 * window alone fit under the cap, the PREVIOUS window arrived partially
 * truncated — `windowAvg` then averaged a biased subset, pass 2's
 * empty-window sparse-data skip never fired, and a legal 1440-minute rule
 * on a mid-sized fleet could false-RESOLVE or miss a fire. The load is
 * now a window function that keeps the NEWEST MAX_SAMPLES_PER_QUERY rows
 * of EVERY series in one round-trip: when the cap binds it drops only a
 * series' OLDEST rows (never its in-progress breach window), and for any
 * sane cadence it never binds at all — the per-series invariant the
 * original docblock claimed now actually holds.
 */
export const MAX_SAMPLES_PER_QUERY = 20_000;

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
  /** SUPPRESSED rows re-activated this run (window expiry / root release). */
  reactivated: number;
  /** Existing alerts transitioned into SUPPRESSED this run (window / root). */
  suppressed: number;
  /** New alerts born SUPPRESSED as root-alert children. */
  childrenSuppressed: number;
  resolved: number;
  incidentsCreated: number;
  notificationsCreated: number;
  caps: { newAlerts: boolean; incidents: boolean; notifications: boolean };
}

export interface EvalRule {
  id: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  durationMinutes: number;
  severity: string;
}

export interface EvalDevice {
  id: string;
  hostname: string;
  status: string;
  lastSeen: Date | null;
  siteId: string | null;
  /** F-046: in-memory scope-filter inputs for the single device query. */
  criticality: string | null;
  role: string | null;
  siteCode: string | null;
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

/** One metricSample row as selected by the evaluation pass. */
export interface SampleRow {
  deviceId: string;
  metric: string;
  value: number;
  ts: Date;
}

/**
 * F-046: index the sample rows per "<deviceId>:<metric>" series. The capped
 * load fetches newest-first (orderBy ts desc + take MAX_SAMPLES_PER_QUERY —
 * see that constant); this restores the ascending per-series order the old
 * uncapped asc load produced (the window math is order-independent, the asc
 * structure keeps the map identical).
 */
export function indexSamples(
  samples: SampleRow[]
): Map<string, Array<{ ts: Date; value: number }>> {
  const byDeviceMetric = new Map<string, Array<{ ts: Date; value: number }>>();
  for (const s of samples) {
    const key = `${s.deviceId}:${s.metric}`;
    const list = byDeviceMetric.get(key);
    if (list) list.push({ ts: s.ts, value: s.value });
    else byDeviceMetric.set(key, [{ ts: s.ts, value: s.value }]);
  }
  for (const list of byDeviceMetric.values()) list.reverse();
  return byDeviceMetric;
}

/**
 * F-046: deviceRoles scope parsing (was inlined in the old Prisma-where
 * builder) — array of non-empty strings, or null when absent/malformed.
 */
function parseDeviceRoles(
  scopeText: string | null | undefined
): string[] | null {
  if (!scopeText) return null;
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
}

/**
 * Device-set predicate for one rule — the F-046 in-memory twin of the old
 * per-rule Prisma where-builder. Reuses the 3-a scope parsing conventions
 * (siteCodes/criticalities via parsePolicyScope) and adds deviceRoles.
 * Semantics match the old SQL filters exactly:
 *   - UNMANAGED devices are always excluded; OFFLINE is excluded for
 *     everything except AVAILABILITY (they are exactly its target);
 *   - a scope list matches non-null values only (SQL `IN` never matches
 *     NULL — siteless/roleless devices stay out of scoped rules);
 *   - siteCodes containing "*" (or absent) = every site, siteless included.
 */
export function ruleDevicePredicate(
  rule: Pick<EvalRule, "metric">,
  scopeText: string | null | undefined
): (device: EvalDevice) => boolean {
  const scope = parsePolicyScope(scopeText);
  const roles = parseDeviceRoles(scopeText);
  const statusExclusions: string[] = ["UNMANAGED"];
  if (rule.metric !== "AVAILABILITY") statusExclusions.push("OFFLINE");

  return (device) => {
    if (statusExclusions.includes(device.status)) return false;
    if (
      scope.criticalities &&
      !scope.criticalities.includes(device.criticality ?? "")
    ) {
      return false;
    }
    if (scope.siteCodes && !scope.siteCodes.includes("*")) {
      if (!device.siteCode || !scope.siteCodes.includes(device.siteCode)) {
        return false;
      }
    }
    if (roles && (device.role === null || !roles.includes(device.role))) {
      return false;
    }
    return true;
  };
}

/**
 * F-046: resolve every rule's device set from ONE device list with
 * in-memory filtering (the old engine ran one device.findMany per rule).
 * Pairs are built rule-major — rules in the given order, devices in list
 * order within each rule — matching the old per-rule query flow; the caller
 * keeps the AVAILABILITY-first stable sort on top. `deviceById` holds the
 * union of matched devices (summary.devicesConsidered).
 */
export function resolveRuleDevicePairs(
  rules: Array<EvalRule & { scopeJson: string | null }>,
  devices: EvalDevice[]
): {
  deviceById: Map<string, EvalDevice>;
  pairs: Array<{ rule: EvalRule; device: EvalDevice }>;
} {
  const predicates = rules.map((rule) => ({
    rule,
    matches: ruleDevicePredicate(rule, rule.scopeJson),
  }));
  const deviceById = new Map<string, EvalDevice>();
  const pairs: Array<{ rule: EvalRule; device: EvalDevice }> = [];
  for (const { rule, matches } of predicates) {
    for (const device of devices) {
      if (!matches(device)) continue;
      deviceById.set(device.id, device);
      pairs.push({ rule, device });
    }
  }
  return { deviceById, pairs };
}

/* ── F-046: batched dedup writes ───────────────────────────────────────
 *
 * Pass 1 used to run one `alert.update` per open breaching pair; identical
 * write payloads are now grouped and flushed as ONE `alert.updateMany` per
 * group after the pair walk. Groups are keyed by write payload:
 *   - "dedup:touch" — the plain lastSeen/count refresh (ACTIVE rows,
 *     ACKNOWLEDGED rows and still-suppressed rows share the payload);
 *   - "suppress:window:<name>" — ACTIVE → SUPPRESSED under a maintenance
 *     window (one group per window NAME: the reason embeds it);
 *   - "reactivate:root-release" — the RT-001 re-activation.
 * Rows still migrating onto the fingerprint dedupKey (legacy ruleId-only
 * rows) keep the exact per-row update — the key value is row-specific.
 */

/** Write payload shared by every member of one dedup update group. */
export interface DedupUpdateGroupData {
  status?: string;
  suppressReason?: string | null;
  parentAlertId?: string | null;
  lastSeen?: Date;
  count?: { increment: number };
}

/** Minimal executor surface — `db.alert` satisfies it; tests can stub it. */
export interface DedupUpdateExecutor {
  updateMany(args: {
    where: { id: { in: string[] } };
    data: DedupUpdateGroupData;
  }): Promise<unknown>;
}

/** Buffered dedup writes: one updateMany per write-payload group. */
export class DedupUpdateBatch {
  private groups = new Map<
    string,
    { where: { id: { in: string[] } }; data: DedupUpdateGroupData }
  >();

  /** Buffer one alert row id under a write-payload group key. */
  add(groupKey: string, data: DedupUpdateGroupData, alertId: string): void {
    const group = this.groups.get(groupKey);
    if (group) {
      group.where.id.in.push(alertId);
      return;
    }
    this.groups.set(groupKey, { where: { id: { in: [alertId] } }, data });
  }

  /** Distinct write-payload groups buffered (one updateMany each on flush). */
  get groupCount(): number {
    return this.groups.size;
  }

  /** Buffered row ids of one group (inspection surface). */
  idsIn(groupKey: string): string[] {
    return this.groups.get(groupKey)?.where.id.in ?? [];
  }

  /** Flush every buffered group as one updateMany; returns writes executed. */
  async flush(executor: DedupUpdateExecutor): Promise<number> {
    let executed = 0;
    for (const group of this.groups.values()) {
      await executor.updateMany(group);
      executed += 1;
    }
    return executed;
  }
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
    reactivated: 0,
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

  /* ── resolve scopes → device sets (F-046: ONE device query, in-memory
     filtering — was one device.findMany per rule) ─────────────────────── */
  const allDevices = await db.device.findMany({
    select: {
      id: true,
      hostname: true,
      status: true,
      lastSeen: true,
      siteId: true,
      criticality: true,
      role: true,
      site: { select: { code: true } },
    },
  });
  const scopedDevices: EvalDevice[] = allDevices.map((device) => ({
    id: device.id,
    hostname: device.hostname,
    status: device.status,
    lastSeen: device.lastSeen,
    siteId: device.siteId,
    criticality: device.criticality,
    role: device.role,
    siteCode: device.site?.code ?? null,
  }));
  const { deviceById, pairs } = resolveRuleDevicePairs(rules, scopedDevices);
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

  /**
   * G5 release check (RT-001): is an AVAILABILITY root (ACTIVE or
   * ACKNOWLEDGED) open for the device? `openRootByDevice` alone only holds
   * roots breached in THIS run — the DB check also sees roots opened by an
   * earlier pass (e.g. an acknowledged outage), so a child can never
   * re-activate while its root is still open.
   *
   * F-046: AVAILABILITY roots re-activated in THIS pass are batched (not
   * yet flushed) while openRootExists runs. The pre-F-046 engine wrote the
   * re-activation inline, so later DB checks saw the fresh ACTIVE root
   * immediately — tracking the pending root here reproduces that visibility
   * exactly (registered at the same pair position the old write happened).
   */
  const pendingReactivatedRoots = new Set<string>();
  const openRootExists = async (device: EvalDevice): Promise<boolean> => {
    if (
      openRootByDevice.has(device.id) ||
      pendingReactivatedRoots.has(device.id)
    ) {
      return true;
    }
    const openRoot = await db.alert.findFirst({
      where: {
        deviceId: device.id,
        status: { in: ["ACTIVE", "ACKNOWLEDGED"] },
        dedupKey: { contains: ":AVAILABILITY:" },
      },
      select: { id: true },
    });
    return openRoot !== null;
  };

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
  let samplesByDeviceMetric = new Map<string, Array<{ ts: Date; value: number }>>();
  if (neededMetrics.size > 0 && maxWindowMin > 0 && deviceById.size > 0) {
    // Resolve pass needs the previous window too → load 2× the max window.
    const since = new Date(now.getTime() - 2 * maxWindowMin * 60_000);
    // F-046 (wave-6 correction): PER-SERIES row cap via one window-function
    // query — the newest MAX_SAMPLES_PER_QUERY rows of EVERY (device,
    // metric) series, in ONE round-trip (the fleet-wide `take` this replaced
    // truncated whole series out of the load and biased previous-window
    // averages — see MAX_SAMPLES_PER_QUERY's docblock). Global ts DESC
    // order is preserved so indexSamples restores the ascending per-series
    // maps exactly as before.
    const deviceIds = [...deviceById.keys()];
    const metrics = [...neededMetrics];
    const samples = await db.$queryRaw<
      Array<{ deviceId: string; metric: string; value: number; ts: Date }>
    >(
      Prisma.sql`
        SELECT ranked."deviceId", ranked."metric", ranked."value", ranked."ts"
        FROM (
          SELECT s."deviceId", s."metric", s."value", s."ts",
                 row_number() OVER (
                   PARTITION BY s."deviceId", s."metric"
                   ORDER BY s."ts" DESC
                 ) AS rn
          FROM "MetricSample" s
          WHERE s."deviceId" IN (${Prisma.join(deviceIds)})
            AND s."metric" IN (${Prisma.join(metrics)})
            AND s."ts" >= ${since}
        ) ranked
        WHERE ranked.rn <= ${MAX_SAMPLES_PER_QUERY}
        ORDER BY ranked."ts" DESC
      `
    );
    samplesByDeviceMetric = indexSamples(samples);
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

  const dedupBatch = new DedupUpdateBatch();

  /**
   * F-046: buffer a dedup write for the batched flush — or, for the rare
   * legacy row still migrating onto the fingerprint dedupKey (its value is
   * row-specific), keep the exact per-row update of the pre-F-046 engine,
   * awaited inline where the old write happened.
   */
  const bufferDedupWrite = async (
    groupKey: string,
    data: DedupUpdateGroupData,
    existing: ExistingAlert,
    key: string
  ): Promise<void> => {
    if (existing.dedupKey !== key) {
      await db.alert.update({
        where: { id: existing.id },
        data: { ...data, dedupKey: key },
      });
      return;
    }
    dedupBatch.add(groupKey, data, existing.id);
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
      // F-046: writes are buffered per payload group and flushed as ONE
      // updateMany per group right after this walk; the in-memory root
      // bookkeeping below happens exactly where it always did.
      if (existing.status === "ACTIVE" || existing.status === "ACKNOWLEDGED") {
        const inMaintenance = maintenanceFor(device);
        if (existing.status === "ACTIVE" && inMaintenance) {
          // Existing ACTIVE alerts that fall inside a window are suppressed
          // too (ACKNOWLEDGED keeps human ownership — documented choice).
          await bufferDedupWrite(
            `suppress:window:${inMaintenance}`,
            {
              status: "SUPPRESSED",
              suppressReason: `${MAINTENANCE_REASON_PREFIX}${inMaintenance}`,
              lastSeen: now,
              count: { increment: 1 },
            },
            existing,
            key
          );
          summary.suppressed += 1;
        } else {
          await bufferDedupWrite(
            "dedup:touch",
            { lastSeen: now, count: { increment: 1 } },
            existing,
            key
          );
          summary.deduped += 1;
        }
        if (rule.metric === "AVAILABILITY") openRootByDevice.set(device.id, existing);
        continue;
      }

      // SUPPRESSED — maintenance expiry re-activates; a root-suppressed row
      // re-activates when no AVAILABILITY root is open for the device
      // anymore (G5 release — RT-001). Maintenance precedence holds for
      // both; unknown suppression reasons stay dedup-touched only.
      if (
        shouldReactivateSuppressedRow(
          existing.status,
          existing.suppressReason,
          maintenanceFor(device) !== null,
          await openRootExists(device)
        )
      ) {
        await bufferDedupWrite(
          "reactivate:root-release",
          {
            status: "ACTIVE",
            suppressReason: null,
            parentAlertId: null,
            lastSeen: now,
            count: { increment: 1 },
          },
          existing,
          key
        );
        // A re-activated AVAILABILITY root becomes DB-visible to later
        // openRootExists checks in the old inline-write flow — replicate
        // that visibility for the batched (not-yet-flushed) write.
        if (rule.metric === "AVAILABILITY") {
          pendingReactivatedRoots.add(device.id);
        }
        summary.reactivated += 1;
      } else {
        await bufferDedupWrite(
          "dedup:touch",
          { lastSeen: now, count: { increment: 1 } },
          existing,
          key
        );
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

  /* ── F-046: flush the buffered dedup groups — one updateMany per group.
   * Outcome parity: nothing between the walk and here reads those rows
   * back — the children sweep and pass 2 decide on the in-memory
   * existingRows snapshot, and the sweep's SUPPRESSED transition can only
   * meet the status-less touch group (window-suppressed devices are skipped
   * by the sweep; re-activated rows have no open root by definition), so
   * the write-order change is invisible. The one DB-visibility dependency
   * — a re-activated AVAILABILITY root seen by later openRootExists checks
   * — is carried by pendingReactivatedRoots during the walk. */
  await dedupBatch.flush(db.alert);

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
    // RT-001 — root-suppressed children are resolve candidates too (their
    // recovery path used to be unreachable); maintenance-suppressed rows
    // are owned by their window and stay skipped.
    if (!isAutoResolveCandidate(existing.status, existing.suppressReason)) continue;
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
      data: {
        status: "RESOLVED",
        suppressReason: null,
        // A resolved child drops its (now stale) parent link.
        ...(existing.status === "SUPPRESSED" ? { parentAlertId: null } : {}),
      },
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
        reactivated: summary.reactivated,
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
