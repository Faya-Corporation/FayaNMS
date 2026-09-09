"use client";

import { MotionConfig } from "framer-motion";

/**
 * Motion preferences provider (Phase 8-b, WCAG 2.3.3 Animation from
 * Interactions / 2.2 reduced-motion support).
 *
 * Wraps the app so every framer-motion animation respects the user's OS
 * "reduce motion" setting (`reducedMotion="user"` transforms transform/
 * layout animations into instant state changes while opacity fades are
 * preserved). Complements the CSS `prefers-reduced-motion` media block in
 * globals.css, which neutralizes CSS transitions/animations.
 *
 * MOUNT NOTE (for the orchestrator): `src/app/layout.tsx` and the existing
 * provider files are Phase 8-a/orchestrator-owned, so this provider ships
 * unmounted. Mount it INSIDE ThemeProvider (it does not depend on the
 * theme) and AROUND the app content, e.g. in layout.tsx:
 *
 *   <ThemeProvider ...>
 *     <MotionProvider>
 *       <AuthSessionProvider>
 *         <QueryProvider>...</QueryProvider>
 *       </AuthSessionProvider>
 *     </MotionProvider>
 *   </ThemeProvider>
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
