"use client";

import { useEffect, useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  GitPullRequest,
  Search,
  Siren,
  Timer,
  TimerReset,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { useIncidents, useIncidentStats } from "@/hooks/api/use-incidents";
import { useMeta } from "@/hooks/api/use-meta";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { SlaChip } from "@/components/domain/sla-chip";
import { StatusBadge } from "@/components/domain/status-badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { INCIDENT_SEVERITY, getStatusConfig } from "@/lib/domain/status";
import { INCIDENT_STATUS_UI, lookupStatusConfig } from "./status-extras";
import { IncidentSeverityBadge } from "./incident-severity-badge";
import { useNavigationStore } from "@/stores/navigation";

const SEVERITY_FILTERS = ["ALL", "SEV1", "SEV2", "SEV3", "SEV4"] as const;

/** Status groups (chips) mapped onto the lifecycle vocabulary. */
const STATUS_GROUPS: { key: string; label: string; statuses?: string[] }[] = [
  { key: "ALL", label: "All" },
  {
    key: "ACTIVE",
    label: "Active",
    statuses: [
      "NEW",
      "ACKNOWLEDGED",
      "ASSIGNED",
      "INVESTIGATING",
      "MITIGATING",
      "MONITORING",
    ],
  },
  { key: "RESOLVED", label: "Resolved", statuses: ["RESOLVED"] },
  { key: "POST_INCIDENT_REVIEW", label: "In review", statuses: ["POST_INCIDENT_REVIEW"] },
  { key: "CLOSED", label: "Closed", statuses: ["CLOSED"] },
];

function fmtMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return hours < 24 ? `${hours.toFixed(1)} h` : `${(hours / 24).toFixed(1)} d`;
}

/**
 * Incidents (Task 5-b): KPI row from /incidents/stats, grouped status chips,
 * severity/site filters + search, and list rows with SLA countdown chips.
 * Row click opens the full detail view (ops.incident-detail).
 */
