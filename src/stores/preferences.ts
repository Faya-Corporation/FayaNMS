import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Density = "comfortable" | "compact" | "dense";

interface PreferencesState {
  /** Active density tier; apply as <html data-density="..."> (see globals.css). */
  density: Density;
  sidebarCollapsed: boolean;
  /**
   * Acting-user identity for the demo (no auth server yet — Task 7).
   * Stores the USERNAME-style key of the seeded account ("admin", "noc1",
   * "engineer1", "auditor1", "manager1"); GET /api/v1/meta exposes the
   * matching user rows (id/name/roleLabel) so UI resolves id + display name.
   * The value is sent as `actAsUserId` on approval/execution mutations and
   * the server resolves it (id first, then email local-part).
   */
  actAsUserId: string;
  setDensity: (density: Density) => void;
  toggleSidebar: () => void;
  setActAsUserId: (userId: string) => void;
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
      actAsUserId: "admin",
      setDensity: (density) => set({ density }),
      toggleSidebar: () =>
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setActAsUserId: (actAsUserId) => set({ actAsUserId }),
    }),
    {
      name: "fayanms-prefs",
    }
  )
);

/** Seeded username keys the act-as identity supports (prisma/seed.ts USERS). */
export const ACT_AS_USER_KEYS = [
  "admin",
  "noc1",
  "engineer1",
  "auditor1",
  "manager1",
] as const;
