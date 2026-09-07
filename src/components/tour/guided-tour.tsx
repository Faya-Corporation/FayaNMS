"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { CircleHelp, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useNavigationStore, type ViewKey } from "@/stores/navigation";
import { usePreferencesStore } from "@/stores/preferences";

/**
 * Guided demo tour (Phase 9-b) — dependency-free spotlight overlay.
 *
 * Steps target stable elements via data-tour="…" attributes; the tour
 * navigates between them through the client-side view router, computes the
 * target rect with getBoundingClientRect and re-measures on resize, scroll
 * (capture, so nested scroll containers count) and a light interval that
 * absorbs late data-layout shifts.
 *
 * The spotlight is an SVG cutout (mask, fill-rule evenodd) at z-60 that
 * blocks pointer events; the step popover — the only interactive surface —
 * lives outside it. Keyboard: Escape skips, Enter advances, Tab is trapped
 * in the popover (lightweight: focus moves to the popover on step change).
 *
 * Dismissal persists via the preferences store (tourCompleted); the
 * dashboard hint card below never auto-starts the overlay.
 */

interface TourStep {
  view: ViewKey;
  target: string;
}

const TOUR_STEPS: TourStep[] = [
  { view: "dashboard", target: "dashboard-kpis" },
  { view: "network.devices", target: "devices-toolbar" },
  { view: "config.backups", target: "backups-header" },
  { view: "config.drift", target: "drift-header" },
  { view: "changes.all", target: "changes-header" },
  { view: "ops.alerts", target: "alerts-header" },
  { view: "ops.events", target: "events-header" },
  { view: "perf.overview", target: "perf-charts" },
  { view: "admin.users", target: "admin-users-header" },
];

const SPOTLIGHT_PADDING = 6;
const POPOVER_WIDTH = 320;
const POPOVER_ESTIMATED_HEIGHT = 210;
const VIEWPORT_MARGIN = 12;

const emptySubscribe = () => () => {};
/** Hydration-safe "client is ready" flag (same pattern as app-shell). */
const useMounted = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function rectsDiffer(a: Rect | null, b: Rect): boolean {
  return (
    !a ||
    Math.abs(a.top - b.top) > 0.5 ||
    Math.abs(a.left - b.left) > 0.5 ||
    Math.abs(a.width - b.width) > 0.5 ||
    Math.abs(a.height - b.height) > 0.5
  );
}

