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

export interface PagedResult<T> {
  data: T[];
  meta: PageMetaInfo;
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
  createdAt: string;
  slaDueAt: string | null;
  resolvedAt: string | null;
  site: { name: string; code: string } | null;
  _count: { devices: number };
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
