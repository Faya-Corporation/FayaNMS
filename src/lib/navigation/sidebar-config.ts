import type { NavIcon } from "@/lib/icons";
import { NAVIGATION_ICONS } from "@/lib/icons";
import type { ViewKey } from "@/stores/navigation";

/**
 * Sidebar taxonomy (design spec §16): Dashboard, then the seven domain
 * groups. Badge keys resolve to live counts from the dashboard payload.
 *
 * Phase B1: every entry's glyph comes from the governed icon registry
 * (NAVIGATION_ICONS in src/lib/icons/navigation-icons.ts) — FayaNMS domain
 * glyphs instead of direct Lucide imports. Lucide remains in use for generic
 * controls/status chrome elsewhere (status-icon.tsx, action buttons, …).
 */
export type SidebarBadgeKey = "alerts" | "approvals" | "jobs";

export interface SidebarItemConfig {
  view: ViewKey;
  icon: NavIcon;
  badge?: SidebarBadgeKey;
}

export interface SidebarGroupConfig {
  id: string;
  label: string;
  items: SidebarItemConfig[];
}

export const SIDEBAR_GROUPS: SidebarGroupConfig[] = [
  {
    id: "network",
    label: "Network",
    items: [
      { view: "network.devices", icon: NAVIGATION_ICONS["network.devices"] },
      { view: "network.sites", icon: NAVIGATION_ICONS["network.sites"] },
      { view: "network.interfaces", icon: NAVIGATION_ICONS["network.interfaces"] },
      { view: "network.topology", icon: NAVIGATION_ICONS["network.topology"] },
      { view: "network.discovery", icon: NAVIGATION_ICONS["network.discovery"] },
      { view: "network.firmware", icon: NAVIGATION_ICONS["network.firmware"] },
      { view: "network.ztp", icon: NAVIGATION_ICONS["network.ztp"] },
    ],
  },
  {
    id: "configurations",
    label: "Configurations",
    items: [
      { view: "config.backups", icon: NAVIGATION_ICONS["config.backups"] },
      { view: "config.snapshots", icon: NAVIGATION_ICONS["config.snapshots"] },
      { view: "config.baselines", icon: NAVIGATION_ICONS["config.baselines"] },
      { view: "config.drift", icon: NAVIGATION_ICONS["config.drift"] },
      { view: "config.compliance", icon: NAVIGATION_ICONS["config.compliance"] },
      { view: "config.cmdb", icon: NAVIGATION_ICONS["config.cmdb"] },
    ],
  },
  {
    id: "changes",
    label: "Changes",
    items: [
      { view: "changes.all", icon: NAVIGATION_ICONS["changes.all"] },
      { view: "changes.mine", icon: NAVIGATION_ICONS["changes.mine"] },
      { view: "changes.approvals", icon: NAVIGATION_ICONS["changes.approvals"], badge: "approvals" },
      { view: "changes.calendar", icon: NAVIGATION_ICONS["changes.calendar"] },
      { view: "changes.templates", icon: NAVIGATION_ICONS["changes.templates"] },
    ],
  },
  {
    id: "operations",
    label: "Operations",
    items: [
      { view: "ops.noc", icon: NAVIGATION_ICONS["ops.noc"] },
      { view: "ops.alerts", icon: NAVIGATION_ICONS["ops.alerts"], badge: "alerts" },
      { view: "ops.incidents", icon: NAVIGATION_ICONS["ops.incidents"] },
      { view: "ops.maintenance", icon: NAVIGATION_ICONS["ops.maintenance"] },
      { view: "ops.events", icon: NAVIGATION_ICONS["ops.events"] },
      { view: "ops.jobs", icon: NAVIGATION_ICONS["ops.jobs"], badge: "jobs" },
      { view: "ops.ha", icon: NAVIGATION_ICONS["ops.ha"] },
    ],
  },
  {
    id: "performance",
    label: "Performance",
    items: [
      { view: "perf.overview", icon: NAVIGATION_ICONS["perf.overview"] },
      { view: "perf.devices", icon: NAVIGATION_ICONS["perf.devices"] },
      { view: "perf.interfaces", icon: NAVIGATION_ICONS["perf.interfaces"] },
      { view: "perf.availability", icon: NAVIGATION_ICONS["perf.availability"] },
      { view: "perf.capacity", icon: NAVIGATION_ICONS["perf.capacity"] },
      { view: "perf.flows", icon: NAVIGATION_ICONS["perf.flows"] },
      { view: "perf.predictive", icon: NAVIGATION_ICONS["perf.predictive"] },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    items: [
      { view: "reports.reports", icon: NAVIGATION_ICONS["reports.reports"] },
      { view: "reports.scheduled", icon: NAVIGATION_ICONS["reports.scheduled"] },
      { view: "reports.builder", icon: NAVIGATION_ICONS["reports.builder"] },
    ],
  },
  {
    id: "administration",
    label: "Administration",
    items: [
      { view: "admin.users", icon: NAVIGATION_ICONS["admin.users"] },
      { view: "admin.credentials", icon: NAVIGATION_ICONS["admin.credentials"] },
      { view: "admin.apiClients", icon: NAVIGATION_ICONS["admin.apiClients"] },
      { view: "admin.collectors", icon: NAVIGATION_ICONS["admin.collectors"] },
      { view: "admin.drivers", icon: NAVIGATION_ICONS["admin.drivers"] },
      { view: "admin.integrations", icon: NAVIGATION_ICONS["admin.integrations"] },
      { view: "admin.system", icon: NAVIGATION_ICONS["admin.system"] },
    ],
  },
];
