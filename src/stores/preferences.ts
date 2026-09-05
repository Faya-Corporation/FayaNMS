import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Density = "comfortable" | "compact" | "dense";

interface PreferencesState {
  /** Active density tier; apply as <html data-density="..."> (see globals.css). */
  density: Density;
  sidebarCollapsed: boolean;
  setDensity: (density: Density) => void;
  toggleSidebar: () => void;
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
      setDensity: (density) => set({ density }),
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
    }),
    {
      name: "fayanms-prefs",
    }
  )
);
