"use client";

import { formatDistanceToNow, parseISO } from "date-fns";
import {
  Cpu,
  Gauge,
  HeartPulse,
  Network,
  RefreshCcw,
  Server,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  useApplyRebalancePlan,
  useCollectorDistribution,
  useCollectors,
  usePreviewRebalancePlan,
} from "@/hooks/api/use-admin";
import { useNavigationStore } from "@/stores/navigation";
import { HighRiskActionDialog } from "@/components/domain/high-risk-action-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { cn } from "@/lib/utils";

/**
 * Administration → Collectors (Task 7-b).
 *
 * Live poller/collector registry: the bun worker (:3030) plus the logical
 * engines (config collector, alert engine, retention). The endpoint probes
 * worker /health on every request and upserts state; the table auto
 * refreshes every 10 s.
 */

// Kind/status labels resolve in the active locale at render (the R82
// SORT_CHIPS / R81 GROUPS / R84 STATUS_GROUPS dynamic-key precedent).
// The API contract is an open string (CollectorRow.kind/status), so
// unknown tokens fall back to the raw value.
const KIND_KEYS: Record<string, string> = {
  POLLER: "poller",
  CONFIG_COLLECTOR: "configCollector",
  ALERT_ENGINE: "alertEngine",
  RETENTION: "retention",
};

const STATUS_KEYS: Record<string, string> = {
  ONLINE: "online",
  OFFLINE: "offline",
};

