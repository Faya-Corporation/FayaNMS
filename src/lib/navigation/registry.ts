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
}

export const VIEW_REGISTRY: Record<ViewKey, ViewMeta> = {
  dashboard: {
    title: "Dashboard",
    description: "Network operations overview",
    phase: "Phase 1 — Foundation",
    group: "Overview",
  },

  "network.devices": {
    title: "Devices",
    description: "Multi-vendor device inventory",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
  },
  "network.sites": {
    title: "Sites",
    description: "Sites, regions and locations",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
  },
  "network.interfaces": {
    title: "Interfaces",
    description: "Interface inventory across devices",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
  },
  "network.topology": {
    title: "Topology",
    description: "Network topology map",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
  },
  "network.discovery": {
    title: "Discovery",
    description: "Scan candidates and device import",
    phase: "Phase 2 — Device Inventory",
    group: "Network",
  },

  "config.backups": {
    title: "Backups",
    description: "Scheduled and on-demand configuration backups",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
  },
  "config.snapshots": {
    title: "Snapshots",
    description: "Configuration version history",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
  },
  "config.baselines": {
    title: "Baselines",
    description: "Approved golden configurations",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
  },
  "config.drift": {
    title: "Drift",
    description: "Configuration drift detection and review",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
  },
  "config.compliance": {
    title: "Compliance",
    description: "Backup compliance across the fleet",
    phase: "Phase 3 — Configuration Management",
    group: "Configurations",
  },

  "changes.all": {
    title: "All Changes",
    description: "Change requests across the lifecycle",
    phase: "Phase 4 — Change Management",
    group: "Changes",
  },
  "changes.mine": {
    title: "My Changes",
    description: "Changes you requested or own",
    phase: "Phase 4 — Change Management",
    group: "Changes",
  },
  "changes.approvals": {
    title: "Approvals",
    description: "Approval queue (technical, security, manager, CAB)",
    phase: "Phase 4 — Change Management",
    group: "Changes",
  },
  "changes.calendar": {
    title: "Calendar",
    description: "Scheduled changes with conflict highlighting",
    phase: "Phase 4 — Change Management",
    group: "Changes",
  },
  "changes.templates": {
    title: "Templates",
    description: "Reusable per-vendor change templates",
    phase: "Phase 4 — Change Management",
    group: "Changes",
  },

  "ops.noc": {
    title: "NOC View",
    description: "Fullscreen wall-board for the network operations center",
    phase: "Phase 5 — Operations",
    group: "Operations",
  },
  "ops.alerts": {
    title: "Alerts",
    description: "Live alert stream with acknowledge and suppress",
    phase: "Phase 1 — live slice (full build in Phase 5)",
    group: "Operations",
  },
  "ops.incidents": {
    title: "Incidents",
    description: "Incident lifecycle with SLA timers",
    phase: "Phase 1 — live slice (full build in Phase 5)",
    group: "Operations",
  },
  "ops.maintenance": {
    title: "Maintenance Windows",
    description: "Planned windows and alert suppression",
    phase: "Phase 5 — Operations",
    group: "Operations",
  },
  "ops.events": {
    title: "Event Stream",
    description: "Syslog, traps and collector events",
    phase: "Phase 5 — Operations",
    group: "Operations",
  },
  "ops.jobs": {
    title: "Job Center",
    description: "Background job queue, progress and results",
    phase: "Phase 1 — live slice (full build in Phase 2)",
    group: "Operations",
  },

  "perf.overview": {
    title: "Performance Overview",
    description: "Fleet-wide performance at a glance",
    phase: "Phase 6 — Performance & Metrics",
    group: "Performance",
  },
  "perf.devices": {
    title: "Device Performance",
    description: "CPU, memory and per-device metrics",
    phase: "Phase 6 — Performance & Metrics",
    group: "Performance",
  },
  "perf.interfaces": {
    title: "Interface Utilization",
    description: "Per-interface traffic and errors",
    phase: "Phase 6 — Performance & Metrics",
    group: "Performance",
  },
  "perf.availability": {
    title: "Availability",
    description: "Uptime and SLA attainment",
    phase: "Phase 6 — Performance & Metrics",
    group: "Performance",
  },
  "perf.capacity": {
    title: "Capacity",
    description: "Capacity risks and growth forecast",
    phase: "Phase 6 — Performance & Metrics",
    group: "Performance",
  },

  "reports.reports": {
    title: "Reports",
    description: "Generated reports library",
    phase: "Phase 6 — Performance & Metrics",
    group: "Reports",
  },
  "reports.scheduled": {
    title: "Scheduled Reports",
    description: "Recurring report deliveries",
    phase: "Phase 6 — Performance & Metrics",
    group: "Reports",
  },
  "reports.builder": {
    title: "Report Builder",
    description: "Compose custom reports",
    phase: "Phase 6 — Performance & Metrics",
    group: "Reports",
  },

  "admin.users": {
    title: "Users & Roles",
    description: "Accounts, roles and permissions",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
  },
  "admin.credentials": {
    title: "Credential Profiles",
    description: "Vault-backed device credentials (never displayed)",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
  },
  "admin.apiClients": {
    title: "API Clients",
    description: "Scoped API tokens for integrations",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
  },
  "admin.collectors": {
    title: "Collectors",
    description: "Poller and collector registry",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
  },
  "admin.drivers": {
    title: "Device Drivers",
    description: "Vendor adapter catalog and capabilities",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
  },
  "admin.integrations": {
    title: "Integrations",
    description: "Webhooks, notification channels, ticketing",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
  },
  "admin.system": {
    title: "System Settings",
    description: "Retention, scheduling and platform settings",
    phase: "Phase 7 — Administration & Security",
    group: "Administration",
  },
};

export function getViewMeta(view: ViewKey): ViewMeta {
  return VIEW_REGISTRY[view];
}

/** Breadcrumb trail for the header, derived from the registry. */
export function breadcrumbFor(view: ViewKey): { label: string }[] {
  const meta = VIEW_REGISTRY[view];
  if (view === "dashboard") return [{ label: meta.title }];
  return [{ label: meta.group }, { label: meta.title }];
}
