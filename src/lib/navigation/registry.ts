import type { ViewKey } from "@/stores/navigation";

/**
 * View registry — the single mapping from a ViewKey to its display metadata.
 * Titles follow the sidebar taxonomy of the design spec (§16); `phase`
 * names the roadmap phase that delivers the full module (used by the
 * placeholder views until then).
 */

export type NavGroup =
  | "Overview"
  | "Network"
  | "Configurations"
  | "Changes"
  | "Operations"
  | "Performance"
  | "Reports"
  | "Administration";

export interface ViewMeta {
  title: string;
  description: string;
  /** Roadmap phase that delivers the full module. */
  phase: string;
  group: NavGroup;
  /**
   * Optional i18n key into the `nav.items` namespace (Task 8-a). Consumers
   * that translate nav labels resolve this dotted path against the active
   * messages and fall back to `title` when the key is missing or the
   * next-intl provider is absent — breadcrumbFor()/getViewMeta() keep
   * working unchanged.
   */
  labelKey?: string;
}

export const VIEW_REGISTRY: Record<ViewKey, ViewMeta> = {
  dashboard: {
    title: "Dashboard",
    description: "Network operations overview",
    phase: "Phase 1 — Foundation",
    group: "Overview",
    labelKey: "nav.items.dashboard",
  },

  "network.devices": {
    title: "Devices",
    description: "Multi-vendor device inventory",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
    labelKey: "nav.items.network.devices",
  },
  // Hidden from the sidebar (sidebar groups list their items explicitly);
  // opened via setActiveView("network.device-detail", { deviceId }).
  "network.device-detail": {
    title: "Device Detail",
    description: "Full device record — health, interfaces, configs and history",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
    labelKey: "nav.items.network.device-detail",
  },
  "network.sites": {
    title: "Sites",
    description: "Sites, regions and locations",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
    labelKey: "nav.items.network.sites",
  },
  "network.interfaces": {
    title: "Interfaces",
    description: "Interface inventory across devices",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
    labelKey: "nav.items.network.interfaces",
  },
  "network.topology": {
    title: "Topology",
    description: "Network topology map",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
    labelKey: "nav.items.network.topology",
  },
  "network.discovery": {
    title: "Discovery",
    description: "Scan candidates and device import",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
    labelKey: "nav.items.network.discovery",
  },
  "network.firmware": {
    title: "Firmware",
    description: "Fleet firmware lifecycle — versions, EOS/EOL and upgrades",
    phase: "Phase 13 — Parked-tier pull-forward (13-b)",
    group: "Network",
    labelKey: "nav.items.network.firmware",
  },

  "config.backups": {
    title: "Backups",
    description: "Scheduled and on-demand configuration backups",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
    labelKey: "nav.items.config.backups",
  },
  "config.snapshots": {
    title: "Snapshots",
    description: "Configuration version history",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
    labelKey: "nav.items.config.snapshots",
  },
  "config.baselines": {
    title: "Baselines",
    description: "Approved golden configurations",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
    labelKey: "nav.items.config.baselines",
  },
  "config.drift": {
    title: "Drift",
    description: "Configuration drift detection and review",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
    labelKey: "nav.items.config.drift",
  },
  "config.compliance": {
    title: "Compliance",
    description: "Backup compliance across the fleet",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
    labelKey: "nav.items.config.compliance",
  },

  "changes.all": {
    title: "All Changes",
    description: "Change requests across the lifecycle",
    phase: "Phase 4 — Change Management",
    group: "Changes",
    labelKey: "nav.items.changes.all",
  },
  "changes.mine": {
    title: "My Changes",
    description: "Changes you requested or own",
    phase: "Phase 4 — Change Management",
    group: "Changes",
    labelKey: "nav.items.changes.mine",
  },
  "changes.approvals": {
    title: "Approvals",
    description: "Approval queue (technical, security, manager, CAB)",
    phase: "Phase 4 — Change Management",
    group: "Changes",
    labelKey: "nav.items.changes.approvals",
  },
  "changes.calendar": {
    title: "Calendar",
    description: "Scheduled changes with conflict highlighting",
    phase: "Phase 4 — Change Management",
    group: "Changes",
    labelKey: "nav.items.changes.calendar",
  },
  "changes.templates": {
    title: "Templates",
    description: "Reusable per-vendor change templates",
    phase: "Phase 4 — Change Management",
    group: "Changes",
    labelKey: "nav.items.changes.templates",
  },
  // Hidden from the sidebar (opened via setActiveView("changes.change-detail",
  // { changeId }) — same pattern as network.device-detail). Task 4-a.
  "changes.change-detail": {
    title: "Change Detail",
    description: "Full change record — plans, devices, steps, approvals and links",
    phase: "Phase 4 — Change Management",
    group: "Changes",
    labelKey: "nav.items.changes.change-detail",
  },

  "ops.noc": {
    title: "NOC View",
    description: "Fullscreen wall-board for the network operations center",
    phase: "Phase 5 — Operations",
    group: "Operations",
    labelKey: "nav.items.ops.noc",
  },
  "ops.alerts": {
    title: "Alerts",
    description: "Live alert stream with acknowledge and suppress",
    phase: "Phase 1 — live slice (full build in Phase 5)",
    group: "Operations",
    labelKey: "nav.items.ops.alerts",
  },
  "ops.incidents": {
    title: "Incidents",
    description: "Incident lifecycle with SLA timers",
    phase: "Phase 5 — Operations",
    group: "Operations",
    labelKey: "nav.items.ops.incidents",
  },
  // Hidden from the sidebar (opened via setActiveView("ops.incident-detail",
  // { incidentId }) — same pattern as changes.change-detail). Task 5-b.
  "ops.incident-detail": {
    title: "Incident Detail",
    description: "Full incident record — timeline, SLA, PIR and linked records",
    phase: "Phase 5 — Operations",
    group: "Operations",
    labelKey: "nav.items.ops.incident-detail",
  },
  "ops.maintenance": {
    title: "Maintenance Windows",
    description: "Planned windows — CRUD with live suppression status",
    phase: "Phase 5 — Operations (5-c)",
    group: "Operations",
    labelKey: "nav.items.ops.maintenance",
  },
  "ops.events": {
    title: "Event Stream",
    description: "Audit-event timeline — actors, actions and payloads",
    phase: "Phase 5 — Operations (5-c)",
    group: "Operations",
    labelKey: "nav.items.ops.events",
  },
  "ops.jobs": {
    title: "Job Center",
    description: "Background job queue, progress and results",
    phase: "Phase 1 — live slice (full build in Phase 2)",
    group: "Operations",
    labelKey: "nav.items.ops.jobs",
  },

  "perf.overview": {
    title: "Performance Overview",
    description: "Fleet-wide performance at a glance",
    phase: "Phase 6 — Performance & Metrics (6-b)",
    group: "Performance",
    labelKey: "nav.items.perf.overview",
  },
  "perf.devices": {
    title: "Device Performance",
    description: "CPU, memory and per-device metrics",
    phase: "Phase 6 — Performance & Metrics (6-b)",
    group: "Performance",
    labelKey: "nav.items.perf.devices",
  },
  "perf.interfaces": {
    title: "Interface Utilization",
    description: "Per-interface traffic and errors",
    phase: "Phase 6 — Performance & Metrics (6-b)",
    group: "Performance",
    labelKey: "nav.items.perf.interfaces",
  },
  "perf.availability": {
    title: "Availability",
    description: "Uptime and SLA attainment",
    phase: "Phase 6 — Performance & Metrics (6-b)",
    group: "Performance",
    labelKey: "nav.items.perf.availability",
  },
  "perf.capacity": {
    title: "Capacity",
    description: "Capacity risks and growth forecast",
    phase: "Phase 6 — Performance & Metrics (6-b)",
    group: "Performance",
    labelKey: "nav.items.perf.capacity",
  },
  "perf.flows": {
    title: "Flow Analytics",
    description: "NetFlow-style conversation analytics — top talkers, protocol mix and interface totals",
    phase: "Phase 13 — Parked-tier pull-forward (13-c)",
    group: "Performance",
    labelKey: "nav.items.perf.flows",
  },
  "perf.predictive": {
    title: "Predictive Health",
    description: "Deterministic device risk scores and factor breakdowns",
    phase: "Phase 12 — Parked-tier pull-forward (12-c)",
    group: "Performance",
    labelKey: "nav.items.perf.predictive",
  },

  "reports.reports": {
    title: "Reports",
    description: "Generated report runs — history and downloads",
    phase: "Phase 9 — Report scheduler (9-a)",
    group: "Reports",
    labelKey: "nav.items.reports.reports",
  },
  "reports.scheduled": {
    title: "Scheduled Reports",
    description: "Recurring report schedules — create, edit, run now",
    phase: "Phase 9 — Report scheduler (9-a)",
    group: "Reports",
    labelKey: "nav.items.reports.scheduled",
  },
  "reports.builder": {
    title: "Report Builder",
    description: "Compose custom reports",
    phase: "Phase 9 — Hardening & demo readiness (stretch)",
    group: "Reports",
    labelKey: "nav.items.reports.builder",
  },

  "admin.users": {
    title: "Users & Roles",
    description: "Accounts, roles and permissions",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
    labelKey: "nav.items.admin.users",
  },
  "admin.credentials": {
    title: "Credential Profiles",
    description: "Vault-backed device credentials (never displayed)",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
    labelKey: "nav.items.admin.credentials",
  },
  "admin.apiClients": {
    title: "API Clients",
    description: "Scoped API tokens for integrations",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
    labelKey: "nav.items.admin.apiClients",
  },
  "admin.collectors": {
    title: "Collectors",
    description: "Poller and collector registry",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
    labelKey: "nav.items.admin.collectors",
  },
  "admin.drivers": {
    title: "Device Drivers",
    description: "Vendor adapter catalog and capabilities",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
    labelKey: "nav.items.admin.drivers",
  },
  "admin.integrations": {
    title: "Integrations",
    description: "Webhooks, notification channels, ticketing",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
    labelKey: "nav.items.admin.integrations",
  },
  "admin.system": {
    title: "System Settings",
    description: "Retention, scheduling and platform settings",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
    labelKey: "nav.items.admin.system",
  },
};

export function getViewMeta(view: ViewKey): ViewMeta {
  return VIEW_REGISTRY[view];
}

/** Runtime guard: is an arbitrary string (e.g. a notification deep-link) a registered view key? */
export function isValidViewKey(value: string): value is ViewKey {
  return Object.prototype.hasOwnProperty.call(VIEW_REGISTRY, value);
}

/** Breadcrumb trail for the header, derived from the registry. */
export function breadcrumbFor(view: ViewKey): { label: string }[] {
  const meta = VIEW_REGISTRY[view];
  if (view === "dashboard") return [{ label: meta.title }];
  return [{ label: meta.group }, { label: meta.title }];
}