/** Cutout rect for the spotlight (target + padding, clamped to viewport). */
function cutoutFor(rect: Rect, viewport: { width: number; height: number }) {
  const top = Math.max(VIEWPORT_MARGIN, rect.top - SPOTLIGHT_PADDING);
  const left = Math.max(VIEWPORT_MARGIN, rect.left - SPOTLIGHT_PADDING);
  const right = Math.min(
    viewport.width - VIEWPORT_MARGIN,
    rect.left + rect.width + SPOTLIGHT_PADDING
  );
  const bottom = Math.min(
    viewport.height - VIEWPORT_MARGIN,
    rect.top + rect.height + SPOTLIGHT_PADDING
  );
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function GuidedTour() {
  const t = useTranslations("tour");
  const active = usePreferencesStore((state) => state.tourActive);
  const tourCompleted = usePreferencesStore((state) => state.tourCompleted);
  const startTour = usePreferencesStore((state) => state.startTour);
  const completeTour = usePreferencesStore((state) => state.completeTour);
  const activeView = useNavigationStore((state) => state.activeView);
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [hintDismissed, setHintDismissed] = useState(false);
  const mounted = useMounted();
  const popoverRef = useRef<HTMLDivElement | null>(null);

  const step = TOUR_STEPS[stepIndex];
  const isLast = stepIndex === TOUR_STEPS.length - 1;

  /* ── navigation + measurement loop ─────────────────────────────── */

  useEffect(() => {
    if (!active || !step) return;

    // Jump the view router to the step's surface (no-op when already there).
    if (useNavigationStore.getState().activeView !== step.view) {
      setActiveView(step.view);
    }

    let frame = 0;
    let attempts = 0;
    let cancelled = false;

    const measure = () => {
      if (cancelled) return;
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        const box = el.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) {
          const next: Rect = {
            top: box.top,
            left: box.left,
            width: box.width,
            height: box.height,
          };
          setRect((current) => (rectsDiffer(current, next) ? next : current));
          return true;
        }
      }
      return false;
    };

    // Retry with rAF until the target mounts (view switch + data fetch),
    // then keep the rect fresh without a per-frame loop.
    const hunt = () => {
      if (cancelled) return;
      attempts += 1;
      if (measure() || attempts > 240) {
        return;
      }
      frame = requestAnimationFrame(hunt);
    };
    hunt();

    const refresh = () => void measure();
    const interval = window.setInterval(refresh, 350);
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearInterval(interval);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [active, step, setActiveView]);

  /* ── focus + keyboard ──────────────────────────────────────────── */

  useEffect(() => {
    if (active) {
      // Move focus into the dialog on open and on every step change.
      popoverRef.current?.focus();
    }
  }, [active, stepIndex]);

  const advance = useCallback(() => {
    if (isLast) {
      completeTour();
      // Wrap the demo story: land back on the operations home.
      setActiveView("dashboard");
    } else {
      setStepIndex((value) => Math.min(value + 1, TOUR_STEPS.length - 1));
    }
  }, [isLast, completeTour, setActiveView]);

  const goBack = useCallback(() => {
    setStepIndex((value) => Math.max(0, value - 1));
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      completeTour();
      return;
    }
    if (event.key === "Enter") {
      const target = event.target as HTMLElement;
      if (target.tagName === "BUTTON" || target.tagName === "A") return;
      event.preventDefault();
      advance();
      return;
    }
    if (event.key === "Tab") {
      // Lightweight focus trap within the popover.
      const focusables = popoverRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled])"
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  /* ── dashboard hint card (auto-offer, never auto-starts) ───────── */

  const showHint =
    mounted &&
    !active &&
    !tourCompleted &&
    !hintDismissed &&
    activeView === "dashboard";

  if (!active && !showHint) return null;

  /* ── spotlight geometry ────────────────────────────────────────── */

  const viewport = {
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  };
  const cutout = rect
    ? cutoutFor(rect, viewport)
    : {
        top: viewport.height / 2 - 120,
        left: viewport.width / 2 - 160,
        width: 320,
        height: 240,
      };

  // Popover below the target when it fits, otherwise above; clamped.
  const spaceBelow = viewport.height - (cutout.top + cutout.height);
  const placeBelow = spaceBelow >= POPOVER_ESTIMATED_HEIGHT;
  const popoverTop = placeBelow
    ? cutout.top + cutout.height + 10
    : Math.max(VIEWPORT_MARGIN, cutout.top - POPOVER_ESTIMATED_HEIGHT - 10);
  const popoverLeft = Math.min(
    Math.max(VIEWPORT_MARGIN, cutout.left),
    Math.max(VIEWPORT_MARGIN, viewport.width - POPOVER_WIDTH - VIEWPORT_MARGIN)
  );

  return (
    <>
      {active && (
        <>
          {/* Cutout spotlight — blocks all pointer interaction. */}
          <svg
            aria-hidden="true"
            className="pointer-events-auto fixed inset-0 z-[60] h-full w-full"
          >
            <defs>
              <mask id="fayanms-tour-mask">
                <rect fill="white" height="100%" width="100%" />
                <rect
                  fill="black"
                  height={cutout.height}
                  rx="12"
                  width={cutout.width}
                  x={cutout.left}
                  y={cutout.top}
                />
              </mask>
            </defs>
            <rect
              className="fill-black/55"
              height="100%"
              mask="url(#fayanms-tour-mask)"
              width="100%"
            />
            <rect
              fill="none"
              height={cutout.height}
              rx="12"
              stroke="var(--ring)"
              strokeDasharray="5 4"
              strokeWidth="2"
              width={cutout.width}
              x={cutout.left}
              y={cutout.top}
            />
          </svg>

          {/* Step popover — the only interactive surface of the overlay. */}
          <div
            aria-describedby="fayanms-tour-body"
            aria-label={t("title")}
            aria-modal="true"
            className="fixed z-[60] w-80 rounded-xl border bg-card p-4 shadow-e2 outline-none"
            onKeyDown={handleKeyDown}
            ref={popoverRef}
            role="dialog"
            style={{
              top: popoverTop,
              left: popoverLeft,
              maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
            }}
            tabIndex={-1}
          >
            <div className="flex items-center justify-between gap-2">
              <p
                className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                id="fayanms-tour-step"
              >
                {t("stepOf", {
                  current: stepIndex + 1,
                  total: TOUR_STEPS.length,
                })}
              </p>
              <Button
                aria-label={t("skip")}
                className="size-7"
                onClick={completeTour}
                size="icon"
                variant="ghost"
              >
                <X aria-hidden="true" className="size-4" />
              </Button>
            </div>
            <h2 className="mt-1 flex items-center gap-2 text-sm font-semibold">
              <Sparkles aria-hidden="true" className="size-4 text-primary" />
              <span id="fayanms-tour-title">{t(`step${stepIndex + 1}Title`)}</span>
            </h2>
            <p
              className="mt-1.5 text-sm text-muted-foreground"
              id="fayanms-tour-body"
            >
              {t(`step${stepIndex + 1}Body`)}
            </p>

            {/* Progress dots */}
            <div aria-hidden="true" className="mt-3 flex items-center gap-1.5">
              {TOUR_STEPS.map((_, index) => (
                <span
                  className={
                    index === stepIndex
                      ? "h-1.5 w-4 rounded-full bg-primary"
                      : index < stepIndex
                        ? "h-1.5 w-1.5 rounded-full bg-primary/40"
                        : "h-1.5 w-1.5 rounded-full bg-muted"
                  }
                  key={index}
                />
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between gap-2">
              <Button
                disabled={stepIndex === 0}
                onClick={goBack}
                size="sm"
                variant="outline"
              >
                {t("back")}
              </Button>
              <div className="flex items-center gap-2">
                <Button onClick={completeTour} size="sm" variant="ghost">
                  {t("skip")}
                </Button>
                <Button onClick={advance} size="sm">
                  {isLast ? t("finish") : t("next")}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {showHint && (
        <div
          aria-label={t("tourHintTitle")}
          className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] end-4 z-40 w-[min(19rem,calc(100vw-2rem))] rounded-xl border bg-card p-4 shadow-e2"
          role="complementary"
        >
          <div className="flex items-start gap-2.5">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
            >
              <CircleHelp className="size-4.5" />
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{t("tourHintTitle")}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t("tourHintBody")}
              </p>
            </div>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <Button
              onClick={() => {
                setHintDismissed(true);
                completeTour();
              }}
              size="sm"
              variant="ghost"
            >
              {t("dismiss")}
            </Button>
            <Button onClick={startTour} size="sm">
              {t("startTour")}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
