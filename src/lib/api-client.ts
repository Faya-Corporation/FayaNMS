/**
 * Typed API client for the FayaNMS /api/v1 REST surface.
 *
 * Every client hook goes through `apiFetch` — components never call raw
 * fetch. The standard envelope is unwrapped here and mapped to `ApiError`
 * so callers only ever deal with data or a typed error.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** Optional diagnostics from the server (e.g. AI_BAD_RESPONSE raw text). */
  readonly detail?: unknown;

  constructor(message: string, code: string, status: number, detail?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

interface EnvelopeError {
  success: false;
  error: { code: string; message: string; detail?: unknown };
}

interface EnvelopeSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

type Envelope<T> = EnvelopeSuccess<T> | EnvelopeError;

/** GET/POST any /api/v1 endpoint; resolves with the full envelope (incl. meta). */
export async function apiRequest<T>(
  path: string,
  init?: RequestInit
): Promise<EnvelopeSuccess<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(
      "Network request failed — the server could not be reached.",
      "NETWORK_ERROR",
      0
    );
  }

  let envelope: Envelope<T> | null = null;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    envelope = null;
  }

  if (!envelope) {
    throw new ApiError(
      `Unexpected response from server (HTTP ${response.status}).`,
      "BAD_ENVELOPE",
      response.status
    );
  }

  if (!envelope.success) {
    throw new ApiError(
      envelope.error.message,
      envelope.error.code,
      response.status,
      envelope.error.detail
    );
  }
  if (envelope.data === undefined) {
    throw new ApiError(
      "Response envelope is missing data.",
      "BAD_ENVELOPE",
      response.status
    );
  }

  return envelope;
}

