"use client";

import { SessionProvider } from "next-auth/react";

import type { ReactNode } from "react";

/**
 * next-auth SessionProvider (Task 7-a) — client context for useSession().
 * Window-focus refetch is disabled: the app polls its own /api/v1/auth/session
 * permission bootstrap separately, and duplicate session churn causes
 * unnecessary JWT-callback DB lookups.
 */
export function AuthSessionProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      {children}
    </SessionProvider>
  );
}
