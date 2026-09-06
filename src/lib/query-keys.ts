/**
 * Centralized TanStack Query keys. Every hook builds its cache key here so
 * invalidation stays predictable (e.g. queueing a job invalidates all
 * `jobs` + `dashboard` queries).
 *
 * Device keys nest under the `devices` prefix: detail/metrics/interfaces…
 * are ["devices", id, <facet>, …] so `invalidateQueries({ queryKey:
 * ["devices"] })` refreshes lists AND every per-device facet at once.
 */

export interface ListParams {
  [key: string]: unknown;
}

export const queryKeys = {
  dashboard: (range: string) => ["dashboard", range] as const,
  devices: (params: ListParams = {}) => ["devices", params] as const,
  deviceDetail: (id: string) => ["devices", id, "detail"] as const,
  deviceMetrics: (id: string, window: string) =>
    ["devices", id, "metrics", window] as const,
  deviceSnapshots: (id: string) => ["devices", id, "snapshots"] as const,
  deviceSnapshotDiff: (id: string, from: string, to: string, mode: string) =>
    ["devices", id, "snapshotDiff", { from, to, mode }] as const,
  deviceInterfaces: (id: string, params: ListParams = {}) =>
    ["devices", id, "interfaces", params] as const,
  deviceAlerts: (id: string, params: ListParams = {}) =>
    ["devices", id, "alerts", params] as const,
  deviceIncidents: (id: string) => ["devices", id, "incidents"] as const,
  deviceChanges: (id: string) => ["devices", id, "changes"] as const,
  deviceAudit: (id: string, params: ListParams = {}) =>
    ["devices", id, "audit", params] as const,
  sites: (params: ListParams = {}) => ["sites", params] as const,
  discovery: (params: ListParams = {}) => ["discovery", params] as const,
  credentials: (params: ListParams = {}) => ["credentials", params] as const,
  incidents: (params: ListParams = {}) => ["incidents", params] as const,
  // Incident lifecycle (Task 5-b) — nested under "incidents" so action
  // mutations invalidate lists + stats + detail together.
  incidentDetail: (id: string) => ["incidents", id, "detail"] as const,
  incidentStats: () => ["incidents", "stats"] as const,
  changes: (params: ListParams = {}) => ["changes", params] as const,
  // Change management (Task 4-a) — nested under the "changes" prefix so
  // invalidating ["changes"] refreshes lists, detail and conflicts together.
  changeDetail: (id: string) => ["changes", id, "detail"] as const,
  changeConflicts: (params: ListParams = {}) =>
    ["changes", "conflicts", params] as const,
  // Approval queue (Task 4-b) — decisions invalidate ["approvals"] and
  // ["changes"] together (queue ↔ detail ↔ lists).
  approvals: (params: ListParams = {}) => ["approvals", params] as const,
  alerts: (params: ListParams = {}) => ["alerts", params] as const,
  // Alert rules + notifications center (Task 5-a)
  alertRules: (params: ListParams = {}) => ["alertRules", params] as const,
  notifications: (params: ListParams = {}) => ["notifications", params] as const,
  jobs: (params: ListParams = {}) => ["jobs", params] as const,
  meta: ["meta"] as const,
  search: (q: string) => ["search", q] as const,
  // Backup engine (Task 3-a)
  snapshots: (params: ListParams = {}) => ["snapshots", params] as const,
  backupPolicies: (params: ListParams = {}) =>
    ["backupPolicies", params] as const,
  backupCompliance: (params: ListParams = {}) =>
    ["compliance", "backup", params] as const,
  // Baselines & drift (Task 3-c)
  baselines: () => ["baselines"] as const,
  drift: (params: ListParams = {}) => ["drift", params] as const,
  /** Mutation marker only — invalidating it refreshes drift + jobs. */
  driftCheck: ["drift", "check"] as const,
};
