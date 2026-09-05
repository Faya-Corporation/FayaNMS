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
  changes: (params: ListParams = {}) => ["changes", params] as const,
  alerts: (params: ListParams = {}) => ["alerts", params] as const,
  jobs: (params: ListParams = {}) => ["jobs", params] as const,
  meta: ["meta"] as const,
  search: (q: string) => ["search", q] as const,
};
