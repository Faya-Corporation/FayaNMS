import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Typed client-side view router. The sandbox exposes a single route (`/`),
 * so the full sidebar taxonomy from the design spec (§16) maps 1:1 onto
 * these view keys (mirroring the deep route map of the source documents —
 * see worklog ADR-02).
 */
export type ViewKey =
  // Network
  | "dashboard"
  | "network.devices"
  | "network.device-detail"
  | "network.sites"
  | "network.interfaces"
  | "network.topology"
  | "network.discovery"
  | "network.firmware"
  // Configurations
  | "config.backups"
  | "config.snapshots"
  | "config.baselines"
  | "config.drift"
  | "config.compliance"
  // Changes
  | "changes.all"
  | "changes.mine"
  | "changes.approvals"
  | "changes.calendar"
  | "changes.templates"
  | "changes.change-detail"
  // Operations
  | "ops.noc"
  | "ops.alerts"
  | "ops.incidents"
  | "ops.incident-detail"
  | "ops.maintenance"
  | "ops.events"
  | "ops.jobs"
  // Performance
  | "perf.overview"
  | "perf.devices"
  | "perf.interfaces"
  | "perf.availability"
  | "perf.capacity"
  | "perf.flows"
  | "perf.predictive"
  // Reports
  | "reports.reports"
  | "reports.scheduled"
  | "reports.builder"
  // Administration
  | "admin.users"
  | "admin.credentials"
  | "admin.apiClients"
  | "admin.collectors"
  | "admin.drivers"
  | "admin.integrations"
  | "admin.system";

interface NavigationState {
  activeView: ViewKey;
  /** Free-form params for the active view (e.g. selected device id). */
  params: Record<string, string> | null;
  setActiveView: (view: ViewKey, params?: Record<string, string>) => void;
}

export const useNavigationStore = create<NavigationState>()(
  persist(
    (set) => ({
      activeView: "dashboard",
      params: null,
      setActiveView: (view, params) => set({ activeView: view, params: params ?? null }),
    }),
    {
      name: "fayanms-nav",
      // Rehydrated manually after mount by the app shell to avoid an
      // SSR/client-first-render mismatch (same pattern as fayanms-prefs).
      skipHydration: true,
    }
  )
);
