"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  Activity,
  BellRing,
  CheckCircle2,
  DatabaseBackup,
  LoaderCircle,
  Maximize,
  Minimize,
  Siren,
} from "lucide-react";

import { useDashboard } from "@/hooks/api/use-dashboard";
import { useAlerts } from "@/hooks/api/use-alerts";
import { useIncidents, useIncidentStats } from "@/hooks/api/use-incidents";
import { useJobs } from "@/hooks/api/use-jobs";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { SlaChip } from "@/components/domain/sla-chip";
import { useNavigationStore } from "@/stores/navigation";

/**
 * NOC wall-board (Task 5-b, view key ops.noc): dense operations wallboard.
 * Left column: open incidents (SEV1/SEV2 first, SLA countdown chips, pulsing
 * SEV1 dot). Right: fleet health summary — devices by status, active alerts
 * by severity, jobs running/failed today, backup compliance. A compact clock
 * ticks every second (client-only render — mounted gate avoids hydration
 * mismatch). The header's fullscreen button drives the browser Fullscreen API
 * on the wallboard container with an exit affordance; data auto-refreshes
 * every 10 s.
 */

const DEVICE_STATUS_ORDER = ["ONLINE", "DEGRADED", "MAINTENANCE", "OFFLINE", "UNKNOWN", "UNMANAGED"];
const DEVICE_STATUS_COLORS: Record<string, string> = {
  ONLINE: "bg-success",
  DEGRADED: "bg-warning",
  MAINTENANCE: "bg-info",
  OFFLINE: "bg-danger",
  UNKNOWN: "bg-neutral",
  UNMANAGED: "bg-neutral",
};
const SEVERITY_DOT: Record<string, string> = {
  CRITICAL: "bg-danger",
  HIGH: "bg-danger-orange",
  MEDIUM: "bg-warning",
  LOW: "bg-info",
  INFO: "bg-neutral",
};

function severityWeight(severity: string): number {
  switch (severity) {
    case "SEV1":
      return 0;
    case "SEV2":
      return 1;
    case "SEV3":
      return 2;
    case "SEV4":
      return 3;
    default:
      return 4;
  }
}

/** 1-second tick store — client-only clock without setState-in-effect. */
const wallClockSubscribers = new Set<() => void>();
let wallClockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeWallClock(onChange: () => void): () => void {
  wallClockSubscribers.add(onChange);
  if (!wallClockTimer) {
    wallClockTimer = setInterval(() => {
      for (const notify of wallClockSubscribers) notify();
    }, 1000);
  }
  return () => {
    wallClockSubscribers.delete(onChange);
    if (wallClockSubscribers.size === 0 && wallClockTimer) {
      clearInterval(wallClockTimer);
      wallClockTimer = null;
    }
  };
}

function getWallClockSnapshot(): number {
  return Math.floor(Date.now() / 1000);
}

function WallClock() {
  // useSyncExternalStore: server snapshot is a stable placeholder, the client
  // re-renders once per second after mount — no hydration mismatch.
  const seconds = useSyncExternalStore(
    subscribeWallClock,
    getWallClockSnapshot,
    () => 0
  );
  if (seconds === 0) {
    return <span className="font-tech tabular-nums">--:--:--</span>;
  }
  const now = new Date(seconds * 1000);
  return (
    <span className="font-tech text-xl tabular-nums leading-none ltr-technical">
      {now.toLocaleTimeString("en-GB", { hour12: false })}
    </span>
  );
}