export function AdminCollectorsView() {
  const t = useTranslations("collectors");
  const collectorsQuery = useCollectors();
  const collectors = collectorsQuery.data?.collectors ?? [];
  const workerReachable = collectorsQuery.data?.workerReachable ?? false;
  const online = collectors.filter((c) => c.status === "ONLINE").length;
  const jobsCompleted = collectors.reduce(
    (sum, c) => sum + Number(c.stats.jobsCompleted ?? 0),
    0
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("registry.title")}
        description={t("registry.description")}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void collectorsQuery.refetch()}
            disabled={collectorsQuery.isFetching}
          >
            <RefreshCcw className={cn("me-2 size-4", collectorsQuery.isFetching && "animate-spin")} />
            {t("registry.refresh")}
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {/* The online/total ratio and the toLocaleString numerals are
            data-plane values; the em-dash empty placeholders stay code-side
            locale-neutral tokens (numeric chip + fmtMetric precedent). */}
        <KpiCard label={t("registry.kpi.online")} value={`${online}/${collectors.length || "—"}`} icon={Server} />
        <KpiCard
          label={t("registry.kpi.worker")}
          value={workerReachable ? t("registry.kpi.reachable") : t("registry.kpi.unreachable")}
          icon={HeartPulse}
        />
        <KpiCard label={t("registry.kpi.jobsCompleted")} value={jobsCompleted ? jobsCompleted.toLocaleString() : "—"} icon={Zap} />
      </div>

      <SectionCard title={t("registry.card.title")} description={t("registry.card.description")}>
        {collectorsQuery.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-muted" />
            ))}
          </div>
        ) : collectorsQuery.isError ? (
          <ErrorState
            title={t("registry.error.title")}
            reason={t("registry.error.reason")}
            onRetry={() => void collectorsQuery.refetch()}
          />
        ) : collectors.length === 0 ? (
          <EmptyState
            icon={Cpu}
            title={t("registry.empty.title")}
            description={t("registry.empty.description")}
          />
        ) : (
          <Table aria-label={t("registry.table.ariaLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("registry.table.col.collector")}</TableHead>
                <TableHead>{t("registry.table.col.kind")}</TableHead>
                <TableHead>{t("registry.table.col.status")}</TableHead>
                <TableHead>{t("registry.table.col.capabilities")}</TableHead>
                <TableHead>{t("registry.table.col.host")}</TableHead>
                <TableHead>{t("registry.table.col.lastSeen")}</TableHead>
                <TableHead className="text-end">{t("registry.table.col.jobs")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collectors.map((collector) => {
                const kindKey = KIND_KEYS[collector.kind];
                const statusKey = STATUS_KEYS[collector.status];
                return (
                <TableRow key={collector.id}>
                  <TableCell className="font-medium">{collector.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {kindKey ? t(`kind.${kindKey}`) : collector.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={cn(
                          "size-2 rounded-full",
                          collector.status === "ONLINE"
                            ? "animate-pulse bg-success"
                            : "bg-danger-orange"
                        )}
                        aria-hidden
                      />
                      <span
                        className={
                          collector.status === "ONLINE" ? "text-success" : "text-danger-orange"
                        }
                      >
                        {statusKey ? t(`status.${statusKey}`) : collector.status}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell>
                    {/* Capabilities are data-plane tokens (font-mono badges —
                        the drivers-registry vendorLabel/adapter precedent). */}
                    <div className="flex max-w-56 flex-wrap gap-1">
                      {collector.capabilities.map((cap) => (
                        <Badge key={cap} variant="outline" className="font-mono text-[10px]">
                          {cap}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {collector.host ?? "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {/* date-fns English relative time — no ar locale wired
                        anywhere (device-config-tab / R83-R85 precedent,
                        documented survivor). */}
                    {collector.lastSeenAt
                      ? formatDistanceToNow(parseISO(collector.lastSeenAt), { addSuffix: true })
                      : t("registry.row.never")}
                  </TableCell>
                  <TableCell className="text-end font-mono text-xs">
                    {String(collector.stats.jobsCompleted ?? "—")}
                  </TableCell>
                </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <CollectorDistributionSection />
    </div>
  );
}

/* ───────────────── Collector agent distribution (Phase 15-b) ───────────────── */

/**
 * Site-resident agent fleet with deterministic device assignment over real
 * devices + guarded rebalance (preview → typed-confirm → staged audits).
 * The fleet itself is a DOCUMENTED SIMULATION — the demo note is rendered
 * above the section so the simulation is never mistaken for live state.
 */

const LOAD_BAR_CLASSES: Record<string, string> = {
  normal: "bg-success",
  elevated: "bg-warning",
  "over-capacity": "bg-danger",
};

const BAND_BADGE_CLASSES: Record<string, string> = {
  normal: "bg-success-subtle text-success border-success/25",
  elevated: "bg-warning-subtle text-warning border-warning/25",
  "over-capacity": "bg-danger-subtle text-danger border-danger/25",
};

const BAND_KEYS: Record<string, string> = {
  normal: "normal",
  elevated: "elevated",
  "over-capacity": "overCapacity",
};

interface RebalanceDialogState {
  open: boolean;
  planId: string | null;
  moves: { deviceId: string; hostname: string; fromAgentId: string; fromLoad: number; toAgentId: string; toLoad: number }[];
}

function CollectorDistributionSection() {
  const t = useTranslations("collectors.distribution");
  const distributionQuery = useCollectorDistribution();
  const previewMutation = usePreviewRebalancePlan();
  const applyMutation = useApplyRebalancePlan();
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const [dialog, setDialog] = useState<RebalanceDialogState>({
    open: false,
    planId: null,
    moves: [],
  });

  const fleet = distributionQuery.data?.fleet ?? [];
  const sites = distributionQuery.data?.sites ?? [];
  const summary = distributionQuery.data?.summary;
  const overCapacity = summary?.overCapacityAgents ?? 0;
  // GA-4b: the fleet plane follows the registry — "real" when ≥1 ACTIVE
  // registered agent exists, "simulated" (documented demo fleet) otherwise.
  const plane = distributionQuery.data?.plane ?? "simulated";

  const openRebalanceDialog = async () => {
    try {
      const preview = await previewMutation.mutateAsync();
      setDialog({ open: true, planId: preview.planId, moves: preview.moves });
    } catch {
      // The preview error toast fires from the mutation; keep the dialog closed.
    }
  };

  return (
    <SectionCard
      title={t("title")}
      description={t("description")}
      actions={
        <Button
          size="sm"
          variant={overCapacity > 0 ? "default" : "outline"}
          disabled={overCapacity === 0 || distributionQuery.isFetching}
          onClick={() => void openRebalanceDialog()}
        >
          {overCapacity > 0 ? (
            t("rebalance.button")
          ) : (
            t("rebalance.buttonBalanced")
          )}
        </Button>
      }
    >
      {distributionQuery.isLoading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded bg-muted" />
          ))}
        </div>
      ) : distributionQuery.isError ? (
        <ErrorState
          title={t("title")}
          reason={t("previewError")}
          onRetry={() => void distributionQuery.refetch()}
        />
      ) : (
        <div className="space-y-6 p-4">
          <p
            className={
              plane === "real"
                ? "rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400"
                : "rounded-md border border-warning/25 bg-warning-subtle px-3 py-2 text-xs text-warning"
            }
          >
            {plane === "real" ? t("realPlaneNote") : t("demoNote")}
          </p>

          {/* Fleet KPIs */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <KpiCard label={t("kpi.agents")} value={String(summary?.agents ?? "—")} icon={Server} description={t("kpi.agentsHint")} />
            <KpiCard label={t("kpi.devices")} value={String(summary?.devicesAssigned ?? "—")} icon={Network} description={t("kpi.devicesHint")} />
            <KpiCard
              label={t("kpi.avgLoad")}
              value={summary ? `${Math.round(summary.avgLoad * 100)}%` : "—"}
              icon={Gauge}
              description={t("kpi.avgLoadHint")}
            />
            <KpiCard
              label={t("kpi.overCapacity")}
              value={String(overCapacity)}
              icon={TriangleAlert}
              description={t("kpi.overCapacityHint")}
            />
            <KpiCard
              label={t("kpi.uncovered")}
              value={String(summary?.uncoveredDevices ?? "—")}
              icon={Cpu}
              description={t("kpi.uncoveredHint")}
            />
          </div>

          {/* Agent cards */}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {fleet.map((agent) => (
              <div
                key={agent.agentId}
                className="rounded-lg border bg-card p-4"
                data-testid={`agent-card-${agent.agentId}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{agent.name}</p>
                    <p className="font-tech ltr-technical text-xs text-muted-foreground">
                      {agent.siteCode ?? "—"} · {t(`role.${agent.role}`)} · v{agent.version ?? "—"}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={BAND_BADGE_CLASSES[agent.band]}
                  >
                    {t(`band.${BAND_KEYS[agent.band]}`)}
                  </Badge>
                </div>

                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {t("agent.assigned", {
                        assigned: agent.assignedCount,
                        capacity: agent.capacity,
                      })}
                      {" · "}
                      {t("agent.online", { count: agent.onlineCount })}
                    </span>
                    <span className="font-mono">{Math.round(agent.load * 100)}%</span>
                  </div>
                  <div
                    className="h-2 overflow-hidden rounded-full bg-muted"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(agent.load * 100)}
                    aria-label={t("agent.load")}
                  >
                    <div
                      className={`h-full rounded-full ${LOAD_BAR_CLASSES[agent.band]}`}
                      style={{ width: `${Math.min(100, agent.load * 100)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {t("agent.score")}: <span className="font-mono">{agent.score}</span>
                    </span>
                    <span>
                      {t("agent.region")}: {agent.region}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Site coverage matrix */}
          <div>
            <p className="mb-2 text-sm font-medium">{t("sites.title")}</p>
            <p className="mb-3 text-xs text-muted-foreground">{t("sites.description")}</p>
            <div className="max-h-72 overflow-y-auto rounded-md border">
              <Table
                aria-label={`${t("sites.title")} — ${t("sites.description")}`}
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("sites.site")}</TableHead>
                    <TableHead>{t("sites.devices")}</TableHead>
                    <TableHead>{t("sites.online")}</TableHead>
                    <TableHead>{t("sites.agents")}</TableHead>
                    <TableHead>{t("sites.coverage")}</TableHead>
                    <TableHead className="text-end">{t("sites.remote")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sites.map((site) => (
                    <TableRow key={site.siteCode}>
                      <TableCell className="font-tech ltr-technical text-xs">
                        {site.siteCode}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{site.devices}</TableCell>
                      <TableCell className="font-mono text-xs">{site.online}</TableCell>
                      <TableCell className="font-mono text-xs">{site.agentCount}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="h-2 w-20 overflow-hidden rounded-full bg-muted">
                            <div
                              className={
                                site.coveragePct >= 80
                                  ? "h-full rounded-full bg-success"
                                  : site.coveragePct >= 50
                                    ? "h-full rounded-full bg-warning"
                                    : "h-full rounded-full bg-danger"
                              }
                              style={{ width: `${site.coveragePct}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs">{site.coveragePct}%</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-end font-mono text-xs">
                        {site.remoteAssigned}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>
      )}

      <HighRiskActionDialog
        open={dialog.open}
        onOpenChange={(open) =>
          setDialog((state) => ({ ...state, open }))
        }
        title={t("rebalance.dialogTitle")}
        description={t("rebalance.dialogDescription")}
        impact={[
          ...(dialog.planId
            ? [
                {
                  label: t("rebalance.planId"),
                  value: (
                    <span className="font-tech ltr-technical">{dialog.planId}</span>
                  ),
                },
                {
                  label: t("rebalance.moves", { count: dialog.moves.length }),
                  value: (
                    <span className="font-tech ltr-technical">
                      {dialog.moves.length}
                    </span>
                  ),
                },
              ]
            : []),
          {
            label: t("rebalance.impactTitle"),
            value: (
              <span className="block space-y-1 text-start">
                {dialog.moves.map((move) => (
                  <span key={move.deviceId} className="block font-tech ltr-technical text-xs">
                    {t("rebalance.impactRow", {
                      hostname: move.hostname,
                      from: move.fromAgentId,
                      fromLoad: move.fromLoad,
                      to: move.toAgentId,
                      toLoad: move.toLoad,
                    })}
                  </span>
                ))}
              </span>
            ),
          },
        ]}
        confirmPhrase={t("rebalance.confirmPhrase")}
        confirmHint={t("rebalance.confirmHint")}
        confirmLabel={t("rebalance.confirmLabel")}
        onConfirm={async () => {
          if (!dialog.planId) throw new Error(t("rebalance.previewError"));
          try {
            const result = await applyMutation.mutateAsync(dialog.planId);
            return (
              <div className="space-y-2">
                <p className="text-sm font-medium">{t("rebalance.successTitle")}</p>
                <p className="text-sm text-muted-foreground">
                  {t("rebalance.successBody", {
                    moves: result.moved,
                    seconds: Math.max(1, Math.round(result.durationMs / 1000)),
                    correlationId: result.correlationId,
                  })}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setActiveView("ops.events")}
                >
                  {t("rebalance.viewEvents")}
                </Button>
              </div>
            );
          } catch (error) {
            const message =
              error instanceof Error && /STALE/.test(error.message)
                ? t("rebalance.stale")
                : error instanceof Error
                  ? error.message
                  : t("rebalance.previewError");
            throw new Error(message);
          }
        }}
      />
    </SectionCard>
  );
}
