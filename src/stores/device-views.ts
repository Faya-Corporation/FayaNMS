import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { DeviceSortField } from "@/hooks/api/use-devices";

/**
 * Devices view UI state, persisted to localStorage ("fayanms-device-views"):
 *   - the current filter/sort set (survives navigating into a device detail
 *     and back — the detail's back button simply restores this view),
 *   - named saved views (filters only, rendered as FilterChips),
 *   - column visibility for the DataTable,
 *   - a memo of the pre-maintenance status per device so "toggle maintenance"
 *     can restore the previous state.
 *
 * "ALL" is the sentinel for unset single-select filters.
 */

export interface DeviceFilters {
  q: string;
  status: string;
  vendorId: string;
  siteId: string;
  criticality: string;
  backupCompliance: string;
  sort: DeviceSortField;
  dir: "asc" | "desc";
}

export interface SavedDeviceView {
  id: string;
  name: string;
  filters: DeviceFilters;
  createdAt: string;
}

export const DEFAULT_DEVICE_FILTERS: DeviceFilters = {
  q: "",
  status: "ALL",
  vendorId: "ALL",
  siteId: "ALL",
  criticality: "ALL",
  backupCompliance: "ALL",
  sort: "hostname",
  dir: "asc",
};

/** DataTable columns the user can hide/show (persisted). */
export type DeviceColumnKey =
  | "status"
  | "mgmtIp"
  | "vendor"
  | "model"
  | "site"
  | "criticality"
  | "backup"
  | "lastSeen"
  | "health";

export const DEVICE_COLUMN_LABELS: Record<DeviceColumnKey, string> = {
  status: "Status",
  mgmtIp: "Management IP",
  vendor: "Vendor",
  model: "Model",
  site: "Site",
  criticality: "Criticality",
  backup: "Backup",
  lastSeen: "Last seen",
  health: "Health",
};

const DEFAULT_COLUMNS: Record<DeviceColumnKey, boolean> = {
  status: true,
  mgmtIp: true,
  vendor: true,
  model: true,
  site: true,
  criticality: true,
  backup: true,
  lastSeen: true,
  health: true,
};

interface DeviceViewsState {
  filters: DeviceFilters;
  savedViews: SavedDeviceView[];
  columns: Record<DeviceColumnKey, boolean>;
  maintenanceMemo: Record<string, string>;
  setFilter: <K extends keyof DeviceFilters>(key: K, value: DeviceFilters[K]) => void;
  patchFilters: (patch: Partial<DeviceFilters>) => void;
  resetFilters: () => void;
  toggleSort: (field: DeviceSortField) => void;
  saveView: (name: string) => SavedDeviceView | null;
  removeView: (id: string) => void;
  applyView: (id: string) => void;
  toggleColumn: (key: DeviceColumnKey) => void;
  rememberMaintenance: (deviceId: string, previousStatus: string) => void;
  recallMaintenance: (deviceId: string) => string | null;
}

function filtersEqual(a: DeviceFilters, b: DeviceFilters): boolean {
  return (
    a.q === b.q &&
    a.status === b.status &&
    a.vendorId === b.vendorId &&
    a.siteId === b.siteId &&
    a.criticality === b.criticality &&
    a.backupCompliance === b.backupCompliance &&
    a.sort === b.sort &&
    a.dir === b.dir
  );
}

function makeId(): string {
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const useDeviceViewsStore = create<DeviceViewsState>()(
  persist(
    (set, get) => ({
      filters: DEFAULT_DEVICE_FILTERS,
      savedViews: [],
      columns: DEFAULT_COLUMNS,
      maintenanceMemo: {},

      setFilter: (key, value) =>
        set((state) => ({ filters: { ...state.filters, [key]: value } })),

      patchFilters: (patch) =>
        set((state) => ({ filters: { ...state.filters, ...patch } })),

      resetFilters: () => set({ filters: DEFAULT_DEVICE_FILTERS }),

      toggleSort: (field) =>
        set((state) => {
          const { sort, dir } = state.filters;
          if (sort === field) {
            return { filters: { ...state.filters, dir: dir === "asc" ? "desc" : "asc" } };
          }
          return { filters: { ...state.filters, sort: field, dir: "asc" } };
        }),

      saveView: (name) => {
        const trimmed = name.trim();
        if (!trimmed) return null;
        const view: SavedDeviceView = {
          id: makeId(),
          name: trimmed.slice(0, 40),
          filters: { ...get().filters },
          createdAt: new Date().toISOString(),
        };
        set((state) => ({ savedViews: [view, ...state.savedViews].slice(0, 12) }));
        return view;
      },

      removeView: (id) =>
        set((state) => ({
          savedViews: state.savedViews.filter((view) => view.id !== id),
        })),

      applyView: (id) => {
        const view = get().savedViews.find((entry) => entry.id === id);
        if (view) {
          set({ filters: { ...view.filters } });
        }
      },

      toggleColumn: (key) =>
        set((state) => ({
          columns: { ...state.columns, [key]: !state.columns[key] },
        })),

      rememberMaintenance: (deviceId, previousStatus) =>
        set((state) => ({
          maintenanceMemo: { ...state.maintenanceMemo, [deviceId]: previousStatus },
        })),

      recallMaintenance: (deviceId) => get().maintenanceMemo[deviceId] ?? null,
    }),
    {
      name: "fayanms-device-views",
      // Rehydrates synchronously on the client when this module first loads.
      // Views render only after the app shell mounts, so the rehydrated
      // state is always in place before the DataTable reads it.
    }
  )
);

/** True when the current filters differ from the defaults. */
export function hasActiveFilters(filters: DeviceFilters): boolean {
  return !filtersEqual(filters, DEFAULT_DEVICE_FILTERS);
}

/** True when two saved views / a saved view and the current filters match. */
export function filtersMatch(a: DeviceFilters, b: DeviceFilters): boolean {
  return filtersEqual(a, b);
}