export function NocView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const dashboard = useDashboard("24h");
  const incidents = useIncidents({ pageSize: 50, status: "NEW,ACKNOWLEDGED,ASSIGNED,INVESTIGATING,MITIGATING,MONITORING,POST_INCIDENT_REVIEW" });
  const stats = useIncidentStats({ refetchInterval: 10_000 });
  const alerts = useAlerts({ pageSize: 8, status: "ACTIVE,ACKNOWLEDGED", sort: "severity" });
  const jobs = useJobs({ pageSize: 1 }, { refetchInterval: 10_000 });

  const queryClient = useQueryClient();

  // 10 s master refresh for the wallboard (stats/alerts/jobs poll their own
  // intervals; this revalidates the incident list + dashboard aggregates).
  useEffect(() => {
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ["incidents"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    }, 10_000);
    return () => clearInterval(timer);
  }, [queryClient]);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (containerRef.current) {
        await containerRef.current.requestFullscreen();
      }
    } catch {
      // Fullscreen can be denied (e.g. iframe without allow) — non-fatal.
    }
  };

  const openIncidents = incidents.data?.data ?? [];
  const sortedIncidents = [...openIncidents].sort(
    (a, b) =>
      severityWeight(a.severity) - severityWeight(b.severity) ||
      new Date(a.slaDueAt ?? a.createdAt).getTime() - new Date(b.slaDueAt ?? b.createdAt).getTime()
  );

  const kpis = dashboard.data?.kpis;
  const health = dashboard.data?.healthDistribution ?? [];
  const alertRows = alerts.data?.data ?? [];
  const jobsMeta = jobs.data?.meta as unknown as { total?: number } | undefined;

  const alertsBySeverity = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((severity) => ({
    severity,
    count: alertRows.filter((alert) => alert.severity === severity).length,
  }));

  return (
    <div
      className={cn(
        "flex min-h-[calc(100vh-8rem)] flex-col gap-3 rounded-xl border bg-neutral-950 p-3 text-neutral-100 dark:bg-black",
        isFullscreen && "min-h-screen"
      )}
      data-noc-board
      ref={containerRef}
    >
      {/* Header: title + clock + fullscreen */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-neutral-800 pb-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.2em] text-neutral-300">
            <Siren aria-hidden className="size-4 text-danger" />
            NOC — Operations Wallboard
          </h1>
          {stats.data && stats.data.breachedCount > 0 && (
            <span className="animate-pulse rounded-full bg-danger px-2 py-0.5 text-xs font-bold text-white">
              {stats.data.breachedCount} SLA BREACHED
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <WallClock />
          <Button
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            className="border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800 hover:text-white"
            onClick={() => void toggleFullscreen()}
            size="sm"
            variant="outline"
          >
            {isFullscreen ? (
              <Minimize aria-hidden className="size-4" />
            ) : (
              <Maximize aria-hidden className="size-4" />
            )}
            {isFullscreen ? "Exit" : "Fullscreen"}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[1.5fr_1fr]">
        {/* Left: active incidents */}
        <section aria-label="Active incidents" className="flex min-h-0 flex-col">
          <h2 className="flex items-center gap-2 pb-1 text-xs font-semibold uppercase tracking-wider text-neutral-400">
            <Activity aria-hidden className="size-3.5" />
            Active incidents
            <span className="text-neutral-500">
              — {stats.data?.openCount ?? openIncidents.length} open
              {stats.data ? ` · MTTA ${stats.data.mttaMinutes ?? "—"}m · MTTR ${stats.data.mttrMinutes ?? "—"}m` : ""}
            </span>
          </h2>
          <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
            {sortedIncidents.length === 0 ? (
              <li className="flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-sm text-neutral-400">
                <CheckCircle2 aria-hidden className="size-4 text-success" />
                No open incidents — all clear.
              </li>
            ) : (
              sortedIncidents.map((incident) => (
                <li key={incident.id}>
                  <button
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg border p-3 text-start transition-colors",
                      incident.severity === "SEV1"
                        ? "border-danger/40 bg-danger/10 hover:bg-danger/15"
                        : "border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900"
                    )}
                    onClick={() => setActiveView("ops.incident-detail", { incidentId: incident.id })}
                    type="button"
                  >
                    <span
                      className={cn(
                        "relative size-2.5 shrink-0 rounded-full",
                        SEVERITY_DOT[
                          incident.severity === "SEV1"
                            ? "CRITICAL"
                            : incident.severity === "SEV2"
                              ? "HIGH"
                              : incident.severity === "SEV3"
                                ? "MEDIUM"
                                : "LOW"
                        ] ?? "bg-neutral"
                      )}
                    >
                      {incident.severity === "SEV1" && (
                        <span className="absolute size-2.5 animate-ping rounded-full bg-danger opacity-75" />
                      )}
                    </span>
                    <span className="font-tech shrink-0 text-xs text-neutral-400 ltr-technical">
                      {incident.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm" title={incident.title}>
                      {incident.title}
                    </span>
                    {incident.site && (
                      <span className="hidden shrink-0 text-xs text-neutral-500 sm:inline">
                        {incident.site.code}
                      </span>
                    )}
                    <SlaChip className="dark:opacity-90" sla={incident.sla} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>

        {/* Right: fleet health summary */}
        <section aria-label="Fleet health" className="grid min-h-0 grid-cols-1 content-start gap-3">
          {/* Devices by status */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
            <h2 className="pb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              Devices by status — {kpis ? `${kpis.online}/${kpis.managedDevices} online` : "…"}
            </h2>
            <div className="flex flex-wrap gap-2">
              {DEVICE_STATUS_ORDER.map((status) => {
                const slice = health.find((entry) => entry.status === status);
                const count = slice?.count ?? 0;
                if (count === 0 && !["ONLINE", "OFFLINE", "DEGRADED"].includes(status)) return null;
                return (
                  <span
                    className="flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-950 px-2.5 py-1 text-xs"
                    key={status}
                  >
                    <span className={cn("size-2 rounded-full", DEVICE_STATUS_COLORS[status] ?? "bg-neutral")} />
                    <span className="font-tech tabular-nums">{count}</span>
                    <span className="text-neutral-400">{status.toLowerCase()}</span>
                  </span>
                );
              })}
            </div>
          </div>

          {/* Active alerts by severity */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
            <h2 className="flex items-center gap-2 pb-2 text-xs font-semibold uppercase tracking-wider text-neutral-400">
              <BellRing aria-hidden className="size-3.5" />
              Active alerts — top {alertRows.length}
            </h2>
            <div className="flex flex-wrap gap-2">
              {alertsBySeverity.map((entry) => (
                <span
                  className="flex items-center gap-1.5 rounded-full border border-neutral-800 bg-neutral-950 px-2.5 py-1 text-xs"
                  key={entry.severity}
                >
                  <span className={cn("size-2 rounded-full", SEVERITY_DOT[entry.severity] ?? "bg-neutral")} />
                  <span className="font-tech tabular-nums">{entry.count}</span>
                  <span className="text-neutral-400">{entry.severity.toLowerCase()}</span>
                </span>
              ))}
            </div>
            <ul className="mt-2 max-h-40 overflow-y-auto">
              {alertRows.slice(0, 5).map((alert) => (
                <li className="flex items-center gap-2 border-t border-neutral-800/60 py-1.5 text-xs" key={alert.id}>
                  <span className={cn("size-1.5 shrink-0 rounded-full", SEVERITY_DOT[alert.severity] ?? "bg-neutral")} />
                  <span className="font-tech shrink-0 text-neutral-500 ltr-technical">{alert.device.hostname}</span>
                  <span className="min-w-0 flex-1 truncate text-neutral-300" title={alert.message}>
                    {alert.message}
                  </span>
                  <span className="shrink-0 text-neutral-500" title={new Date(alert.lastSeen).toISOString()}>
                    {formatDistanceToNow(new Date(alert.lastSeen), { addSuffix: true })}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* Jobs + backup compliance */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
              <h2 className="flex items-center gap-2 pb-1 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                <LoaderCircle aria-hidden className="size-3.5" />
                Jobs
              </h2>
              <p className="text-2xl font-semibold tabular-nums">{kpis?.activeJobs ?? "—"}</p>
              <p className="text-xs text-neutral-500">active in the queue</p>
              <div className="mt-2 flex items-center gap-2 text-xs text-neutral-400">
                <span className="rounded-full border border-neutral-800 bg-neutral-950 px-2 py-0.5">
                  total {jobsMeta?.total ?? "—"}
                </span>
              </div>
            </div>
            <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
              <h2 className="flex items-center gap-2 pb-1 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                <DatabaseBackup aria-hidden className="size-3.5" />
                Backup compliance
              </h2>
              <p className="text-2xl font-semibold tabular-nums">{kpis?.backupCompliancePct ?? "—"}%</p>
              <p className="text-xs text-neutral-500">fleet-wide · 24h window</p>
              {dashboard.data?.backupCompliance && (
                <div className="mt-2 flex gap-1 text-[11px] text-neutral-400">
                  <span className="text-success">{dashboard.data.backupCompliance.compliant} ok</span>
                  <span>·</span>
                  <span className="text-warning">{dashboard.data.backupCompliance.overdue} late</span>
                  <span>·</span>
                  <span className="text-danger">
                    {dashboard.data.backupCompliance.failed + dashboard.data.backupCompliance.never} bad
                  </span>
                </div>
              )}
            </div>
          </div>

          <p className="pb-1 text-center text-[11px] text-neutral-600">
            Auto-refresh 10 s · clock local time · click an incident to open its record ·
            exit fullscreen with the button or Esc
          </p>
        </section>
      </div>
    </div>
  );
}
