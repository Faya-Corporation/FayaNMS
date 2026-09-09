import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { Locale } from "@/i18n/locale";

export type Density = "comfortable" | "compact" | "dense";

interface PreferencesState {
  /** Active density tier; apply as <html data-density="..."> (see globals.css). */
  density: Density;
  sidebarCollapsed: boolean;
  /**
   * UI language (Task 8-a): "en" | "ar". Drives next-intl messages and the
   * document direction (RTL for Arabic) via the LocaleProvider. Persist-
   * compatible: stored objects from before 8-a lack `locale` and shallow-
   * merge over this default, so they fall back to "en".
   */
  locale: Locale;
  /**
   * Guided tour (Phase 9-b): tourCompleted persists the one-time dismissal
   * (set when the tour is started, finished or its dashboard hint is
   * dismissed); tourActive is RUNTIME ONLY (excluded from persistence via
   * partialize) so a reload mid-tour never traps the overlay.
   */
  tourCompleted: boolean;
  tourActive: boolean;
  setDensity: (density: Density) => void;
  toggleSidebar: () => void;
  setLocale: (locale: Locale) => void;
  startTour: () => void;
  completeTour: () => void;
}

/**
 * App-level UI preferences, persisted to localStorage under "fayanms-prefs".
 * The app shell (Task 1-c) reads `density` and mirrors it onto the document
 * root so the CSS density system in globals.css activates.
 */
export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      density: "comfortable",
      sidebarCollapsed: false,
      locale: "en" satisfies Locale,
      tourCompleted: false,
      tourActive: false,
      setDensity: (density) => set({ density }),
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setLocale: (locale) => set({ locale }),
      startTour: () =>
        set({ tourActive: true, tourCompleted: true }),
      completeTour: () =>
        set({ tourActive: false, tourCompleted: true }),
    }),
    {
      name: "fayanms-prefs",
      partialize: (state) => ({
        density: state.density,
        sidebarCollapsed: state.sidebarCollapsed,
        locale: state.locale,
        tourCompleted: state.tourCompleted,
      }),
    }
  )
);