export function IncidentsView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [statusGroup, setStatusGroup] = useState<string>("ALL");
  const [severity, setSeverity] = useState<string>("ALL");
  const [siteCode, setSiteCode] = useState<string>("ALL");
  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"createdAt" | "severity" | "slaDueAt">("createdAt");
  const [page, setPage] = useState(1);
  const [breachedOnly, setBreachedOnly] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const meta = useMeta();
  const sites = meta.data?.sites ?? [];

  const group = STATUS_GROUPS.find((entry) => entry.key === statusGroup);
  const params = {
    status: group?.statuses?.join(","),
    severity: severity === "ALL" ? undefined : severity,
    siteCode: siteCode === "ALL" ? undefined : siteCode,
    q: q || undefined,
    sort,
    breached: breachedOnly ? "1" : undefined,
    page,
    pageSize: 25,
  };

  const incidents = useIncidents(params);
  const stats = useIncidentStats();

  const rows = incidents.data?.data ?? [];
  const listMeta = incidents.data?.meta;
  const statsData = stats.data;

  const openBySeverity = useMemo(() => {
    const counts = statsData?.openBySeverity ?? {};
    return (["SEV1", "SEV2", "SEV3", "SEV4"] as const)
      .map((key) => {
        const label = getStatusConfig(INCIDENT_SEVERITY, key).label.split(" — ")[0];
        return `${label} ${counts[key] ?? 0}`;
      })
      .join(" · ");
  }, [statsData]);

  const resetFilters = () => {
    setStatusGroup("ALL");
    setSeverity("ALL");
    setSiteCode("ALL");
    setSearchInput("");
    setQ("");
    setSort("createdAt");
    setBreachedOnly(false);
    setPage(1);
  };

  const hasFilters =
    statusGroup !== "ALL" ||
    severity !== "ALL" ||
    siteCode !== "ALL" ||
    q !== "" ||
    breachedOnly ||
    sort !== "createdAt";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Incident lifecycle with SLA timers, timelines and post-incident reviews"
        title="Incidents"
      />

      {/* KPI row (stats endpoint) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          description={openBySeverity}
          icon={Siren}
          label="Open incidents"
          loading={stats.isLoading}
          status={{ label: "live", token: "info", pulse: true }}
          value={statsData?.openCount ?? "—"}
        />
        <KpiCard
          description={
            statsData ? `${statsData.breachedCount} past their SLA target` : undefined
          }
          icon={TimerReset}
          label="SLA breached"
          loading={stats.isLoading}
          value={statsData?.breachedCount ?? "—"}
        />
        <KpiCard
          description={`Mean time to acknowledge · ${statsData?.mttaSamples ?? 0} samples / ${statsData?.window.mttaMttrDays ?? 30}d`}
          icon={Timer}
          label="MTTA"
          loading={stats.isLoading}
          value={fmtMinutes(statsData?.mttaMinutes ?? null)}
        />
        <KpiCard
          description={`Mean time to resolve · ${statsData?.mttrSamples ?? 0} samples / ${statsData?.window.mttaMttrDays ?? 30}d`}
          icon={statsData && statsData.mttrMinutes !== null && statsData.mttrMinutes > 120 ? TrendingUp : TrendingDown}
          label="MTTR"
          loading={stats.isLoading}
          value={fmtMinutes(statsData?.mttrMinutes ?? null)}
        />
        <KpiCard
          description={
            statsData
              ? `${statsData.slaMetTotal}/${statsData.slaResolvedTotal} resolved within SLA / ${statsData.window.mttaMttrDays}d`
              : undefined
          }
          icon={Timer}
          label="SLA compliance"
          loading={stats.isLoading}
          value={statsData?.slaCompliancePct !== null && statsData ? `${statsData.slaCompliancePct}%` : "—"}
        />
      </div>

      {/* Status group chips */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_GROUPS.map((entry) => (
          <button
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
              statusGroup === entry.key
                ? "border-primary/30 bg-primary/10 text-primary-ink"
                : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
            key={entry.key}
            onClick={() => {
              setStatusGroup(entry.key);
              setPage(1);
            }}
            type="button"
          >
            {entry.label}
            {entry.key === "ACTIVE" && statsData ? ` · ${statsData.openCount}` : null}
          </button>
        ))}
        <button
          className={cn(
            "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
            breachedOnly
              ? "border-danger/30 bg-danger-subtle text-danger"
              : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
          onClick={() => {
            setBreachedOnly((value) => !value);
            setPage(1);
          }}
          type="button"
        >
          SLA breached
          {statsData?.breachedCount ? ` · ${statsData.breachedCount}` : ""}
        </button>
      </div>

      {/* Toolbar: severity, site, search, sort */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search incidents</span>
          <Search
            aria-hidden
            className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="w-full ps-8 sm:w-64"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search title or number…"
            value={searchInput}
          />
        </label>
        <Select
          onValueChange={(value) => {
            setSeverity(value);
            setPage(1);
          }}
          value={severity}
        >
          <SelectTrigger aria-label="Severity" className="w-[130px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Any severity</SelectItem>
            {(["SEV1", "SEV2", "SEV3", "SEV4"] as const).map((sev) => (
              <SelectItem key={sev} value={sev}>
                {sev}
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
          <SelectTrigger aria-label="Site" className="w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ALL">Any site</SelectItem>
            {sites.map((site) => (
              <SelectItem key={site.id} value={site.code}>
                {site.code}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          onValueChange={(value) => {
            setSort(value as typeof sort);
            setPage(1);
          }}
          value={sort}
        >
          <SelectTrigger aria-label="Sort" className="w-[170px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="createdAt">Newest first</SelectItem>
            <SelectItem value="severity">Severity (SEV1 first)</SelectItem>
            <SelectItem value="slaDueAt">SLA due soonest</SelectItem>
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button onClick={resetFilters} size="sm" variant="ghost">
            Reset
          </Button>
        )}
      </div>

      <SectionCard
        contentClassName="p-0"
        title={`Incidents${listMeta ? ` — ${listMeta.total}` : ""}`}
      >
        {incidents.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void incidents.refetch()}
              reason={incidents.error.message}
              title="Incidents could not be loaded"
            />
          </div>
        ) : incidents.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-11 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="No incidents match the current filter."
              icon={Siren}
              title="No incidents to show"
            />
          </div>
        ) : (
          <ul className="max-h-[600px] overflow-y-auto">
            {rows.map((incident) => (
              <li key={incident.id}>
                <button
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2.5 text-start transition-colors last:border-0 hover:bg-accent/50"
                  onClick={() =>
                    setActiveView("ops.incident-detail", { incidentId: incident.id })
                  }
                  type="button"
                >
                  <IncidentSeverityBadge className="shrink-0" value={incident.severity} />
                  <span className="font-tech shrink-0 text-muted-foreground ltr-technical">
                    {incident.number}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm" title={incident.title}>
                    {incident.title}
                  </span>
                  {incident.change && (
                    <span className="hidden shrink-0 items-center gap-1 rounded-full border border-info/25 bg-info-subtle px-2 py-0.5 text-[11px] font-medium text-info lg:inline-flex">
                      <GitPullRequest aria-hidden className="size-3" />
                      {incident.change.number}
                    </span>
                  )}
                  {incident.site && (
                    <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                      {incident.site.code}
                    </span>
                  )}
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                    {incident._count.devices} dev · {incident._count.alerts} alert
                    {incident._count.alerts === 1 ? "" : "s"}
                  </span>
                  <SlaChip className="shrink-0" sla={incident.sla} />
                  <StatusBadge
                    className="hidden lg:inline-flex"
                    config={lookupStatusConfig(INCIDENT_STATUS_UI, incident.status)}
                    withIcon={false}
                  />
                  {incident.owner && (
                    <span className="hidden shrink-0 text-xs text-muted-foreground xl:inline">
                      {incident.owner.name}
                    </span>
                  )}
                  <span className="w-24 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
                    {formatDistanceToNow(new Date(incident.createdAt), { addSuffix: true })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {listMeta && listMeta.totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
            <span>
              Page {listMeta.page} of {listMeta.totalPages} · {listMeta.total} incidents
            </span>
            <div className="flex gap-2">
              <Button
                disabled={listMeta.page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
                size="sm"
                variant="outline"
              >
                Previous
              </Button>
              <Button
                disabled={listMeta.page >= listMeta.totalPages}
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
    </div>
  );
}
