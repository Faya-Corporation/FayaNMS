"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  BellOff,
  BellRing,
  CircleCheck,
  Gauge,
  RefreshCcw,
  Search,
  Siren,
} from "lucide-react";

import { useAlerts } from "@/hooks/api/use-alerts";
import { useAlertRules } from "@/hooks/api/use-alert-rules";
import { useMeta } from "@/hooks/api/use-meta";
import { useNotifications } from "@/hooks/api/use-notifications";
import { AssignAlertDialog, SuppressAlertDialog } from "@/components/alerts/alert-action-dialogs";
import { AlertRulesPanel } from "@/components/alerts/alert-rules-panel";
import { AlertStreamItem } from "@/components/alerts/alert-stream-item";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { AlertStreamRow } from "@/lib/api-client";
import { ALERT_STATUS_UI, lookupStatusConfig } from "./status-extras";

const STATUS_FILTERS = ["ALL", "ACTIVE", "ACKNOWLEDGED", "SUPPRESSED", "RESOLVED"] as const;
const SEVERITY_FILTERS = ["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

/**
 * Operations → Alerts (Task 5-a): live alert stream with the threshold
 * engine behind it (worker ALERT_EVALUATION → evaluate-in-Next), grouped
 * root/child rendering, ack/assign/suppress/resolve/create-incident
 * actions and a Rules management tab. Notifications stay a separate
 * surface (header center, §74) — never mixed into this stream.
 */
export function AlertsView() {
  const [status, setStatus] = useState<(typeof STATUS_FILTERS)[number]>("ALL");
  const [severity, setSeverity] = useState<(typeof SEVERITY_FILTERS)[number]>("ALL");
  const [ruleId, setRuleId] = useState("ALL");
  const [siteCode, setSiteCode] = useState("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"lastSeen" | "severity">("lastSeen");
  const [page, setPage] = useState(1);

  const [assignTarget, setAssignTarget] = useState<AlertStreamRow | null>(null);
  const [suppressTarget, setSuppressTarget] = useState<AlertStreamRow | null>(null);

  // Notifications cache stays warm so the header badge is instant when
  // the dropdown opens (the center itself lives in app-header).
  useNotifications({ refetchInterval: 15_000, limit: 30 });

  const rules = useAlertRules();
  const meta = useMeta();

  const params = useMemo(
    () => ({
      status: status === "ALL" ? undefined : status,
      severity: severity === "ALL" ? undefined : severity,
      ruleId: ruleId === "ALL" ? undefined : ruleId,
      siteCode: siteCode === "ALL" ? undefined : siteCode,
      q: q || undefined,
      sort,
      page,
      pageSize: 25,
    }),
    [status, severity, ruleId, siteCode, q, sort, page]
  );

  const alerts = useAlerts(params, {
    // Live stream: 5 s while something is firing, gentler when quiet.
    refetchInterval: (data) =>
      (data?.meta.counts.byStatus.ACTIVE ?? 0) > 0 ? 5_000 : 15_000,
  });

  const rows = alerts.data?.data ?? [];
  const counts = alerts.data?.meta.counts;
  const firing = counts?.byStatus.ACTIVE ?? 0;
  const acknowledged = counts?.byStatus.ACKNOWLEDGED ?? 0;
  const suppressed = counts?.byStatus.SUPPRESSED ?? 0;
  const linkedIncidents = alerts.data?.meta.linkedOpenIncidents ?? 0;
  const lastRefresh = alerts.dataUpdatedAt;

  // Debounced search (devices-view convention).
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const hasFilters =
    status !== "ALL" ||
    severity !== "ALL" ||
    ruleId !== "ALL" ||
    siteCode !== "ALL" ||
    q !== "" ||
    sort !== "lastSeen";

  const resetFilters = () => {
    setStatus("ALL");
    setSeverity("ALL");
    setRuleId("ALL");
    setSiteCode("ALL");
    setSearchInput("");
    setSort("lastSeen");
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Threshold engine, dedup and suppression — auto-refreshed stream"
        title="Alerts"
      />

      <Tabs defaultValue="stream">
        <TabsList aria-label="Alerts sections">
          <TabsTrigger value="stream">Alert stream</TabsTrigger>
          <TabsTrigger value="rules">Rules</TabsTrigger>
        </TabsList>

        <TabsContent className="mt-4 flex flex-col gap-4" value="stream">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              description="Open threshold breaches"
              icon={BellRing}
              label="Firing"
              loading={alerts.isLoading}
              status={firing > 0 ? { label: "live", pulse: true, token: "danger" } : { label: "quiet", token: "success" }}
              value={firing}
            />
            <KpiCard
              description="Seen by an operator"
              icon={CircleCheck}
              label="Acknowledged"
              loading={alerts.isLoading}
              value={acknowledged}
            />
            <KpiCard
              description="Windows + suppressed children"
              icon={BellOff}
              label="Suppressed"
              loading={alerts.isLoading}
              value={suppressed}
            />
            <KpiCard
              description="Incidents linked to open alerts"
              icon={Siren}
              label="Linked incidents"
              loading={alerts.isLoading}
              value={linkedIncidents}
            />
          </div>

          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            {STATUS_FILTERS.map((filter) => {
              const label =
                filter === "ALL"
                  ? "All"
                  : lookupStatusConfig(ALERT_STATUS_UI, filter).label;
              const count =
                filter === "ALL"
                  ? counts
                    ? Object.values(counts.byStatus).reduce((a, b) => a + b, 0)
                    : undefined
                  : counts?.byStatus[filter];
              return (
                <button
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                    status === filter
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                  key={filter}
                  onClick={() => {
                    setStatus(filter);
                    setPage(1);
                  }}
                  type="button"
                >
                  {label}
                  {count !== undefined && (
                    <span className="tabular-nums opacity-70">{count}</span>
                  )}
                </button>
              );
            })}

            <Select
              onValueChange={(value) => {
                setSeverity(value as (typeof SEVERITY_FILTERS)[number]);
                setPage(1);
              }}
              value={severity}
            >
              <SelectTrigger aria-label="Filter by severity" className="h-8 w-32 text-xs">
                <SelectValue placeholder="Severity" />
              </SelectTrigger>
              <SelectContent>
                {SEVERITY_FILTERS.map((filter) => (
                  <SelectItem key={filter} value={filter}>
                    {filter === "ALL"
                      ? "All severities"
                      : `${filter.charAt(0)}${filter.slice(1).toLowerCase()}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              onValueChange={(value) => {
                setRuleId(value);
                setPage(1);
              }}
              value={ruleId}
            >
              <SelectTrigger aria-label="Filter by rule" className="h-8 w-40 text-xs">
                <SelectValue placeholder="Rule" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All rules</SelectItem>
                {(rules.data ?? []).map((rule) => (
                  <SelectItem key={rule.id} value={rule.id}>
                    {rule.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              onValueChange={(value) => {
                setSiteCode(value);
                setPage(1);
              }}
              value={siteCode}
            >
              <SelectTrigger aria-label="Filter by site" className="hidden h-8 w-36 text-xs md:flex">
                <SelectValue placeholder="Site" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All sites</SelectItem>
                {(meta.data?.sites ?? []).map((site) => (
                  <SelectItem key={site.id} value={site.code}>
                    {site.code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="relative min-w-0 flex-1 sm:max-w-56">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                aria-label="Search alerts"
                className="h-8 ps-8 text-xs"
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search message or host…"
                value={searchInput}
              />
            </div>

            <Select
              onValueChange={(value) => setSort(value as "lastSeen" | "severity")}
              value={sort}
            >
              <SelectTrigger aria-label="Sort alerts" className="hidden h-8 w-36 text-xs sm:flex">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lastSeen">Last seen first</SelectItem>
                <SelectItem value="severity">Severity first</SelectItem>
              </SelectContent>
            </Select>

            <Button
              aria-label="Reset filters"
              disabled={!hasFilters}
              onClick={resetFilters}
              size="sm"
              variant="ghost"
            >
              <RefreshCcw aria-hidden="true" />
              Reset
            </Button>
          </div>

          {/* Stream */}
          <SectionCard
            contentClassName="p-0"
            description={
              alerts.dataUpdatedAt
                ? `Auto-refreshes while alerts fire · updated ${formatDistanceToNow(new Date(lastRefresh), { addSuffix: true })}`
                : "Auto-refreshes while alerts fire"
            }
            title="Alert Stream"
          >
            {alerts.isError ? (
              <div className="p-4">
                <ErrorState
                  onRetry={() => void alerts.refetch()}
                  reason={alerts.error.message}
                  title="Alerts could not be loaded"
                />
              </div>
            ) : alerts.isLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
                ))}
              </div>
            ) : rows.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  description="Nothing matches the current filters — the network is quiet."
                  icon={CircleCheck}
                  title="No alerts to show"
                />
              </div>
            ) : (
              <ul className="max-h-[70vh] overflow-y-auto">
                {rows.map((alert) => (
                  <AlertStreamItem
                    alert={alert}
                    key={alert.id}
                    onAssign={setAssignTarget}
                    onSuppress={setSuppressTarget}
                  />
                ))}
              </ul>
            )}

            {alerts.data && alerts.data.meta.totalPages > 1 && (
              <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  Page {alerts.data.meta.page} of {alerts.data.meta.totalPages} ·{" "}
                  {alerts.data.meta.total} alerts
                </span>
                <div className="flex gap-1.5">
                  <Button
                    aria-label="Previous page"
                    disabled={alerts.data.meta.page <= 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                    size="sm"
                    variant="outline"
                  >
                    Prev
                  </Button>
                  <Button
                    aria-label="Next page"
                    disabled={alerts.data.meta.page >= alerts.data.meta.totalPages}
                    onClick={() => setPage((value) => value + 1)}
                    size="sm"
                    variant="outline"
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </SectionCard>
        </TabsContent>

        <TabsContent className="mt-4" value="rules">
          <AlertRulesPanel />
        </TabsContent>
      </Tabs>

      <AssignAlertDialog alert={assignTarget} onClose={() => setAssignTarget(null)} />
      <SuppressAlertDialog alert={suppressTarget} onClose={() => setSuppressTarget(null)} />

      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Gauge aria-hidden="true" className="size-3.5" />
        The evaluation engine runs in the worker every ~3 minutes: dedup by
        fingerprint, maintenance-window + root-alert suppression, auto-resolve
        and incident auto-creation.
      </p>
    </div>
  );
}
