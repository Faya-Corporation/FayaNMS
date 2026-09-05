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
