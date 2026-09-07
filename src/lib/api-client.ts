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

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

interface EnvelopeError {
  success: false;
  error: { code: string; message: string };
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
    throw new ApiError(envelope.error.message, envelope.error.code, response.status);
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