/** Convenience wrapper returning just `data`. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const envelope = await apiRequest<T>(path, init);
  return envelope.data;
}

/** Serialize a params object into a query string (skips empty values). */
export function buildQueryString(
  params: Record<string, unknown>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

/* ------------------------------------------------------------------ */
/* Response types (serialized JSON — dates arrive as ISO strings)      */
/* ------------------------------------------------------------------ */

export interface PageMetaInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PagedMeta extends PageMetaInfo {
  [key: string]: unknown;
}

export interface PagedResult<T, TMeta = PageMetaInfo> {
  data: T[];
  meta: TMeta;
}

export interface DashboardKpis {
  managedDevices: number;
  online: number;
  offline: number;
  criticalAlerts: number;
  activeAlerts: number;
  activeIncidents: number;
  pendingApprovals: number;
  activeJobs: number;
  backupCompliancePct: number;
  driftCount: number;
}

export interface UtilizationPoint {
  period: string;
  cpu: number;
  memory: number;
}

export interface HealthSlice {
  status: string;
  count: number;
}

export interface DashboardIncident {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: string;
  createdAt: string;
  slaDueAt: string | null;
}

export interface DashboardChange {
  id: string;
  number: string;
  title: string;
  riskLevel: string;
  scheduledStart: string | null;
  status: string;
}

export interface BackupComplianceSummary {
  compliant: number;
  overdue: number;
  failed: number;
  never: number;
  unknown: number;
  lastSuccessfulBackupAt: string | null;
}

export interface CapacityRisk {
  deviceId: string;
  hostname: string;
  metric: string;
  value: number;
}

export interface RecentActivityEntry {
  id: string;
  actorName: string;
  action: string;
  resourceLabel: string | null;
  result: string;
  createdAt: string;
}

export interface DashboardPayload {
  kpis: DashboardKpis;
  utilizationTrend: UtilizationPoint[];
  healthDistribution: HealthSlice[];
  activeIncidentsList: DashboardIncident[];
  upcomingChanges: DashboardChange[];
  backupCompliance: BackupComplianceSummary;
  capacityRisks: CapacityRisk[];
  recentActivity: RecentActivityEntry[];
}

export interface DeviceRow {
  id: string;
  hostname: string;
  displayName: string | null;
  mgmtIp: string;
  model: string | null;
  role: string | null;
  status: string;
  criticality: string;
  healthScore: number;
  lastBackupAt: string | null;
  lastSeen: string | null;
  backupCompliance: string;
  site: { name: string; code: string } | null;
  vendor: { key: string; name: string } | null;
  _count: {
    interfaces: number;
    snapshots: number;
    alerts: number;
  };
}

/* --------------------- Device detail (Phase 2) --------------------- */

export interface DeviceDetail {
  id: string;
  hostname: string;
  displayName: string | null;
  mgmtIp: string;
  model: string | null;
  platform: string | null;
  serialNumber: string | null;
  firmware: string | null;
  role: string | null;
  status: string;
  criticality: string;
  healthScore: number;
  backupCompliance: string;
  tags: string[];
  notes: string | null;
  /** BigInt uptimeSeconds serialized as string by the API. */
  uptimeSeconds: string | null;
  lastSeen: string | null;
  lastBackupAt: string | null;
  lastConfigChangeAt: string | null;
  createdAt: string;
  updatedAt: string;
  vendor: { id: string; key: string; name: string; adapterKey: string };
  site: { id: string; name: string; code: string; region: string | null } | null;
  counts: {
    interfaces: number;
    snapshots: number;
    openAlerts: number;
    openIncidents: number;
    changes: number;
    backupJobs: number;
  };
}

export interface DeviceMetricPoint {
  ts: string;
  cpu: number | null;
  memory: number | null;
  utilizationIn: number | null;
  utilizationOut: number | null;
}

export interface DeviceMetricsPayload {
  series: DeviceMetricPoint[];
}

export interface DeviceSnapshotRow {
  id: string;
  version: number;
  source: string;
  configType: string;
  status: string;
  sha256: string;
  sizeBytes: number;
  rawText: string;
  normalizedText: string | null;
  createdAt: string;
  changeNumber: string | null;
  capturedBy: string | null;
  correlationId: string | null;
}

export interface DeviceInterfaceRow {
  id: string;
  name: string;
  description: string | null;
  adminStatus: string;
  operStatus: string;
  speedMbps: number | null;
  macAddress: string | null;
  vlan: number | null;
  mtu: number | null;
  /** BigInt counters serialized as strings by the API. */
  countersInBps: string | null;
  countersOutBps: string | null;
  lastFlapAt: string | null;
}

export interface DeviceAlertRow {
  id: string;
  severity: string;
  message: string;
  status: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  acknowledgedAt: string | null;
  ruleName: string | null;
}

export interface DeviceIncidentRow {
  id: string;
  number: string;
  title: string;
  severity: string;
  priority: string | null;
  status: string;
  source: string;
  createdAt: string;
  resolvedAt: string | null;
  slaDueAt: string | null;
}

export interface DeviceChangeRow {
  id: string;
  number: string;
  title: string;
  type: string;
  status: string;
  riskScore: number;
  riskLevel: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  createdAt: string;
  /** Result of this device's link within the change (PENDING/SUCCESS/…). */
  deviceResult: string | null;
}

export interface DeviceAuditRow {
  id: string;
  actorName: string;
  action: string;
  resourceType: string;
  resourceLabel: string | null;
  result: string;
  ip: string | null;
  correlationId: string | null;
  createdAt: string;
}

/* --------------------------- Sites (Phase 2) ------------------------ */

export interface SiteSummary {
  id: string;
  name: string;
  code: string;
  region: string | null;
  address: string | null;
  deviceCount: number;
  managedCount: number;
  statusCounts: Record<string, number>;
  criticalityMix: Record<string, number>;
  interfaceCount: number;
  compliance: {
    pct: number | null;
    compliant: number;
    total: number;
  };
}

/* ------------------------- Device mutations ------------------------- */

export interface CreateDevicePayload {
  hostname: string;
  displayName?: string;
  vendorId: string;
  model?: string;
  mgmtIp: string;
  siteId?: string;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  /** Validated + audited; persisted when credential assignment lands (2-c). */
  credentialProfileId?: string;
  tags?: string[];
  notes?: string;
}

export interface UpdateDevicePayload {
  displayName?: string;
  notes?: string | null;
  criticality?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  siteId?: string | null;
  tags?: string[];
  status?: "ONLINE" | "OFFLINE" | "DEGRADED" | "MAINTENANCE" | "UNKNOWN" | "UNMANAGED";
  credentialProfileId?: string | null;
}

export interface BulkDeviceActionResult {
  queued: number;
  jobs: {
    deviceId: string;
    hostname: string;
    type: string;
    status: string;
    correlationId: string;
  }[];
  skipped: { deviceId: string; hostname?: string; reason: string }[];
}

export interface TestConnectionResult {
  reachable: boolean;
  ok: boolean;
  latencyMs: number | null;
  message: string | null;
  workerStatus: string | null;
  device: {
    id: string;
    hostname: string;
    status: string;
  };
}

export interface CreateDeviceResult {
  device: DeviceRow;
  audit: {
    id: string;
    action: string;
    resourceLabel: string | null;
    correlationId: string;
  };
}

export interface IncidentRow {
  id: string;
  number: string;
  title: string;
  severity: string;
  priority: string | null;
  status: string;
  source: string;
  ownerTeam: string | null;
  ownerId: string | null;
  owner: { id: string; name: string } | null;
  createdAt: string;
  acknowledgedAt: string | null;
  slaDueAt: string | null;
  resolvedAt: string | null;
  updatedAt: string;
  site: { name: string; code: string } | null;
  change: { id: string; number: string; status: string } | null;
  _count: { devices: number; alerts: number };
  /** Computed SLA state (Task 5-b — see lib/incidents/lifecycle.ts). */
  sla: IncidentSlaState;
}

export interface IncidentSlaState {
  tracked: boolean;
  dueInMs: number | null;
  breached: boolean;
  remainingPct: number | null;
  outcome: "MET" | "BREACHED" | null;
  targetLabel: string | null;
}

/** Extended list meta (Task 5-b) — facet counts + SLA/open totals. */
export interface IncidentListMeta extends PageMetaInfo {
  counts: { byStatus: Record<string, number>; bySeverity: Record<string, number> };
  openCount: number;
  slaBreachedCount: number;
}

/* ------------------- Incident lifecycle (Task 5-b) ------------------- */

export interface IncidentDetailDevice {
  id: string;
  deviceId: string;
  createdAt: string;
  device: {
    id: string;
    hostname: string;
    status: string;
    mgmtIp: string;
    model: string | null;
    site: { name: string; code: string } | null;
  };
}

export interface IncidentDetailEvent {
  id: string;
  kind: "SYSTEM" | "USER" | "INTEGRATION" | string;
  message: string;
  createdAt: string;
  actor: { id: string; name: string | null; email: string } | null;
}

export interface IncidentDetailAlert {
  id: string;
  severity: string;
  message: string;
  status: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  device: { id: string; hostname: string } | null;
}

export interface IncidentDetail {
  id: string;
  number: string;
  title: string;
  description: string | null;
  severity: string;
  priority: string | null;
  status: string;
  source: string;
  ownerTeam: string | null;
  ownerId: string | null;
  owner: { id: string; name: string | null; email: string } | null;
  changeId: string | null;
  change: {
    id: string;
    number: string;
    title: string;
    status: string;
    riskLevel: string;
  } | null;
  slaDueAt: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  rootCause: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  createdAt: string;
  updatedAt: string;
  site: { id: string; name: string; code: string } | null;
  devices: IncidentDetailDevice[];
  events: IncidentDetailEvent[];
  alerts: IncidentDetailAlert[];
  sla: IncidentSlaState;
}

export interface IncidentStatsPayload {
  openBySeverity: Record<string, number>;
  openCount: number;
  breachedCount: number;
  mttaMinutes: number | null;
  mttrMinutes: number | null;
  mttaSamples: number;
  mttrSamples: number;
  slaCompliancePct: number | null;
  slaResolvedTotal: number;
  slaMetTotal: number;
  topSites: {
    siteId: string | null;
    siteName: string | null;
    siteCode: string | null;
    openCount: number;
  }[];
  trend: { date: string; created: number }[];
  window: { mttaMttrDays: number; trendDays: number };
  generatedAt: string;
}

export interface IncidentCorrelationMatch {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  site: { name: string; code: string } | null;
  deviceCount: number;
  alertCount: number;
  deviceHostnames: string[];
  linked: boolean;
  changeId: string | null;
  matchedOn: ("created" | "resolved")[];
  deltaMinutes: number;
  deviceOverlap: boolean;
}

export interface IncidentCorrelationResult {
  matches: IncidentCorrelationMatch[];
  meta: {
    changeId: string;
    changeNumber: string;
    changeStatus: string;
    refAt: string;
    refSource: string;
    windowMinutes: number;
  };
}

export interface IncidentActionResult {
  incident: {
    id: string;
    number: string;
    title: string;
    severity: string;
    status: string;
    ownerId: string | null;
    ownerTeam: string | null;
    acknowledgedAt: string | null;
    resolvedAt: string | null;
    closedAt: string | null;
    changeId: string | null;
    pir: {
      rootCause: string | null;
      correctiveAction: string | null;
      preventiveAction: string | null;
    };
  };
  alreadyAcknowledged?: true;
  alreadyClosed?: true;
  alreadyAssigned?: true;
  alreadyLinked?: true;
  changeNumber?: string;
}

export interface IncidentLifecycleActionPayload {
  actAsUserId?: string;
  note?: string;
  resolutionNote?: string;
  ownerId?: string;
  ownerTeam?: string;
  changeId?: string;
  rootCause?: string;
  correctiveAction?: string;
  preventiveAction?: string;
}

export interface ChangeRow {
  id: string;
  number: string;
  title: string;
  type: string;
  status: string;
  riskScore: number;
  riskLevel: string;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  createdAt: string;
  requester: { id: string; name: string | null; email: string } | null;
  site: { name: string; code: string } | null;
  _count: { devices: number; steps: number };
  /** PENDING approvals at a glance (Task 4-a). */
  pendingApprovals?: number;
}

/* ------------------- Change management (Task 4-a) ------------------- */

/** One factor row of the transparent risk breakdown (wire shape). */
export interface RiskFactorRow {
  key: string;
  label: string;
  points: number;
  detail: string;
}

export interface RiskBreakdown {
  score: number;
  level: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  factors: RiskFactorRow[];
}

export interface ChangeStepInput {
  name: string;
  type: "CHECK" | "BACKUP" | "APPLY" | "VALIDATE" | "ROLLBACK";
}

/** POST /api/v1/changes body (wizard payload). */
export interface WizardPayload {
  title: string;
  description?: string;
  type: "STANDARD" | "NORMAL" | "EMERGENCY";
  siteId?: string;
  scheduledStart?: string;
  scheduledEnd?: string;
  implementationPlan?: string;
  validationPlan?: string;
  rollbackPlan?: string;
  deviceIds: string[];
  steps?: ChangeStepInput[];
  submit?: boolean;
}

export interface ChangeMutationResult {
  change: {
    id: string;
    number: string;
    title?: string;
    status: string;
    riskScore: number;
    riskLevel: string;
    type?: string;
  } | null;
  message: string;
  audit: { action: string; correlationId: string };
}

export interface ChangeCreateResult {
  change: {
    id: string;
    number: string;
    title: string;
    type: string;
    status: string;
    riskScore: number;
    riskLevel: string;
  };
  message: string;
  audit: { action: string; correlationId: string };
}

/** GET /api/v1/changes meta (page fields + KPI summary for the mini-row). */
export interface ChangeListMeta extends PageMetaInfo {
  summary: {
    awaitingApproval: number;
    executingNow: number;
    /** null when no change reached a terminal state in the window. */
    successRate30d: number | null;
    closedChanges30d: number;
  };
}

/** One conflicting change of GET /api/v1/changes/conflicts. */
export interface ChangeConflict {
  id: string;
  number: string;
  title: string;
  status: string;
  riskLevel: string;
  type: string;
  scheduledStart: string;
  scheduledEnd: string;
  siteCode: string | null;
  deviceIds: string[];
}

export interface ChangeDetailDevice {
  linkId: string;
  deviceId: string;
  hostname: string;
  model: string | null;
  status: string;
  criticality: string;
  role: string | null;
  siteName: string | null;
  siteCode: string | null;
  vendorKey: string | null;
  result: string | null;
}

export interface ChangeDetailStep {
  id: string;
  order: number;
  name: string;
  type: string;
  status: string;
  output: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ChangeDetailApproval {
  id: string;
  level: string;
  status: string;
  approverName: string | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface ChangeDetailSnapshot {
  id: string;
  deviceId: string;
  hostname: string;
  version: number;
  status: string;
  source: string;
  createdAt: string;
}

export interface ChangeDetailIncident {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: string;
}

/** GET /api/v1/changes/[id] payload. */
export interface ChangeDetail {
  id: string;
  number: string;
  title: string;
  description: string | null;
  type: string;
  status: string;
  riskScore: number;
  riskLevel: string;
  requester: { id: string; name: string | null; email: string };
  owner: { id: string; name: string | null } | null;
  technicalOwner: { id: string; name: string | null } | null;
  site: { id: string; name: string; code: string } | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  implementationPlan: string | null;
  validationPlan: string | null;
  rollbackPlan: string | null;
  preChecks: { name: string; status: string; detail?: string }[];
  createdAt: string;
  updatedAt: string;
  devices: ChangeDetailDevice[];
  steps: ChangeDetailStep[];
  approvals: ChangeDetailApproval[];
  snapshots: ChangeDetailSnapshot[];
  incidents: ChangeDetailIncident[];
}

/* ---------------- Approvals + execution (Task 4-b) ---------------- */

/** One row of GET /api/v1/approvals (per approval, joined with its change). */
export interface ApprovalQueueRow {
  id: string;
  changeId: string;
  level: string;
  status: string;
  comment: string | null;
  approverName: string | null;
  decidedAt: string | null;
  change: {
    id: string;
    number: string;
    title: string;
    type: string;
    status: string;
    riskScore: number;
    riskLevel: string;
    requesterId: string;
    requesterName: string | null;
    createdAt: string;
    scheduledStart: string | null;
    levels: { level: string; status: string }[];
  };
}

/** meta of GET /api/v1/approvals — KPI counts for the queue view. */
export interface ApprovalQueueMeta {
  pending: number;
  /** SoD-aware count the acting user may decide (null without actAsUserId). */
  mine: number | null;
  approvedToday: number;
  rejectedToday: number;
}

export interface ApprovalDecisionPayload {
  level: string;
  decision: "APPROVED" | "REJECTED";
  comment?: string;
  actAsUserId?: string;
}

/** POST /api/v1/changes/[id]/approvals result. */
export interface ApprovalDecisionResult {
  change: {
    id: string;
    number: string;
    status: string;
    riskLevel: string;
  };
  approvals: { level: string; status: string }[];
  selfApproval: boolean;
  audit: { action: string; correlationId: string };
  message: string;
}

/** POST /api/v1/changes/[id]/execute body + result. */
export interface ExecuteChangePayload {
  failAt?: "APPLY" | "VALIDATE" | null;
  actAsUserId?: string;
}

export interface ExecuteChangeResult {
  job: {
    id: string;
    type: string;
    status: string;
    correlationId: string;
  };
  change: { id: string; number: string; status: string };
  message: string;
  audit: { action: string; correlationId: string };
}

/** POST /api/v1/incidents/from-change body + result. */
export interface IncidentFromChangePayload {
  changeId: string;
  actAsUserId?: string;
}

export interface IncidentFromChangeResult {
  incident: {
    id: string;
    number: string;
    title: string;
    severity: string;
    status: string;
    changeId: string | null;
  };
  message: string;
}

export interface AlertRow {
  id: string;
  severity: string;
  message: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  device: { id: string; hostname: string };
  acknowledgedAt: string | null;
}

/** Alert stream row (Task 5-a) — rule/site/incident chips + grouping fields. */
export interface AlertStreamRow {
  id: string;
  deviceId: string;
  severity: string;
  message: string;
  status: string;
  firstSeen: string;
  lastSeen: string;
  count: number;
  dedupKey: string | null;
  parentAlertId: string | null;
  suppressReason: string | null;
  acknowledgedAt: string | null;
  device: {
    id: string;
    hostname: string;
    site: { id: string; name: string; code: string } | null;
  };
  rule: { id: string; name: string; severity: string } | null;
  incident: {
    id: string;
    number: string;
    severity: string;
    status: string;
  } | null;
  acknowledgedBy: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  _count: { childAlerts: number };
}

export interface AlertStreamMeta extends PageMetaInfo {
  counts: {
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
  };
  linkedOpenIncidents: number;
}

/** Alert rule row (Task 5-a, Rules tab). */
export interface AlertRuleRow {
  id: string;
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  durationMinutes: number;
  severity: string;
  scopeJson: string | null;
  isActive: boolean;
  openAlerts: number;
  scopedDeviceCount: number;
  scope: {
    siteCodes?: string[];
    criticalities?: string[];
    deviceRoles?: string[];
  };
  _count?: { alerts: number };
}

export interface AlertRulePayload {
  name: string;
  metric: string;
  operator: string;
  threshold: number;
  durationMinutes: number;
  severity: string;
  scope?: {
    siteCodes?: string[];
    criticalities?: string[];
    deviceRoles?: string[];
  };
  isActive: boolean;
}

export interface AlertRuleMutationResult {
  rule: { id: string; name: string; isActive: boolean };
  audit: { correlationId: string };
}

export interface DeleteAlertRuleResult {
  deleted: boolean;
  audit: { correlationId: string };
}

/** Action result shared by acknowledge/assign/suppress/unsuppress/resolve. */
export interface AlertActionResult {
  alert: AlertStreamRow | { id: string; status: string };
  audit: { correlationId: string };
}

export interface CreateIncidentFromAlertResult {
  incident: {
    id: string;
    number: string;
    title: string;
    severity: string;
    priority: string;
    status: string;
    slaDueAt: string;
  };
  message: string;
}

/** Notifications center row (Task 5-a; §74 — separate from ops alerts). */
export interface NotificationRow {
  id: string;
  userId: string | null;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  severity: string | null;
  readAt: string | null;
  createdAt: string;
  mine: boolean;
}

export interface NotificationsPayload {
  data: NotificationRow[];
  meta: { unreadCount: number; total: number; identity: { id: string; name: string } | null };
}

export interface JobRow {
  id: string;
  type: string;
  targetType: string | null;
  targetId: string | null;
  status: string;
  progress: number;
  priority: number;
  attempts: number;
  maxAttempts: number;
  payloadJson: string | null;
  resultJson: string | null;
  error: string | null;
  correlationId: string;
  scheduledAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface SearchResults {
  devices: {
    id: string;
    hostname: string;
    mgmtIp: string;
    status: string;
  }[];
  incidents: {
    id: string;
    number: string;
    title: string;
    severity: string;
    status: string;
  }[];
  changes: {
    id: string;
    number: string;
    title: string;
    status: string;
  }[];
}

export interface MetaPayload {
  vendors: { id: string; key: string; name: string }[];
  sites: { id: string; name: string; code: string }[];
  credentialProfiles: { id: string; name: string; type: string; username: string }[];
  /** Seeded accounts for the Act-as demo identity (Task 4-b). */
  users: UserOption[];
}

/** One "Act as" identity option (Task 4-b). */
export interface UserOption {
  id: string;
  name: string;
  /** Username-style key — email local-part ("admin", "noc1", …). */
  username: string;
  roleLabel: string;
}

/* --------------------- Discovery & CSV import (2-c) ---------------- */

/** One discovered device candidate (persistence-free — lives in resultJson). */
export interface DiscoveryCandidate {
  ip: string;
  hostname: string;
  vendorGuess: string;
  modelGuess?: string;
  mgmtPort?: number;
  protocols?: string[];
  confidence?: number;
  osFingerprint?: string;
  discoveredAt?: string;
  imported?: boolean;
}

/** DISCOVERY job row as served by GET /api/v1/discovery. */
export interface DiscoveryJobSummary {
  id: string;
  correlationId: string;
  name: string | null;
  status: string;
  progress: number;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  subnets: string[];
  candidateCount: number;
  importedCount: number;
  scannedSubnets: number | null;
  durationMs: number | null;
  candidates: DiscoveryCandidate[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface StartScanPayload {
  subnets: string[];
  name?: string;
}

export interface StartScanResult {
  jobId: string;
  correlationId: string;
  status: string;
  audit: { id: string; action: string };
}

export interface ImportCandidatesPayload {
  jobId: string;
  ips: string[];
  siteId?: string;
  credentialProfileId?: string;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  managed: boolean;
}

export interface CsvImportRowPayload {
  hostname: string;
  vendor: string;
  model?: string;
  mgmtIp: string;
  siteCode?: string;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  tags?: string[];
}

export interface CsvImportPayload {
  rows: CsvImportRowPayload[];
  siteIdFallback?: string;
}

/** Shared result shape of /discovery/import and /devices/csv-import. */
export interface ImportResult {
  created: number;
  devices: { id: string; hostname: string; ip: string }[];
  skipped: { ip: string; reason: string }[];
}

/* ---------------------- Credentials (2-c) -------------------------- */

/**
 * Credential profile row — reference data only. `secretRef` is a vault
 * POINTER (e.g. "vault://ssh/network-admin"); no secret material is ever
 * transferred or rendered (audit finding F-12).
 */
export interface CredentialProfileRow {
  id: string;
  name: string;
  type: string;
  username: string;
  secretRef: string;
  port: number;
  notes: string | null;
  lastRotatedAt: string | null;
  deviceCount: number;
}

export interface CreateCredentialPayload {
  name: string;
  type: string;
  username: string;
  secretRef: string;
  port?: number;
  notes?: string;
}

export interface UpdateCredentialPayload {
  name?: string;
  type?: string;
  username?: string;
  secretRef?: string;
  port?: number;
  notes?: string | null;
}

export interface CreateJobPayload {
  type: "CONFIG_BACKUP";
  deviceId: string;
}

export interface CreateJobResult {
  job: JobRow;
  audit: {
    id: string;
    action: string;
    resourceLabel: string | null;
    correlationId: string;
  };
}

/** POST /api/v1/jobs/[id]/cancel result (Phase 9-b). */
export interface CancelJobResult {
  job: JobRow;
}

/** POST /api/v1/jobs/[id]/retry result (Phase 9-b) — the fresh QUEUED clone. */
export interface RetryJobResult {
  job: JobRow;
  audit: {
    id: string;
    action: string;
    resourceLabel: string | null;
    correlationId: string;
  };
}

/* ------------------ Backup engine (Task 3-a) ----------------------- */

/**
 * One row of the fleet-wide snapshot history (GET /api/v1/snapshots).
 * Metadata only — raw config text is fetched per device or via the
 * audited download endpoint.
 */
export interface FleetSnapshotRow {
  id: string;
  deviceId: string;
  hostname: string;
  siteName: string | null;
  siteCode: string | null;
  version: number;
  source: string;
  configType: string;
  status: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  correlationId: string | null;
}

/** Type alias (not interface) so it satisfies ListParams / Record<string, unknown>. */
export type FleetSnapshotParams = {
  /** csv multi, e.g. "CURRENT,HISTORICAL" */
  status?: string;
  /** csv multi, e.g. "SCHEDULED,MANUAL" */
  source?: string;
  /** Device hostname / mgmtIp contains. */
  q?: string;
  deviceId?: string;
  page?: number;
  /** Hard-capped at 25 server-side. */
  pageSize?: number;
};

/** Canonical policy scope (stored in scopeJson; legacy keys normalized on read). */
export interface BackupPolicyScope {
  /** Site codes; ["*"] = every site; [] = every site. */
  siteCodes: string[];
  /** LOW | MEDIUM | HIGH | CRITICAL; [] = all. */
  criticalities: string[];
  /** Status include-filter (ONLINE|DEGRADED|MAINTENANCE|UNKNOWN); [] = all. */
  statuses: string[];
}

/** BackupPolicy row as served by GET /api/v1/backup-policies (+ computed stats). */
export interface BackupPolicyRow {
  id: string;
  name: string;
  cronExpr: string;
  scope: BackupPolicyScope;
  retentionDays: number;
  isActive: boolean;
  /** Devices matched by the scope (scheduler convention: UNMANAGED/OFFLINE excluded). */
  scopedDeviceCount: number;
  /** Most recent CONFIG_BACKUP job enqueued for this policy (any status). */
  lastEnqueuedAt: string | null;
}

/** Raw BackupPolicy row as returned by POST/PATCH (scopeJson serialized). */
export interface BackupPolicyRecord {
  id: string;
  name: string;
  cronExpr: string;
  scopeJson: string;
  retentionDays: number;
  isActive: boolean;
}

export interface BackupPolicyPayload {
  name: string;
  cronExpr: string;
  scope?: Partial<BackupPolicyScope>;
  retentionDays?: number;
  isActive?: boolean;
}

/** PATCH body — every field optional (e.g. the inline isActive toggle). */
export interface UpdateBackupPolicyPayload {
  name?: string;
  cronExpr?: string;
  scope?: Partial<BackupPolicyScope>;
  retentionDays?: number;
  isActive?: boolean;
}

export interface BackupPolicyMutationResult {
  policy: BackupPolicyRecord;
  audit: {
    id: string;
    action: string;
    resourceLabel: string | null;
    correlationId: string;
  };
}

export interface DeleteBackupPolicyResult {
  deleted: boolean;
  audit: {
    id: string;
    action: string;
    resourceLabel: string | null;
    correlationId: string;
  };
}

/** Band key from the BACKUP_COMPLIANCE map (stale >72h renders as OVERDUE). */
export type BackupComplianceBand = "COMPLIANT" | "OVERDUE" | "NEVER_BACKED_UP";

export interface BackupCompliancePayload {
  kpis: {
    managedDevices: number;
    compliant: number;
    atRisk: number;
    nonCompliant: number;
    compliantPct: number;
    snapshotsLast24h: number;
  };
  perSite: {
    siteId: string | null;
    siteName: string;
    siteCode: string | null;
    managed: number;
    compliant: number;
    atRisk: number;
    nonCompliant: number;
    compliantPct: number | null;
  }[];
  staleDevices: {
    deviceId: string;
    hostname: string;
    siteName: string | null;
    siteCode: string | null;
    lastBackupAt: string | null;
    band: BackupComplianceBand;
  }[];
  bands: {
    compliantWindowHours: number;
    atRiskWindowHours: number;
    note: string;
  };
}

/* ---------------- Baselines & drift (Task 3-c) ---------------------- */

/**
 * One row of GET /api/v1/baselines — the LATEST ConfigBaseline per device
 * joined with its snapshot, approver, OPEN drift count and the device's
 * latest CURRENT snapshot (powers the baseline-vs-running diff dialog).
 */
export interface BaselineRow {
  id: string;
  deviceId: string;
  hostname: string;
  siteName: string | null;
  siteCode: string | null;
  snapshotId: string;
  version: number;
  sha256: string;
  snapshotStatus: string;
  snapshotCreatedAt: string;
  approvedAt: string;
  approvedBy: string | null;
  note: string | null;
  openDriftCount: number;
  current: { snapshotId: string; version: number } | null;
}

/** meta of GET /api/v1/baselines (unpaged — small table). */
export interface BaselinesMeta {
  baselineDevices: number;
  devicesWithoutBaseline: number;
  withoutBaselineDevices: { id: string; hostname: string }[];
}

export interface ApproveBaselinePayload {
  deviceId: string;
  snapshotId: string;
  note?: string;
}

export interface BaselineMutationResult {
  baseline: { id: string; deviceId: string; snapshotId: string };
  version: number;
  snapshotStatus: string;
  audit: { action: string; correlationId: string };
}

export interface RevokeBaselineResult {
  deleted: boolean;
  id: string;
  audit: { action: string; correlationId: string };
}

/** One row of GET /api/v1/drift. */
export interface DriftRow {
  id: string;
  deviceId: string;
  hostname: string;
  siteName: string | null;
  siteCode: string | null;
  baselineSnapshotId: string;
  baselineVersion: number;
  baselineSha256: string;
  currentSnapshotId: string;
  currentVersion: number;
  currentSha256: string;
  currentCreatedAt: string;
  detectedAt: string;
  diffSummary: string | null;
  status: string;
  resolvedAt: string | null;
}

/** meta of GET /api/v1/drift (page fields + summary KPIs). */
export interface DriftListMeta extends PageMetaInfo {
  open: number;
  accepted: number;
  resolvedToday: number;
  /** finishedAt of the latest DRIFT_CHECK job (null = never checked). */
  lastCheckedAt: string | null;
  /** Distinct devices with an OPEN drift record. */
  devicesAffected: number;
  /** Whether ANY device has a baseline (gates the "Run drift check" action). */
  hasBaselines: boolean;
}

export interface DriftCheckPayload {
  deviceId?: string;
}

export interface DriftCheckResult {
  enqueued: number;
  correlationId: string;
  jobs?: { jobId?: string; deviceId: string; hostname: string }[];
}

export interface DriftActionResult {
  record: {
    id: string;
    deviceId: string;
    status: string;
    resolvedAt: string | null;
  };
  audit: { action: string; correlationId: string };
}

export interface RestoreSnapshotPayload {
  confirmHostname: string;
  autoApprove?: boolean;
}

export interface RestoreSnapshotResult {
  change: {
    id: string;
    number: string;
    status: string;
    riskScore: number;
    riskLevel: string;
  };
  message: string;
  audit: { action: string; correlationId: string };
}

/* ------------------ Config diff engine (Task 3-b) ------------------- */

/** One rendered diff row (wire shape of src/lib/config/diff DiffRow). */
export type SnapshotDiffRowType = "equal" | "added" | "removed" | "changed";

export interface SnapshotDiffRow {
  type: SnapshotDiffRowType;
  /** 1-based line number in the FROM snapshot (removed/changed/equal). */
  aLine?: number;
  /** 1-based line number in the TO snapshot (added/changed/equal). */
  bLine?: number;
  aText?: string;
  bText?: string;
}

export interface SnapshotDiffStats {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
}

/** Either endpoint of a diff (from/to). */
export interface SnapshotDiffEndpoint {
  snapshotId: string;
  version: number;
  createdAt: string;
  sha256: string;
  source: string;
  status: string;
}

/** GET /api/v1/devices/[id]/snapshots/diff response payload. */
export interface SnapshotDiffResult {
  device: { id: string; hostname: string; vendorKey: string };
  from: SnapshotDiffEndpoint;
  to: SnapshotDiffEndpoint;
  mode: "raw" | "normalized";
  /** True when both snapshots share the same sha256 (rows are empty). */
  identical: boolean;
  rows: SnapshotDiffRow[];
  stats: SnapshotDiffStats;
  /** Whether the stored normalizedText was used (false = computed on the fly). */
  normalized: { from: boolean; to: boolean };
}

/* --------------- Maintenance windows (Task 5-c) --------------------- */

/** Time-derived status; the isActive flag is orthogonal ("paused"). */
export type MaintenanceStatus = "ACTIVE" | "UPCOMING" | "PAST";

/** MaintenanceWindow row as served by GET /api/v1/maintenance. */
export interface MaintenanceRow {
  id: string;
  name: string;
  reason: string | null;
  isActive: boolean;
  startsAt: string;
  endsAt: string;
  status: MaintenanceStatus;
  site: { id: string; name: string; code: string } | null;
  device: { id: string; hostname: string } | null;
  change: { id: string; number: string; title: string } | null;
}

export interface MaintenanceListMeta extends PageMetaInfo {
  /** Windows covering "now" AND isActive — matches engine suppression. */
  activeNow: number;
  upcoming24h: number;
  past7d: number;
  total: number;
}

export interface MaintenanceWindowPayload {
  name: string;
  siteId?: string | null;
  deviceId?: string | null;
  changeId?: string | null;
  /** ISO timestamps. */
  startsAt: string;
  endsAt: string;
  reason?: string | null;
  isActive?: boolean;
  /** Demo acting identity (Task 4-b act-as selector). */
  actAsUserId?: string;
}

/** PATCH body — every field optional; explicit null clears the link. */
export interface UpdateMaintenanceWindowPayload {
  name?: string;
  siteId?: string | null;
  deviceId?: string | null;
  changeId?: string | null;
  startsAt?: string;
  endsAt?: string;
  reason?: string | null;
  isActive?: boolean;
  actAsUserId?: string;
}

/** Non-blocking same-scope overlap warning attached to write responses. */
export interface MaintenanceOverlapWarning {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface MaintenanceMutationResult {
  window: {
    id: string;
    name: string;
    startsAt: string;
    endsAt: string;
    reason: string | null;
    isActive: boolean;
    siteId: string | null;
    deviceId: string | null;
    changeId: string | null;
  };
  overlap: MaintenanceOverlapWarning[];
  audit: { correlationId: string };
}

export interface DeleteMaintenanceWindowResult {
  deleted: boolean;
  audit: { correlationId: string };
}

/* --------------- Audit-event stream (Task 5-c) ----------------------- */

/** GET /api/v1/events row (AuditEvent timeline; before/after pre-parsed). */
export interface AuditEventRow {
  id: string;
  actorId: string | null;
  actorName: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceLabel: string | null;
  result: string;
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  createdAt: string;
}

export interface EventListMeta extends PageMetaInfo {
  total: number;
  /** Events in the trailing 24 h over the same filters (fresh window). */
  last24h: number;
  distinctActors: number;
  topActors: { actor: string; count: number }[];
  topActions: { action: string; count: number }[];
  entityTypes: { entityType: string; count: number }[];
}

/* --------------- Performance slice (Task 6-b) ------------------------ */
/* Frozen contract with the Phase 6-a backend: range is one of
   "1H" | "24H" | "7D" | "30D"; every response meta carries
   { range, granularity, generatedAt }.                                  */

export type PerfRange = "1H" | "24H" | "7D" | "30D";

/** Meta shared by all /api/v1/performance/* responses. */
export interface PerfMetaInfo {
  range: string;
  /** Rollup bucket the series is served at, e.g. "5M", "1H" or "1D". */
  granularity: string;
  generatedAt: string;
}

/* --- 1. Overview: GET /api/v1/performance/overview?range= --- */

export interface PerfOverviewKpis {
  avgAvailabilityPct: number;
  p95LatencyMs: number;
  avgCpuPct: number;
  avgMemoryPct: number;
  avgUtilizationPct: number;
  packetLossPct: number;
}

/** Sparse series point — only the keys the backend computed are present. */
export interface PerfOverviewPoint {
  ts: string;
  availabilityPct?: number;
  latencyP95?: number;
  cpuAvg?: number;
  memAvg?: number;
  utilInAvg?: number;
  utilOutAvg?: number;
}

export interface PerfTopUtilizer {
  deviceId: string;
  hostname: string;
  siteCode: string;
  utilPct: number;
}

export type PerfHealthDistribution = Record<
  "ONLINE" | "DEGRADED" | "OFFLINE" | "MAINTENANCE" | "UNKNOWN" | "UNMANAGED",
  number
>;

export interface PerfOverviewPayload {
  kpis: PerfOverviewKpis;
  series: PerfOverviewPoint[];
  topUtilizers: PerfTopUtilizer[];
  healthDistribution: PerfHealthDistribution;
}

export interface PerfOverviewResult {
  data: PerfOverviewPayload;
  meta: PerfMetaInfo;
}

/* --- 2. Device performance: GET /api/v1/performance/devices --- */

export type PerfDeviceMetric =
  | "CPU"
  | "MEMORY"
  | "LATENCY_MS"
  | "PACKET_LOSS"
  | "UTILIZATION";

export type PerfDeviceParams = {
  metric?: PerfDeviceMetric;
  range?: PerfRange;
  siteCode?: string;
  q?: string;
  page?: number;
  pageSize?: number;
};

export interface PerfDeviceRow {
  deviceId: string;
  hostname: string;
  siteCode: string;
  criticality: string;
  status: string;
  latest: { value: number; ts: string };
  avg: number;
  max: number;
  p95: number;
  /** Change of the metric across the window, % (sign matters). */
  deltaPct: number;
  /** Small sparkline series (oldest → newest). */
  trend: number[];
}

export type PerfDeviceListMeta = PageMetaInfo;

export interface PerfDeviceListResult {
  data: PerfDeviceRow[];
  meta: PerfDeviceListMeta;
}

/* --- 3. Interface utilization: GET /api/v1/performance/interfaces --- */

export type PerfInterfaceParams = {
  range?: PerfRange;
  siteCode?: string;
  q?: string;
  sort?: "UTIL" | "PACKET_LOSS";
  page?: number;
  pageSize?: number;
};

export interface PerfInterfaceRow {
  interfaceId: string;
  deviceId: string;
  hostname: string;
  siteCode: string;
  ifName: string;
  operStatus: string;
  speedMbps: number;
  utilInPct: number;
  utilOutPct: number;
  utilPeakPct: number;
  packetLossPct: number;
  ts: string;
}

export interface PerfInterfaceListMeta extends PageMetaInfo {
  /** Facet counts over the filtered set, e.g. { UP: 42, DOWN: 1 }. */
  operStatusCounts?: Record<string, number>;
}

export interface PerfInterfaceListResult {
  data: PerfInterfaceRow[];
  meta: PerfInterfaceListMeta;
}

/* --- 4. Availability: GET /api/v1/performance/availability?range= --- */

export interface PerfAvailabilitySite {
  siteCode: string;
  siteName: string;
  uptimePct: number;
  degradedPct: number;
  downtimeMinutes: number;
  deviceCount: number;
}

export interface PerfAvailabilityDevice {
  deviceId: string;
  hostname: string;
  siteCode: string;
  uptimePct: number;
  downtimeMinutes: number;
}

export interface PerfAvailabilityPayload {
  overallPct: number;
  slaTargetPct: number;
  /** Worst site first. */
  bySite: PerfAvailabilitySite[];
  /** Worst device first. */
  byDevice: PerfAvailabilityDevice[];
}

export interface PerfAvailabilityResult {
  data: PerfAvailabilityPayload;
  meta: PerfMetaInfo;
}

/* --- 5. Capacity: GET /api/v1/performance/capacity --- */

export interface CapacityForecastPoint {
  ts: string;
  value: number;
}

export interface CapacityRiskRow {
  deviceId: string;
  hostname: string;
  siteCode: string;
  metric: string;
  current: number;
  /** Least-squares slope, metric units per day. */
  slopePerDay: number;
  /** Days until `horizonPct` is crossed; null = no crossing forecast. */
  daysToThreshold: number | null;
  r2: number;
  confidence: "LOW" | "MEDIUM" | "HIGH";
  /** 1D-rollup history backing the forecast. */
  series: CapacityForecastPoint[];
}

export interface CapacitySummary {
  atRisk30d: number;
  atRisk90d: number;
  noRisk: number;
}

export interface CapacityPayload {
  forecastModel: "LINEAR";
  horizonPct: number;
  /** Sorted by daysToThreshold ascending (nulls last). */
  risks: CapacityRiskRow[];
  summary: CapacitySummary;
}

export type CapacityParams = {
  range?: PerfRange;
  horizonPct?: number;
  horizonDays?: number;
};

export interface CapacityResult {
  data: CapacityPayload;
  meta: PerfMetaInfo;
}

/* --- 6-8. Metrics retention: /api/v1/metrics/retention --- */

export interface RetentionTierConfig {
  days: number;
  enabled: boolean;
}

export type RetentionTierKey = "raw" | "rollup5M" | "rollup1H" | "rollup1D";

export interface MetricsRetentionConfig {
  raw: RetentionTierConfig;
  rollup5M: RetentionTierConfig;
  rollup1H: RetentionTierConfig;
  rollup1D: RetentionTierConfig;
  lastPrunedAt: string | null;
  lastPruneResult: MetricsPruneResult | null;
}

export interface MetricsRetentionUpdatePayload {
  raw?: RetentionTierConfig;
  rollup5M?: RetentionTierConfig;
  rollup1H?: RetentionTierConfig;
  rollup1D?: RetentionTierConfig;
}

export interface MetricsPruneResult {
  metricSamplesDeleted: number;
  rollup5MDeleted: number;
  rollup1HDeleted: number;
  rollup1DDeleted: number;
  durationMs: number;
}

/* --------------------- Performance fetchers --------------------------- */

/**
 * 6-a serves paged performance lists as `data: { rows: [...] }`; the
 * contract also allows a bare array. Unwrap both so the UI is tolerant.
 */
function unwrapRows<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as { rows?: unknown }).rows)) {
    return (body as { rows: T[] }).rows;
  }
  return [];
}

export async function fetchPerformanceOverview(
  range: PerfRange
): Promise<PerfOverviewResult> {
  const envelope = await apiRequest<PerfOverviewPayload>(
    `/api/v1/performance/overview?range=${range}`
  );
  return { data: envelope.data, meta: envelope.meta as unknown as PerfMetaInfo };
}

export async function fetchPerformanceDevices(
  params: PerfDeviceParams
): Promise<PerfDeviceListResult> {
  const envelope = await apiRequest<unknown>(
    `/api/v1/performance/devices${buildQueryString(params)}`
  );
  return {
    data: unwrapRows<PerfDeviceRow>(envelope.data),
    meta: envelope.meta as unknown as PerfDeviceListMeta,
  };
}

export async function fetchPerformanceInterfaces(
  params: PerfInterfaceParams
): Promise<PerfInterfaceListResult> {
  const envelope = await apiRequest<unknown>(
    `/api/v1/performance/interfaces${buildQueryString(params)}`
  );
  return {
    data: unwrapRows<PerfInterfaceRow>(envelope.data),
    meta: envelope.meta as unknown as PerfInterfaceListMeta,
  };
}

export async function fetchPerformanceAvailability(
  range: PerfRange
): Promise<PerfAvailabilityResult> {
  const envelope = await apiRequest<PerfAvailabilityPayload>(
    `/api/v1/performance/availability?range=${range}`
  );
  return {
    data: envelope.data,
    meta: envelope.meta as unknown as PerfMetaInfo,
  };
}

export async function fetchPerformanceCapacity(
  params: CapacityParams
): Promise<CapacityResult> {
  const envelope = await apiRequest<CapacityPayload>(
    `/api/v1/performance/capacity${buildQueryString(params)}`
  );
  return { data: envelope.data, meta: envelope.meta as unknown as PerfMetaInfo };
}

/* ---------------------- Retention fetchers ---------------------------- */

export async function fetchMetricsRetention(): Promise<MetricsRetentionConfig> {
  return apiFetch<MetricsRetentionConfig>("/api/v1/metrics/retention");
}

export async function updateMetricsRetention(
  payload: MetricsRetentionUpdatePayload
): Promise<MetricsRetentionConfig> {
  return apiFetch<MetricsRetentionConfig>("/api/v1/metrics/retention", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export async function pruneMetricsRetention(): Promise<MetricsPruneResult> {
  return apiFetch<MetricsPruneResult>("/api/v1/metrics/retention/prune", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/* ------------------------------------------------------------------ */
/* Admin: auth session, users & roles (Task 7-a)                       */
/* ------------------------------------------------------------------ */

/** User row served by /api/v1/admin/users — passwordHash NEVER crosses the wire. */
export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

export interface AdminUsersListMeta extends PageMetaInfo {
  counts: {
    total: number;
    active: number;
    byRole: Record<string, number>;
  };
}

export interface AdminUsersResult {
  data: AdminUserRow[];
  meta: AdminUsersListMeta;
}

/** Role row served by /api/v1/admin/roles (permissionsJson pre-parsed). */
export interface AdminRoleRow {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  userCount: number;
}

/** Fresh user + permissions from /api/v1/auth/session (UI permission source). */
export interface AuthSessionPayload {
  user: {
    id: string;
    email: string;
    name: string | null;
    role: string;
    isActive: boolean;
    createdAt: string;
  };
  role: {
    name: string;
    description: string | null;
  };
  permissions: string[];
  canWrite: boolean;
}

export interface CreateUserPayload {
  email: string;
  name: string;
  role: string;
  isActive: boolean;
  password: string;
}

export interface UpdateUserPayload {
  name?: string;
  role?: string;
  isActive?: boolean;
  password?: string;
}

export interface UserMutationResult {
  user: AdminUserRow;
}

export interface ResetPasswordResult {
  reset: boolean;
  email: string;
}

export async function fetchAuthSession(): Promise<AuthSessionPayload> {
  return apiFetch<AuthSessionPayload>("/api/v1/auth/session");
}

export async function fetchAdminUsers(
  params: { q?: string; page?: number; pageSize?: number } = {}
): Promise<AdminUsersResult> {
  const envelope = await apiRequest<AdminUserRow[]>(
    `/api/v1/admin/users${buildQueryString(params)}`
  );
  return {
    data: envelope.data,
    meta: envelope.meta as unknown as AdminUsersListMeta,
  };
}

export async function fetchAdminRoles(): Promise<AdminRoleRow[]> {
  return apiFetch<AdminRoleRow[]>("/api/v1/admin/roles");
}

export async function createUser(
  payload: CreateUserPayload
): Promise<UserMutationResult> {
  return apiFetch<UserMutationResult>("/api/v1/admin/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateUser(
  id: string,
  payload: UpdateUserPayload
): Promise<UserMutationResult> {
  return apiFetch<UserMutationResult>(`/api/v1/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function resetUserPassword(
  id: string,
  password: string
): Promise<ResetPasswordResult> {
  return apiFetch<ResetPasswordResult>(
    `/api/v1/admin/users/${id}/reset-password`,
    { method: "POST", body: JSON.stringify({ password }) }
  );
}

/* ------------------------------------------------------------------ */
/* Admin: governance & integrations (Task 7-b)                         */
/* ------------------------------------------------------------------ */

export interface AdminApiClientRow {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface ApiClientsResult {
  clients: AdminApiClientRow[];
  scopes: string[];
}

export interface ApiClientCreatePayload {
  name: string;
  scopes: string[];
  isActive?: boolean;
}

export interface ApiClientCreateResult {
  client: AdminApiClientRow;
  /** Plaintext bearer token — shown exactly once, never stored server-side. */
  token: string;
  audit: { correlationId: string };
}

export interface ApiClientRotateResult {
  client: AdminApiClientRow;
  token: string;
  audit: { correlationId: string };
}

export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  secretMasked: string;
  events: string[];
  isActive: boolean;
  lastStatus: string | null;
  lastStatusCode: number | null;
  lastDeliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface WebhooksResult {
  webhooks: WebhookRow[];
  events: string[];
}

export interface WebhookCreatePayload {
  name: string;
  url: string;
  events: string[];
  isActive?: boolean;
}

export interface WebhookCreateResult {
  webhook: WebhookRow;
  secretOnce: string;
  audit: { correlationId: string };
}

export interface WebhookTestResult {
  delivered: boolean;
  statusCode: number | null;
  durationMs: number;
  error: string | null;
  webhook: {
    id: string;
    lastStatus: string | null;
    lastStatusCode: number | null;
    lastError: string | null;
  };
  audit: { correlationId: string };
}

export interface NotificationChannelRow {
  id: string;
  name: string;
  type: "EMAIL" | "WEBHOOK" | string;
  config: Record<string, unknown>;
  isActive: boolean;
  lastTestAt: string | null;
  lastTestResult: string | null;
  createdAt: string;
}

export interface ChannelsResult {
  channels: NotificationChannelRow[];
  types: string[];
}

export interface ChannelCreatePayload {
  name: string;
  type: string;
  config: { address?: string; displayName?: string; url?: string };
  isActive?: boolean;
}

export interface ChannelTestResult {
  tested: boolean;
  type: string;
  result: string;
  audit: { correlationId: string };
}

export interface CollectorRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  capabilities: string[];
  host: string | null;
  lastSeenAt: string | null;
  stats: Record<string, unknown>;
}

export interface CollectorsResult {
  collectors: CollectorRow[];
  workerReachable: boolean;
}

export interface DriverCapabilityEntry {
  key: string;
  label: string;
}

export interface DriverRow {
  adapter: string;
  vendor: string;
  vendorLabel: string;
  configFlavor: string;
  capabilities: DriverCapabilityEntry[];
  modelFlavors: string[];
  notes: string;
}

export interface DriversResult {
  drivers: DriverRow[];
}

export interface AdminSettingRow {
  key: string;
  value: unknown;
  type: "number" | "string" | "boolean" | string;
  label: string;
  updatedAt: string | null;
}

export interface SettingsResult {
  settings: AdminSettingRow[];
}

export interface SettingsUpdatePayload {
  updates: { key: string; value: string | number | boolean }[];
}

export interface SettingsUpdateResult {
  updated: string[];
  settings: Record<string, unknown>;
  audit: { correlationId: string };
}

export interface AuditChainVerifyResult {
  valid: boolean;
  checked: number;
  brokenAt?: { id: string; index: number; reason: string };
}

export interface AuditChainBackfillResult {
  filled: number;
  remaining: number;
  audit?: { correlationId: string };
}

export async function fetchApiClients(): Promise<ApiClientsResult> {
  return apiFetch<ApiClientsResult>("/api/v1/admin/api-clients");
}

export async function createApiClient(
  payload: ApiClientCreatePayload
): Promise<ApiClientCreateResult> {
  return apiFetch<ApiClientCreateResult>("/api/v1/admin/api-clients", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateApiClient(
  id: string,
  payload: { name?: string; scopes?: string[]; isActive?: boolean }
): Promise<{ client: AdminApiClientRow; audit: { correlationId: string } }> {
  return apiFetch(`/api/v1/admin/api-clients/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function rotateApiClient(id: string): Promise<ApiClientRotateResult> {
  return apiFetch<ApiClientRotateResult>(`/api/v1/admin/api-clients/${id}/rotate`, {
    method: "POST",
  });
}

export async function fetchWebhooks(): Promise<WebhooksResult> {
  return apiFetch<WebhooksResult>("/api/v1/admin/webhooks");
}

export async function createWebhook(
  payload: WebhookCreatePayload
): Promise<WebhookCreateResult> {
  return apiFetch<WebhookCreateResult>("/api/v1/admin/webhooks", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateWebhook(
  id: string,
  payload: { name?: string; url?: string; events?: string[]; isActive?: boolean }
): Promise<{ webhook: WebhookRow; audit: { correlationId: string } }> {
  return apiFetch(`/api/v1/admin/webhooks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteWebhook(id: string): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/v1/admin/webhooks/${id}`, { method: "DELETE" });
}

export async function testWebhook(id: string): Promise<WebhookTestResult> {
  return apiFetch<WebhookTestResult>(`/api/v1/admin/webhooks/${id}/test`, {
    method: "POST",
  });
}

export async function fetchNotificationChannels(): Promise<ChannelsResult> {
  return apiFetch<ChannelsResult>("/api/v1/admin/notification-channels");
}

export async function createNotificationChannel(
  payload: ChannelCreatePayload
): Promise<{ channel: NotificationChannelRow; audit: { correlationId: string } }> {
  return apiFetch("/api/v1/admin/notification-channels", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateNotificationChannel(
  id: string,
  payload: { name?: string; config?: Record<string, unknown>; isActive?: boolean }
): Promise<{ channel: NotificationChannelRow; audit: { correlationId: string } }> {
  return apiFetch(`/api/v1/admin/notification-channels/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function deleteNotificationChannel(
  id: string
): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/v1/admin/notification-channels/${id}`, { method: "DELETE" });
}

export async function testNotificationChannel(
  id: string
): Promise<ChannelTestResult> {
  return apiFetch<ChannelTestResult>(
    `/api/v1/admin/notification-channels/${id}/test`,
    { method: "POST" }
  );
}

export async function fetchCollectors(): Promise<CollectorsResult> {
  return apiFetch<CollectorsResult>("/api/v1/admin/collectors");
}

export async function fetchDrivers(): Promise<DriversResult> {
  return apiFetch<DriversResult>("/api/v1/admin/drivers");
}

export async function fetchAdminSettings(): Promise<SettingsResult> {
  return apiFetch<SettingsResult>("/api/v1/admin/settings");
}

export async function updateAdminSettings(
  payload: SettingsUpdatePayload
): Promise<SettingsUpdateResult> {
  return apiFetch<SettingsUpdateResult>("/api/v1/admin/settings", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export async function verifyAuditChain(): Promise<AuditChainVerifyResult> {
  return apiFetch<AuditChainVerifyResult>("/api/v1/admin/audit-chain/verify");
}

export async function backfillAuditChainApi(): Promise<AuditChainBackfillResult> {
  return apiFetch<AuditChainBackfillResult>("/api/v1/admin/audit-chain/backfill", {
    method: "POST",
  });
}

/* ------------------- Predictive health (Phase 12-c) ------------------- */

/** Deterministic device risk factors (formula "v1", see the API route). */
export interface PredictiveFactors {
  cpuTrend: {
    points: number;
    max: 30;
    cpu: number | null;
    memory: number | null;
    risePerDay: number | null;
  };
  alertPressure: {
    points: number;
    max: 25;
    active: number;
    acknowledged: number;
    worstSeverity: string | null;
  };
  backupReliability: {
    points: number;
    max: 20;
    failureStreak: number;
    policyScheduled: boolean;
    neverBackedUp: boolean;
  };
  drift: { points: number; max: 15; open: number; recent7d: number };
  interfaceErrors: { points: number; max: 10; downInterfaces: number };
}

export type PredictiveBand = "low" | "moderate" | "high" | "critical";

export interface PredictiveDeviceRisk {
  deviceId: string;
  hostname: string;
  vendor: string;
  site: { id: string; name: string; code: string } | null;
  status: string;
  score: number;
  band: PredictiveBand;
  topFactor: {
    factor:
      | "cpuTrend"
      | "alertPressure"
      | "backupReliability"
      | "drift"
      | "interfaceErrors";
    /** English canonical detail (fallback when the detailKey is missing). */
    detail: string;
    /** i18n key under the "predictive" namespace. */
    detailKey: string;
    /** Numbers only — the view interpolates them into the localized string. */
    detailParams: Record<string, number>;
  };
  factors: PredictiveFactors;
}

export interface PredictiveHealthPayload {
  devices: PredictiveDeviceRisk[];
  meta: {
    computedAt: string;
    formula: "v1";
    deviceCount: number;
  };
}

export type PredictiveParams = {
  siteId?: string;
};

export async function fetchPredictiveHealth(
  params: PredictiveParams = {}
): Promise<PredictiveHealthPayload> {
  return apiFetch<PredictiveHealthPayload>(
    `/api/v1/predictive${buildQueryString(params)}`
  );
}

/* ------------------------------------------------------------------ */
/* AI operations (Phase 12-a)                                          */
/* ------------------------------------------------------------------ */

/** Aggregate of what the AI actually considered when answering. */
export interface AiContextSummary {
  alertsConsidered: number;
  eventsConsidered: number;
  incidentsConsidered: number;
}

export interface AiAssistPayload {
  scope: "device" | "incident";
  id: string;
  /** 1..500 chars, enforced server-side too. */
  question: string;
  locale: "en" | "ar";
  actAsUserId?: string;
}

export interface AiAssistResult {
  /** Markdown-ish answer text rendered by the assistant tab. */
  answer: string;
  correlationId: string;
  contextSummary: AiContextSummary;
}

export type RcaConfidence = "low" | "medium" | "high";

/** LLM-drafted post-incident review — a suggestion, never auto-saved. */
export interface RcaDraft {
  summary: string;
  rootCause: string;
  contributingFactors: string[];
  remediation: string[];
  prevention: string[];
  confidence: RcaConfidence;
}

export interface AiRcaDraftPayload {
  incidentId: string;
  locale: "en" | "ar";
  actAsUserId?: string;
}

export interface AiRcaDraftResult {
  draft: RcaDraft;
  correlationId: string;
}

export async function requestAiAssist(
  payload: AiAssistPayload
): Promise<AiAssistResult> {
  return apiFetch<AiAssistResult>("/api/v1/ai/assist", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function requestAiRcaDraft(
  payload: AiRcaDraftPayload
): Promise<AiRcaDraftResult> {
  return apiFetch<AiRcaDraftResult>("/api/v1/ai/rca-draft", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/* ------------------------------------------------------------------ */
/* AI change drafts (Phase 13-a) — natural-language → change request   */
/* ------------------------------------------------------------------ */

/** Wizard change types — mirrors ChangeType in src/lib/change/risk.ts. */
export type AiChangeType = "STANDARD" | "NORMAL" | "EMERGENCY";

export type AiRiskHint = "low" | "medium" | "high" | "critical";

/** LLM-drafted change request — a suggestion, never auto-created. */
export interface AiChangeDraft {
  title: string;
  description: string;
  changeType: AiChangeType;
  riskHint: AiRiskHint;
  implementationPlan: string[];
  validationPlan: string[];
  rollbackPlan: string[];
  suggestedWindowHint: string | null;
}

/**
 * Device the server matched from the draft's hostname references (ids are
 * resolved server-side against the real inventory). Carries the attributes
 * the change wizard's risk engine needs (criticality/site/vendor/model/role).
 */
export interface AiMatchedDevice {
  id: string;
  hostname: string;
  model: string | null;
  role: string | null;
  criticality: string;
  siteCode: string | null;
  vendorKey: string | null;
}

export interface AiChangeDraftPayload {
  /** 10..600 chars, enforced server-side too. */
  prompt: string;
  locale: "en" | "ar";
  actAsUserId?: string;
}

export interface AiChangeDraftResult {
  draft: AiChangeDraft;
  matchedDevices: AiMatchedDevice[];
  correlationId: string;
}

/** User-reviewed draft handed from the AI dialog into the change wizard. */
export interface AiChangeDraftPrefill {
  draft: AiChangeDraft;
  matchedDevices: AiMatchedDevice[];
  correlationId: string;
}

export async function requestAiChangeDraft(
  payload: AiChangeDraftPayload
): Promise<AiChangeDraftResult> {
  return apiFetch<AiChangeDraftResult>("/api/v1/ai/change-draft", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/* ------------------------------------------------------------------ */
/* AI network query (Phase 14-a) — "Ask the network"                   */
/* ------------------------------------------------------------------ */

export type AskNetworkIntent =
  | "inventory"
  | "incidents"
  | "changes"
  | "jobs"
  | "predictive"
  | "summary";

export interface AskNetworkDeviceRow {
  id: string;
  hostname: string;
  model: string | null;
  firmware: string | null;
  status: string;
  criticality: string;
  backupCompliance: string;
  siteCode: string | null;
  siteName: string | null;
  vendorKey: string | null;
}

export interface AskNetworkIncidentRow {
  id: string;
  number: string;
  title: string;
  severity: string;
  status: string;
  siteCode: string | null;
  createdAt: string;
  slaDueAt: string | null;
  linkedChangeNumber: string | null;
}

export interface AskNetworkChangeRow {
  id: string;
  number: string;
  title: string;
  type: string;
  status: string;
  riskLevel: string;
  siteCode: string | null;
  scheduledStart: string | null;
  createdAt: string;
}

export interface AskNetworkJobRow {
  correlationId: string;
  type: string;
  status: string;
  progress: number;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** Approximate alert-pressure ranking (labeled as approximate in the UI). */
export interface AskNetworkPredictiveRow {
  hostname: string;
  status: string;
  criticality: string;
  siteCode: string | null;
  activeAlerts: number;
  worstSeverity: string | null;
}

export interface AskNetworkSnapshot {
  devicesByStatus: Record<string, number>;
  openIncidentsBySeverity: Record<string, number>;
  recentChanges: { number: string; title: string; status: string }[];
  backupJobs24h: {
    total: number;
    succeeded: number;
    successRatePct: number | null;
  };
}

export interface AskNetworkFilters {
  site: string | null;
  vendor: string | null;
  severity: string | null;
  status: string | null;
  hostnameLike: string | null;
  limit: number | null;
}

export interface AskNetworkResult {
  intent: AskNetworkIntent;
  appliedFilters: AskNetworkFilters;
  /** LLM grounded answer — or the deterministic bullet summary on fallback. */
  summary: string;
  results: {
    devices?: AskNetworkDeviceRow[];
    incidents?: AskNetworkIncidentRow[];
    changes?: AskNetworkChangeRow[];
    jobs?: AskNetworkJobRow[];
    predictive?: AskNetworkPredictiveRow[];
    snapshot?: AskNetworkSnapshot;
  };
  sources: string[];
  /** true = the LLM answer failed and a deterministic summary is shown. */
  fallback: boolean;
  correlationId: string;
}

export interface AskNetworkPayload {
  /** 10..500 chars, enforced server-side too. */
  prompt: string;
  locale: "en" | "ar";
}

export async function requestAskNetwork(
  payload: AskNetworkPayload
): Promise<AskNetworkResult> {
  return apiFetch<AskNetworkResult>("/api/v1/ai/query", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/* ------------------------------------------------------------------ */
/* Flow analytics (Phase 13-c) — deterministic simulated NetFlow       */
/* ------------------------------------------------------------------ */

export type FlowWindow = "1h" | "6h" | "24h";

export interface FlowTopTalker {
  rank: number;
  srcIp: string;
  /** Dominant destination, or null when the source spread across many. */
  dstIp: string | null;
  dstIpCount: number;
  bytes: number;
  packets: number;
  flows: number;
  topProtocol: string;
  topPort: number;
}

export interface FlowProtocolRow {
  protocol: string;
  port: number;
  bytes: number;
  packets: number;
  flows: number;
  /** Share of total bytes, 0–100. */
  pct: number;
}

export interface FlowInterfaceTotal {
  interfaceId: string;
  name: string;
  speedMbps: number | null;
  inMbps: number;
  outMbps: number;
  bytes: number;
  packets: number;
  flows: number;
}

export interface FlowSampleRecord {
  id: string;
  ts: string;
  interfaceId: string;
  interfaceName: string;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  protocol: string;
  bytes: number;
  packets: number;
  tcpFlags: string | null;
  direction: "in" | "out";
}

export interface FlowsPayload {
  device: {
    id: string;
    hostname: string;
    mgmtIp: string;
    status: string;
    siteCode: string | null;
    siteName: string | null;
  };
  totals: {
    bytes: number;
    packets: number;
    flows: number;
    avgInMbps: number;
    avgOutMbps: number;
  };
  topTalkers: FlowTopTalker[];
  protocolDistribution: FlowProtocolRow[];
  interfaceTotals: FlowInterfaceTotal[];
  /** Newest first, ≤ 50 records. */
  sample: FlowSampleRecord[];
  meta: {
    window: FlowWindow;
    bucketMs: number;
    buckets: number;
    windowStart: string;
    windowEnd: string;
    computedAt: string;
  };
}

export interface FlowsResult {
  data: FlowsPayload;
  meta: Record<string, unknown>;
}

/**
 * GET /api/v1/flows?deviceId=…&window=… — deterministic per-bucket flow
 * analytics. Numbers are stable within a 15-minute bucket, so a slow
 * poll never flickers the UI.
 */
export async function fetchFlows(
  deviceId: string,
  window: FlowWindow
): Promise<FlowsResult> {
  const envelope = await apiRequest<FlowsPayload>(
    `/api/v1/flows?deviceId=${encodeURIComponent(deviceId)}&window=${window}`
  );
  return { data: envelope.data, meta: envelope.meta ?? {} };
}

/* ------------------------------------------------------------------ */
/* Firmware lifecycle (Phase 13-b)                                     */
/* ------------------------------------------------------------------ */

export type FirmwareLifecycleStatus = "current" | "aging" | "eos" | "eol";

/** One device row of the firmware inventory (GET /api/v1/firmware). */
export interface FirmwareDeviceRow {
  deviceId: string;
  hostname: string;
  deviceStatus: string;
  vendorKey: string;
  vendorName: string;
  model: string | null;
  platform: string | null;
  firmware: string | null;
  lifecycle: {
    status: FirmwareLifecycleStatus;
    /** English canonical detail (technical fallback — the view localizes). */
    detail: string;
    family: string;
  } | null;
  /** Matrix-suggested stable version (upgrade dialog pre-fill). */
  suggestedTarget: string | null;
  /** finishedAt of the device's newest SUCCEEDED FIRMWARE_UPGRADE job. */
  lastUpgradeAt: string | null;
  /** True while a FIRMWARE_UPGRADE job for the device is QUEUED/RUNNING. */
  openUpgradeJob: boolean;
}

export interface FirmwareInventoryPayload {
  devices: FirmwareDeviceRow[];
  meta: {
    counts: {
      total: number;
      current: number;
      aging: number;
      eos: number;
      eol: number;
      unknown: number;
    };
    computedAt: string;
  };
}

export async function fetchFirmwareInventory(): Promise<FirmwareInventoryPayload> {
  return apiFetch<FirmwareInventoryPayload>("/api/v1/firmware");
}

export interface FirmwareUpgradeResult {
  jobId: string;
  correlationId: string;
  deviceId: string;
  hostname: string;
  fromVersion: string | null;
  targetVersion: string;
  type: "FIRMWARE_UPGRADE";
  status: "QUEUED";
}

export async function requestFirmwareUpgrade(payload: {
  deviceId: string;
  targetVersion: string;
  actAsUserId?: string;
}): Promise<FirmwareUpgradeResult> {
  return apiFetch<FirmwareUpgradeResult>("/api/v1/firmware/upgrade", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/* ------------------------------------------------------------------ */
/* Zero-touch provisioning (Phase 14-b)                                */
/* ------------------------------------------------------------------ */

/** One claim row of the ZTP queue (GET /api/v1/ztp/claims). */
export interface ZtpClaimRow {
  id: string;
  serial: string;
  hostname: string;
  vendorKey: string;
  vendorName: string;
  model: string;
  templateId: string;
  siteId: string | null;
  siteCode: string | null;
  siteName: string | null;
  deviceId: string | null;
  deviceHostname: string | null;
  /** Persisted status: pending | provisioning | provisioned | failed. */
  status: string;
  /** Persisted status with the running-job overlay applied. */
  effectiveStatus: string;
  requestedBy: string | null;
  /** Actual management address once provisioned (from the Device row). */
  mgmtIp: string | null;
  /** Next free address in the site /24 while the claim is unresolved. */
  projectedMgmtIp: string | null;
  createdAt: string;
  updatedAt: string;
  activeJob: {
    id: string;
    correlationId: string;
    status: string;
    progress: number;
    createdAt: string;
  } | null;
}

/** Template catalog entry (mirrors ZtpTemplate from src/lib/ztp/templates). */
export interface ZtpTemplateInfo {
  id: string;
  vendorKey: string;
  name: string;
  description: string;
  lines: string[];
}

export interface ZtpVendorOption {
  key: string;
  name: string;
  hasTemplate: boolean;
}

export interface ZtpSiteOption {
  id: string;
  code: string;
  name: string;
}

/** Recent ZTP_* audit row (provisioning history). */
export interface ZtpHistoryRow {
  action: string;
  result: string;
  actorName: string;
  resourceLabel: string;
  correlationId: string | null;
  createdAt: string;
}

export interface ZtpPayload {
  claims: ZtpClaimRow[];
  templates: ZtpTemplateInfo[];
  vendors: ZtpVendorOption[];
  sites: ZtpSiteOption[];
  counts: {
    total: number;
    pending: number;
    provisioning: number;
    provisioned: number;
    failed: number;
  };
  history: ZtpHistoryRow[];
  meta: { computedAt: string };
}

export async function fetchZtp(): Promise<ZtpPayload> {
  return apiFetch<ZtpPayload>("/api/v1/ztp/claims");
}

export interface ZtpClaimCreated {
  claim: {
    id: string;
    serial: string;
    hostname: string;
    vendorKey: string;
    model: string;
    templateId: string;
    siteId: string | null;
    status: string;
    requestedBy: string | null;
    createdAt: string;
  };
  jobId: string;
  correlationId: string;
  projectedMgmtIp: string;
  type: "ZTP_PROVISION";
  status: "QUEUED";
}

export async function requestCreateZtpClaim(payload: {
  serial: string;
  hostname: string;
  vendorKey: string;
  model: string;
  templateId: string;
  siteId?: string;
  requestedBy?: string;
}): Promise<ZtpClaimCreated> {
  return apiFetch<ZtpClaimCreated>("/api/v1/ztp/claims", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/* ------------------------------------------------------------------ */
/* HA/DR topology (Phase 14-c)                                         */
/* ------------------------------------------------------------------ */

export type HaPairMode = "active-standby" | "active-active";
export type HaReadinessBand = "healthy" | "degraded" | "at-risk";
export type HaTestResult = "passed" | "degraded" | "never-tested";
export type ReplicationTech = "sync-mirror" | "async-snapshot";

/** One pair member with live device state (GET /api/v1/ha). */
export interface HaPairMember {
  deviceId: string;
  hostname: string;
  status: string;
  model: string | null;
  /** BigInt-as-string wire convention (seconds). */
  uptimeSeconds: string | null;
}

/** Latest failover state derived from HA_FAILOVER_TEST audit rows. */
export interface HaFailoverState {
  activeMember: string;
  lastTestedAt: string | null;
  lastResult: HaTestResult;
  testCount: number;
  correlationId: string | null;
}

/** One HA pair row of GET /api/v1/ha. */
export interface HaPairRow {
  pairId: string;
  name: string;
  mode: HaPairMode;
  vip: string;
  siteCode: string;
  members: HaPairMember[];
  failover: HaFailoverState;
}

/** Deterministic DR-readiness composition (see src/lib/ha/topology.ts). */
export interface HaReadiness {
  score: number;
  band: HaReadinessBand;
  backupSuccessRate: number;
  openCritical: number;
  /** 0–1 — share of the primary site's devices currently ONLINE. */
  memberOnlineRatio: number;
}

/** One DR mapping row of GET /api/v1/ha. */
export interface DrSiteRow {
  primary: string;
  secondary: string;
  rpoTargetMinutes: number;
  rtoTargetMinutes: number;
  replicationTech: ReplicationTech;
  readiness: HaReadiness;
}

export interface HaTopologyPayload {
  pairs: HaPairRow[];
  drSites: DrSiteRow[];
  meta: { generatedAt: string };
}

export async function fetchHaTopology(): Promise<HaTopologyPayload> {
  return apiFetch<HaTopologyPayload>("/api/v1/ha");
}

/** One staged step of the deterministic failover test (POST response). */
export interface HaFailoverStageResult {
  stage: string;
  result: string;
  at: string;
}

export interface HaFailoverTestResult {
  pairId: string;
  pairName: string;
  mode: HaPairMode;
  correlationId: string;
  result: Exclude<HaTestResult, "never-tested">;
  durationMs: number;
  stages: HaFailoverStageResult[];
  activeMember: string;
  offlineMembers: string[];
  vip: string;
}

export async function requestFailoverTest(payload: {
  pairId: string;
  actAsUserId?: string;
}): Promise<HaFailoverTestResult> {
  return apiFetch<HaFailoverTestResult>("/api/v1/ha/failover-test", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
