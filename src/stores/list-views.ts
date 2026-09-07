import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Generic saved-views store (Phase 9-b) — the devices saved-views pattern
 * (src/stores/device-views.ts) generalized to every list surface.
 *
 * One zustand store, persisted to a single localStorage key
 * ("fayanms-list-views") with a per-surface slice, built by one factory
 * consumed twice:
 *   - alerts → useAlertsSavedViews()
 *   - events → useEventsSavedViews()
 *
 * A saved view snapshots the surface's CURRENT filter state
 * ({ id, name, filters, createdAt }); the live filter state itself stays
 * in the view components (unlike devices, whose persisted live filters
 * double as the detail-view back-navigation memo). Surfaces render their
 * views as removable FilterChips and restore the full filter set on click.
 */

export interface SavedListView<Filters> {
  id: string;
  name: string;
  filters: Filters;
  createdAt: string;
}

/** Exact filter state of Operations → Alerts (alerts-view.tsx). */
export interface AlertViewFilters {
  status: string;
  severity: string;
  ruleId: string;
  siteCode: string;
  /** Applied (debounced) search term. */
  q: string;
  sort: "lastSeen" | "severity";
}

/** Exact filter state of Operations → Event Stream (events-view.tsx). */
export interface EventViewFilters {
  actor: string;
  action: string;
  entityType: string;
  timeRange: string;
  correlationId: string;
}

const MAX_VIEWS_PER_SURFACE = 12;
const MAX_NAME_LENGTH = 40;

function makeId(): string {
  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Factory consumed once per surface: derives the saved-view record from a
 * name + the current filter snapshot (trimmed/validated), leaving slice
 * placement to the store body.
 */
function createSurfaceActions<Filters>(surface: "alerts" | "events") {
  return {
    sliceKey: surface,
    makeView: (name: string, filters: Filters): SavedListView<Filters> | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;
      return {
        id: makeId(),
        name: trimmed.slice(0, MAX_NAME_LENGTH),
        filters: { ...filters },
        createdAt: new Date().toISOString(),
      };
    },
  };
}

const alertsSurface = createSurfaceActions<AlertViewFilters>("alerts");
const eventsSurface = createSurfaceActions<EventViewFilters>("events");

interface ListViewsState {
  alerts: SavedListView<AlertViewFilters>[];
  events: SavedListView<EventViewFilters>[];

  saveAlertsView: (
    name: string,
    filters: AlertViewFilters
  ) => SavedListView<AlertViewFilters> | null;
  removeAlertsView: (id: string) => void;

  saveEventsView: (
    name: string,
    filters: EventViewFilters
  ) => SavedListView<EventViewFilters> | null;
  removeEventsView: (id: string) => void;
}

export const useListViewsStore = create<ListViewsState>()(
  persist(
    (set) => ({
      alerts: [],
      events: [],

      saveAlertsView: (name, filters) => {
        const view = alertsSurface.makeView(name, filters);
        if (!view) return null;
        set((state) => ({
          alerts: [view, ...state.alerts].slice(0, MAX_VIEWS_PER_SURFACE),
        }));
        return view;
      },
      removeAlertsView: (id) =>
        set((state) => ({
          alerts: state.alerts.filter((entry) => entry.id !== id),
        })),

      saveEventsView: (name, filters) => {
        const view = eventsSurface.makeView(name, filters);
        if (!view) return null;
        set((state) => ({
          events: [view, ...state.events].slice(0, MAX_VIEWS_PER_SURFACE),
        }));
        return view;
      },
      removeEventsView: (id) =>
        set((state) => ({
          events: state.events.filter((entry) => entry.id !== id),
        })),
    }),
    {
      name: "fayanms-list-views",
      // Rehydrates synchronously on the client when this module first loads;
      // views render only after the app shell mounts, so the saved list is
      // in place before the first render reads it.
    }
  )
);

/** Saved-views API for Operations → Alerts. */
export function useAlertsSavedViews() {
  const savedViews = useListViewsStore((state) => state.alerts);
  const saveView = useListViewsStore((state) => state.saveAlertsView);
  const removeView = useListViewsStore((state) => state.removeAlertsView);
  return { savedViews, saveView, removeView };
}

/** Saved-views API for Operations → Event Stream. */
export function useEventsSavedViews() {
  const savedViews = useListViewsStore((state) => state.events);
  const saveView = useListViewsStore((state) => state.saveEventsView);
  const removeView = useListViewsStore((state) => state.removeEventsView);
  return { savedViews, saveView, removeView };
}
