"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useSession } from "next-auth/react";

import { useDashboard } from "@/hooks/api/use-dashboard";
import { fetchAuthSession } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { usePermissionsStore } from "@/stores/permissions";
import { useLocaleInfo } from "@/i18n/locale-provider";
import { FayaNMSLockup, FayaNMSMark } from "@/components/brand";
import { SignInGate } from "@/components/auth/sign-in-gate";
import { SkipLink } from "@/components/domain/skip-link";
import { ViewErrorBoundary } from "@/components/domain/view-error-boundary";
import { GuidedTour } from "@/components/tour/guided-tour";
import { AppFooter } from "./app-footer";
import { AppHeader } from "./app-header";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette } from "./command-palette";
import { JobCenterSheet } from "./job-center";
import { SidebarNav, type SidebarCounts } from "./sidebar-nav";
import { ViewRouter } from "./view-router";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useNavigationStore } from "@/stores/navigation";
import { usePreferencesStore } from "@/stores/preferences";

const ZERO_COUNTS: SidebarCounts = { alerts: 0, approvals: 0, jobs: 0 };

const emptySubscribe = () => () => {};
/** Hydration-safe "client is ready" flag (no setState-in-effect needed). */
const useMounted = () =>
  useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

/**
 * Application shell: skip link, sidebar (desktop) / drawer (mobile),
 * sticky header, routed main region and the sticky status footer.
 *
 * Persisted UI state (navigation, preferences) rehydrates after mount so
 * the server-rendered HTML and the first client render always match.
 */
export function AppShell() {
  const mounted = useMounted();
  const { status } = useSession();
  const { isRtl } = useLocaleInfo();
  const tA11y = useTranslations("a11y");

  // Permission bootstrap (Task 7-a): /api/v1/auth/session is the SERVER
  // permission source of truth — hydrate the zustand store once the client
  // session is authenticated (and clear it on sign-out).
  const sessionQuery = useQuery({
    queryKey: queryKeys.authSession(),
    queryFn: fetchAuthSession,
    enabled: status === "authenticated",
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (status === "authenticated" && sessionQuery.data) {
      usePermissionsStore.getState().hydrate(sessionQuery.data);
    } else if (status === "unauthenticated") {
      usePermissionsStore.getState().reset();
    }
  }, [status, sessionQuery.data]);

  const density = usePreferencesStore((state) => state.density);
  const sidebarCollapsed = usePreferencesStore(
    (state) => state.sidebarCollapsed
  );
  const toggleSidebar = usePreferencesStore((state) => state.toggleSidebar);

  const activeView = useNavigationStore((state) => state.activeView);
  const mainRef = useRef<HTMLElement | null>(null);

  const [commandOpen, setCommandOpen] = useState(false);
  const [jobCenterOpen, setJobCenterOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Rehydrate persisted stores once the client is active (hydration-safe).
  useEffect(() => {
    usePreferencesStore.persist.rehydrate();
    void useNavigationStore.persist.rehydrate();
  }, []);

  // Activate the CSS density tier on the document root.
  useEffect(() => {
    if (!mounted) return;
    document.documentElement.dataset.density = density;
  }, [density, mounted]);

  // New view → back to the top of the page.
  useEffect(() => {
    if (!mounted) return;
    window.scrollTo({ top: 0 });
  }, [activeView, mounted]);

  const dashboard = useDashboard("24h");
  const kpis = dashboard.data?.kpis;
  const counts: SidebarCounts = kpis
    ? {
        alerts: kpis.activeAlerts,
        approvals: kpis.pendingApprovals,
        jobs: kpis.activeJobs,
      }
    : ZERO_COUNTS;

  // Gate order (Task 7-a): hydration → session status → permission
  // bootstrap. While any is pending, keep the loading screen; with no
  // session at all, replace the whole shell with the sign-in gate.
  const permissionsReady = sessionQuery.isSuccess || sessionQuery.isError;
  if (!mounted || status === "loading" || (status === "authenticated" && !permissionsReady)) {
    return (
      <div
        aria-busy="true"
        aria-label={tA11y("loadingApp")}
        className="flex min-h-screen flex-col bg-background"
      >
        <div className="h-14 border-b" />
        <main className="flex flex-1 items-center justify-center">
          <span className="flex flex-col items-center gap-3 text-muted-foreground">
            {/* Re-audit B0-001: the canonical FayaNMS mark (brand tone) —
                never a generic/pseudo-brand glyph on the loading surface. */}
            <span className="flex size-12 animate-pulse items-center justify-center rounded-xl bg-primary/10">
              <FayaNMSMark size="lg" tone="brand" />
            </span>
            <span className="text-sm">{tA11y("loadingApp")}…</span>
          </span>
        </main>
        <div className="h-10 border-t" />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <SignInGate />;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SkipLink label={tA11y("skipToContent")} />

      <div className="flex flex-1 items-stretch">
        <AppSidebar
          collapsed={sidebarCollapsed}
          counts={counts}
          onToggleCollapsed={toggleSidebar}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <AppHeader
            collapsed={sidebarCollapsed}
            counts={counts}
            criticalAlerts={kpis?.criticalAlerts ?? 0}
            onOpenCommandPalette={() => setCommandOpen(true)}
            onOpenJobCenter={() => setJobCenterOpen(true)}
            onOpenMobileNav={() => setMobileNavOpen(true)}
            onToggleSidebar={toggleSidebar}
          />

          <main
            className="flex-1 px-4 py-5 outline-none md:px-6 md:py-6 lg:px-8"
            id="main-content"
            ref={mainRef}
            tabIndex={-1}
          >
            <div className="mx-auto w-full max-w-[1600px]">
              {/* View-level boundary (RT-004 / F-004): a crashing view degrades
                  to ErrorState while the shell stays alive. Keyed by activeView
                  so navigation remounts a fresh boundary (reset-on-nav). */}
              <ViewErrorBoundary key={activeView}>
                <ViewRouter />
              </ViewErrorBoundary>
            </div>
          </main>
        </div>
      </div>

      <AppFooter lastRefreshAt={dashboard.dataUpdatedAt ?? null} />

      {/* Mobile navigation drawer — side flips with the reading direction. */}
      <Sheet onOpenChange={setMobileNavOpen} open={mobileNavOpen}>
        {/* No SheetDescription exists by design — Radix's own remedy for the
            aria-describedby warning (10-b sweep; sheet registers no
            DescriptionWarning provider, hence the DialogContent warning name). */}
        <SheetContent
          aria-describedby={undefined}
          className="flex flex-col gap-0 p-0"
          side={isRtl ? "right" : "left"}
        >
          <SheetHeader className="border-b">
            {/* Re-audit B0-001/B1-003: canonical tiled lockup — the only
                sanctioned identity composition (no Waypoints, no literal
                hand-assembled name). */}
            <SheetTitle>
              <FayaNMSLockup variant="tiled" />
            </SheetTitle>
          </SheetHeader>
          <SidebarNav
            className="py-2"
            collapsed={false}
            counts={counts}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <CommandPalette
        onOpenChange={setCommandOpen}
        onOpenJobCenter={() => setJobCenterOpen(true)}
        open={commandOpen}
      />
      <JobCenterSheet onOpenChange={setJobCenterOpen} open={jobCenterOpen} />

      {/* Guided demo tour (Phase 9-b): spotlight overlay + dashboard hint. */}
      <GuidedTour />
    </div>
  );
}
