"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { Gauge, OctagonX, Router, TriangleAlert } from "lucide-react";

import { usePredictiveHealth } from "@/hooks/api/use-predictive";
import { useSites } from "@/hooks/api/use-sites";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { RISK_BAND_UI } from "@/components/views/predictive-band";
import type {
  PredictiveDeviceRisk,
  PredictiveFactors,
} from "@/lib/api-client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";

/**
 * Predictive Health (Phase 12-c): deterministic, dependency-free risk
 * ranking from /api/v1/predictive (formula "v1"). Transparent ML-lite —
 * every score decomposes into the five capped factors rendered per row,
 * so the "why" is always one glance away. Band colors reuse the shared
 * badge system (critical→danger, high→warning, moderate→info, low→success)
 * with icon + text, never color alone.
 */

const ALL_SITES = "ALL_SITES";

/** Factor bars share one rendering rule across the rows. */
const FACTOR_KEYS = [
  "cpuTrend",
  "alertPressure",
  "backupReliability",
  "drift",
  "interfaceErrors",
] as const;

type FactorKey = (typeof FACTOR_KEYS)[number];

export function PredictiveHealthView() {
  const t = useTranslations("predictive");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const sites = useSites();

  const [siteId, setSiteId] = useState(ALL_SITES);
  const predictive = usePredictiveHealth(
    siteId !== ALL_SITES ? { siteId } : {}
  );
  const devices = useMemo(
    () => predictive.data?.devices ?? [],
    [predictive.data]
  );
  const meta = predictive.data?.meta;

  const hotCount = devices.filter(
    (d) => d.band === "high" || d.band === "critical"
  ).length;
  const avgScore =
    devices.length > 0
      ? Math.round(
          (devices.reduce((sum, d) => sum + d.score, 0) / devices.length) * 10
        ) / 10
      : 0;
  const worst = devices[0];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        actions={
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground tabular-nums sm:inline-flex">
            <span
              aria-hidden="true"
              className="size-1.5 animate-pulse rounded-full bg-success"
            />
            {t("updated", {
              time: predictive.dataUpdatedAt
                ? format(predictive.dataUpdatedAt, "HH:mm:ss")
                : "—",
            })}
          </span>
        }
        description={t("description")}
        title={t("title")}
      />

      {predictive.isError ? (
        <ErrorState
          onRetry={() => void predictive.refetch()}
          reason={predictive.error.message}
          title={t("errorTitle")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* KPI row */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              description={t("kpi.analyzedHint")}
              icon={Router}
              label={t("kpi.analyzed")}
              loading={!predictive.data}
              value={meta?.deviceCount ?? "—"}
            />
            <KpiCard
              className={hotCount > 0 ? "border-warning/40" : undefined}
              description={t("kpi.hotHint")}
              icon={TriangleAlert}
              label={t("kpi.hot")}
              loading={!predictive.data}
              value={devices.length > 0 ? hotCount : "—"}
            />
            <KpiCard
              description={t("kpi.avgHint")}
              icon={Gauge}
              label={t("kpi.avg")}
              loading={!predictive.data}
              value={devices.length > 0 ? `${avgScore}` : "—"}
            />
            <KpiCard
              description={t("kpi.worstHint")}
              icon={OctagonX}
              label={t("kpi.worst")}
              loading={!predictive.data}
              value={worst?.hostname ?? "—"}
            />
          </div>

          {/* Ranked risk list */}
          <SectionCard
            contentClassName="p-0"
            description={t("list.description")}
            title={t("list.title")}
            actions={
              <Select
                onValueChange={(value) => setSiteId(value)}
                value={siteId}
              >
                <SelectTrigger
                  aria-label={t("list.siteFilter")}
                  className="h-8 w-40 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SITES}>
                    {t("list.allSites")}
                  </SelectItem>
                  {(sites.data ?? []).map((site) => (
                    <SelectItem key={site.id} value={site.id}>
                      {site.name} ({site.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          >
            {predictive.isError ? null : predictive.isLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 5 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-20 animate-pulse rounded-md bg-muted/60"
                  />
                ))}
              </div>
            ) : devices.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  description={t("list.emptyDescription")}
                  icon={Gauge}
                  title={t("list.emptyTitle")}
                />
              </div>
            ) : (
              <div className="max-h-[640px] overflow-y-auto">
                <ol className="flex flex-col gap-2 p-4" aria-label={t("list.title")}>
                  {devices.map((row, index) => (
                    <RiskRow
                      key={row.deviceId}
                      rank={index + 1}
                      row={row}
                      onOpenDevice={() =>
                        setActiveView("network.device-detail", {
                          deviceId: row.deviceId,
                        })
                      }
                    />
                  ))}
                </ol>
              </div>
            )}
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              {t("formulaNote")}
            </p>
          </SectionCard>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Ranked row                                                          */
/* ------------------------------------------------------------------ */

function RiskRow({
  rank,
  row,
  onOpenDevice,
}: {
  rank: number;
  row: PredictiveDeviceRisk;
  onOpenDevice: () => void;
}) {
  const t = useTranslations("predictive");
  const bandConfig = RISK_BAND_UI[row.band] ?? RISK_BAND_UI.LOW;

  return (
    <li className="rounded-lg border p-3 transition-colors hover:bg-accent/40">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          aria-hidden="true"
          className="w-6 shrink-0 text-xs font-medium text-muted-foreground tabular-nums"
        >
          #{rank}
        </span>
        <button
          aria-label={`${t("list.openDevice")} ${row.hostname}`}
          className="min-w-0 truncate text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
          onClick={onOpenDevice}
          type="button"
        >
          {row.hostname}
        </button>
        <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">
          {row.vendor}
          {row.site ? ` · ${row.site.code}` : ""}
        </span>
        <StatusBadge className="ms-auto shrink-0" config={bandConfig} />
        <span
          className={cn(
            "w-9 shrink-0 text-end text-lg font-semibold leading-none tabular-nums",
            bandConfig.iconClass
          )}
        >
          {row.score}
        </span>
      </div>
      <p className="mt-1.5 ps-8 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {t(`factors.${row.topFactor.factor}`)}
        </span>
        {" · "}
        {topFactorText(t, row)}
      </p>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 ps-8 sm:grid-cols-3 lg:grid-cols-5">
        {FACTOR_KEYS.map((key) => (
          <FactorBar key={key} factorKey={key} factors={row.factors} />
        ))}
      </div>
    </li>
  );
}

/** Labeled mini bar for one factor — value text always visible (no color-only). */
function FactorBar({
  factorKey,
  factors,
}: {
  factorKey: FactorKey;
  factors: PredictiveFactors;
}) {
  const t = useTranslations("predictive");
  const factor = factors[factorKey];
  const share = factor.max > 0 ? factor.points / factor.max : 0;
  const fillClass =
    share >= 2 / 3
      ? "bg-danger"
      : share >= 1 / 3
        ? "bg-warning"
        : "bg-primary/70";

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {t(`factors.${factorKey}`)}
        </span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums">
          {factor.points}/{factor.max}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="h-1 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", fillClass)}
          style={{ width: `${Math.min(100, share * 100)}%` }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Localized top-factor sentence (params are numbers from the API)     */
/* ------------------------------------------------------------------ */

type PredictiveT = ReturnType<typeof useTranslations>;

/**
 * Builds the localized "why" sentence for a device's top risk factor from
 * the API's numeric detailParams (the server's English `detail` string is
 * only the fallback). Shared with the dashboard "Predictive risks" widget.
 */
export function topFactorText(
  t: PredictiveT,
  row: PredictiveDeviceRisk
): string {
  const p = row.topFactor.detailParams;
  switch (row.topFactor.factor) {
    case "cpuTrend": {
      if (row.factors.cpuTrend.cpu === null) return t("detail.noTelemetry");
      const rise = p.rise ?? 0;
      return t("detail.cpuTrend", {
        cpu: (p.cpu ?? 0).toFixed(0),
        mem: (p.mem ?? 0).toFixed(0),
        rise: `${rise >= 0 ? "+" : ""}${rise.toFixed(1)}`,
      });
    }
    case "alertPressure":
      return t("detail.alertPressure", {
        active: p.active ?? 0,
        ack: p.ack ?? 0,
      });
    case "backupReliability":
      return p.streak > 0
        ? t("detail.backupReliability", { streak: p.streak })
        : t("detail.neverBackedUp");
    case "drift":
      return t("detail.drift", { open: p.open ?? 0, recent: p.recent ?? 0 });
    case "interfaceErrors":
      return t("detail.interfaceErrors", { down: p.down ?? 0 });
    default:
      return row.topFactor.detail;
  }
}
