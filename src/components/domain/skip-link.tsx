import { cn } from "@/lib/utils";

/**
 * Skip link (Phase 8-b, WCAG 2.4.1 Bypass Blocks).
 *
 * Visually hidden until it receives keyboard focus, then pinned to the top
 * edge as the first focusable element of the page. Point it at the main
 * region: `<main id="main-content">` in app-shell.
 *
 * MOUNT NOTE (for the orchestrator): `src/components/shell/app-shell.tsx`
 * is Phase 8-a/orchestrator-owned, so this component ships unmounted. It is
 * a drop-in replacement for the inline skip anchor already present there —
 * render `<SkipLink />` as the FIRST child inside the shell's root
 * `<div className="flex min-h-screen ...">` and keep
 * `<main id="main-content">`. Server component — no "use client" needed.
 */
export function SkipLink({
  className,
  label = "Skip to main content",
}: {
  className?: string;
  /** Localized label (a11y.skipToContent) — English default. */
  label?: string;
}) {
  return (
    <a
      className={cn(
        "sr-only",
        // Reveal on keyboard focus: fixed to the top-left flow edge so it is
        // the first thing a keyboard user encounters in both LTR and RTL.
        "focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-[60]",
        "focus:rounded-md focus:bg-primary focus:px-3 focus:py-2",
        "focus:text-sm focus:font-medium focus:text-primary-foreground",
        "focus:shadow-e3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        className
      )}
      href="#main-content"
    >
      {label}
    </a>
  );
}
