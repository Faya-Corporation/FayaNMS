import { create } from "zustand";

import type { AuthSessionPayload } from "@/lib/api-client";

/**
 * Permission store (Task 7-a).
 *
 * Hydrated from /api/v1/auth/session — the SERVER permission source of
 * truth (fresh DB user + parsed Role.permissionsJson), not merely the
 * next-auth JWT session. The app shell hydrates it once the client session
 * is authenticated; every view reads `canWrite` from here to hide/disable
 * mutation affordances (the API/middleware 403s remain the hard backstop).
 */

export interface PermissionsUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  createdAt: string;
}

interface PermissionsState {
  /** null until hydrated — views treat null as "unknown, stay passive". */
  user: PermissionsUser | null;
  role: string | null;
  permissions: string[];
  canWrite: boolean;
  hydrated: boolean;
  hydrate: (payload: AuthSessionPayload) => void;
  reset: () => void;
}

const INITIAL = {
  user: null,
  role: null,
  permissions: [] as string[],
  canWrite: false,
  hydrated: false,
};

export const usePermissionsStore = create<PermissionsState>((set) => ({
  ...INITIAL,
  hydrate: (payload) =>
    set({
      user: payload.user,
      role: payload.role.name,
      permissions: payload.permissions,
      canWrite: payload.canWrite,
      hydrated: true,
    }),
  reset: () => set({ ...INITIAL }),
}));

/** Convenience selector: current user id (for self-guards in tables). */
export const useCurrentUserId = () =>
  usePermissionsStore((state) => state.user?.id ?? null);

/** Convenience selector: write gate (auditors + disabled accounts = false). */
export const useCanWrite = () => usePermissionsStore((state) => state.canWrite);
