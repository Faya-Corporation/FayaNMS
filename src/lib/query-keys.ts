/**
 * Centralized TanStack Query keys. Every hook builds its cache key here so
 * invalidation stays predictable (e.g. queueing a job invalidates all
 * `jobs` + `dashboard` queries).
 */

export interface ListParams {
  [key: string]: unknown;
}

export const queryKeys = {
  dashboard: (range: string) => ["dashboard", range] as const,
  devices: (params: ListParams = {}) => ["devices", params] as const,
  incidents: (params: ListParams = {}) => ["incidents", params] as const,
  changes: (params: ListParams = {}) => ["changes", params] as const,
  alerts: (params: ListParams = {}) => ["alerts", params] as const,
  jobs: (params: ListParams = {}) => ["jobs", params] as const,
  meta: ["meta"] as const,
  search: (q: string) => ["search", q] as const,
};
