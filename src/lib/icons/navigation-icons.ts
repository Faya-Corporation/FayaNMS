/**
 * Governed navigation icon mapping (Phase B1).
 *
 * Every sidebar view key resolves to exactly one FayaNMS domain glyph from
 * `public/icons/fayanms/`. The mapping is the single source of truth for the
 * sidebar (`src/lib/navigation/sidebar-config.ts`) — view keys are stable,
 * icons are swappable through this registry only.
 */
import type { FayanmsIconName, NavIcon } from "@/lib/icons/types";
import type { ViewKey } from "@/stores/navigation";

/** Small constructor so every entry is uniform and exhaustive-checked. */
const fayanms = (name: FayanmsIconName): NavIcon => ({ kind: "fayanms", name });

/**
 * Sidebar view key → governed domain glyph.
 * Keys mirror the sidebar taxonomy (spec §16); `ViewKey` also contains
 * detail views (network.device-detail, changes.change-detail,
 * ops.incident-detail) which are NOT sidebar entries — see DETAIL_VIEW_ICONS.
 */
export const NAVIGATION_ICONS = {
  dashboard: fayanms("dashboard"),

  "network.devices": fayanms("devices"),
  "network.sites": fayanms("sites"),
  "network.interfaces": fayanms("interfaces"),
  "network.topology": fayanms("topology"),
  "network.discovery": fayanms("discovery"),
  "network.firmware": fayanms("firmware"),
  "network.ztp": fayanms("zero-touch-provisioning"),

  "config.backups": fayanms("backups"),
  "config.snapshots": fayanms("snapshots"),
  "config.baselines": fayanms("baselines"),
  "config.drift": fayanms("drift"),
  "config.compliance": fayanms("compliance"),
  "config.cmdb": fayanms("cmdb"),

  "changes.all": fayanms("all-changes"),
  "changes.mine": fayanms("my-changes"),
  "changes.approvals": fayanms("approvals"),
  "changes.calendar": fayanms("change-calendar"),
  "changes.templates": fayanms("change-templates"),

  "ops.noc": fayanms("noc"),
  "ops.alerts": fayanms("alerts"),
  "ops.incidents": fayanms("incidents"),
  "ops.maintenance": fayanms("maintenance"),
  "ops.events": fayanms("events"),
  "ops.jobs": fayanms("jobs"),
  "ops.ha": fayanms("high-availability"),

  "perf.overview": fayanms("performance"),
  "perf.devices": fayanms("metrics"),
  "perf.interfaces": fayanms("bandwidth"),
  "perf.availability": fayanms("availability"),
  "perf.capacity": fayanms("capacity"),
  "perf.flows": fayanms("flow-analytics"),
  "perf.predictive": fayanms("predictive-health"),

  "reports.reports": fayanms("reports"),
  "reports.scheduled": fayanms("scheduled-reports"),
  "reports.builder": fayanms("report-builder"),

  "admin.users": fayanms("users"),
  "admin.credentials": fayanms("credentials"),
  "admin.apiClients": fayanms("api-clients"),
  "admin.collectors": fayanms("collectors-admin"),
  "admin.drivers": fayanms("device-drivers"),
  "admin.integrations": fayanms("integrations"),
  "admin.system": fayanms("system-settings"),
} as const satisfies Record<string, NavIcon>;

/** View keys present in the sidebar (the NAVIGATION_ICONS keys). */
export type SidebarNavViewKey = keyof typeof NAVIGATION_ICONS;

/**
 * Detail views are reachable (command palette, table rows, alerts) but are
 * not sidebar entries, so they have no first-class mapping. They inherit the
 * glyph of their parent domain (documented choice — the detail view IS that
 * domain's record).
 */
const DETAIL_VIEW_ICONS: Partial<Record<ViewKey, FayanmsIconName>> = {
  "network.device-detail": "devices",
  "changes.change-detail": "all-changes",
  "ops.incident-detail": "incidents",
};

/**
 * Resolve the governed icon for any ViewKey. Returns `undefined` only for
 * keys outside the registry (which would be a registry bug — the sidebar
 * config is validated against this map at type level via `satisfies`).
 */
export function navIconFor(view: ViewKey): NavIcon | undefined {
  if (view in NAVIGATION_ICONS) {
    return NAVIGATION_ICONS[view as SidebarNavViewKey];
  }
  const fallback = DETAIL_VIEW_ICONS[view];
  return fallback ? fayanms(fallback) : undefined;
}
