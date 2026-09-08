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
  // Maintenance windows + audit-event stream (Task 5-c). Mutations
  // invalidate the whole "maintenance" / "events" trees; maintenance
  // writes also refresh "alerts" (suppression semantics) and "events"
  // (audit trail).
  maintenance: (params: ListParams = {}) => ["maintenance", params] as const,
  events: (params: ListParams = {}) => ["events", params] as const,
  // Performance slice (Task 6-b) — one nested tree per facet:
  // ["performance", "overview"|"devices"|"interfaces"|"availability"|"capacity", params]
  // so invalidating ["performance"] refreshes every perf surface at once.
  performance: (facet: string, params: ListParams = {}) =>
    ["performance", facet, params] as const,
  // Metrics retention settings + prune results (Task 6-b). Retention
  // mutations invalidate this key; prune also refreshes "performance"
  // (pruning shrinks the series the perf views read).
  metricsRetention: ["metrics", "retention"] as const,

  // ── Reports: schedules + runs history (Task 9-a) ──────────────────────
  // Nested under the "reports" prefix so schedule/run mutations invalidate
  // both surfaces at once. Run-now also invalidates "jobs" (Job Center
  // shows the REPORT_RUN row) and "events" (audit trail) via the hooks.
  reportSchedules: (params: ListParams = {}) =>
    ["reports", "schedules", params] as const,
  reportRuns: (params: ListParams = {}) => ["reports", "runs", params] as const,

  // ── Admin: users/roles (Task 7-a) ─────────────────────────────────────
  // Nested under the "admin" prefix so user/role mutations invalidate
  // every admin surface at once. authSession is the permission bootstrap
  // (hydrated into the permissions store); it lives under "auth" so
  // sign-in/out can invalidate it independently.
  adminUsers: (params: ListParams = {}) => ["admin", "users", params] as const,
  adminRoles: () => ["admin", "roles"] as const,
  authSession: () => ["auth", "session"] as const,

  // ── Admin: governance & integrations (Task 7-b) ──────────────────────
  // Same "admin" prefix tree; governance mutations invalidate ["admin"]
  // (users/roles incl.) plus "events" via the hooks (every admin action
  // is audited into the event stream).
  apiClients: (params: ListParams = {}) => ["admin", "apiClients", params] as const,
  webhooks: (params: ListParams = {}) => ["admin", "webhooks", params] as const,
  notificationChannels: (params: ListParams = {}) =>
    ["admin", "notificationChannels", params] as const,
  collectors: () => ["admin", "collectors"] as const,
  drivers: () => ["admin", "drivers"] as const,
  adminSettings: () => ["admin", "settings"] as const,
  auditChain: () => ["admin", "auditChain"] as const,

  // ── AI operations (Phase 12-a) ───────────────────────────────────────
  // AI assist / RCA drafts are mutations (LLM round-trips); these keys mark
  // the mutation cache entries under the "ai" tree and let consumers scope
  // invalidations (AI actions also refresh the "events" audit stream).
  aiAssist: (scope: string, id: string) => ["ai", "assist", scope, id] as const,
  aiRcaDraft: (incidentId: string) => ["ai", "rcaDraft", incidentId] as const,

  // ── Predictive health (Phase 12-c) ───────────────────────────────────
  // Read-only risk scores; params carry the optional siteId filter so the
  // view and the dashboard widget share one cached payload per site scope.
  predictive: (params: ListParams = {}) => ["predictive", params] as const,
};
