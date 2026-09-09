"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  CircleCheck,
  Clock,
  Cpu,
  ListChecks,
  OctagonX,
  PackageCheck,
  TriangleAlert,
} from "lucide-react";

import { useFirmwareInventory, useFirmwareUpgrade } from "@/hooks/api/use-firmware";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { HighRiskActionDialog } from "@/components/domain/high-risk-action-dialog";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { lifecycleBadge } from "@/components/views/firmware-band";
import { isValidTargetVersion } from "@/lib/firmware/lifecycle";
import type { FirmwareDeviceRow } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";

/**
 * Firmware (Phase 13-b): fleet firmware lifecycle inventory from
 * /api/v1/firmware. KPI row (total + current/aging/eos/eol), ranked
 * inventory (worst lifecycle first) and the guarded upgrade action — the
 * HighRiskActionDialog pre-fills the matrix-suggested stable version and
 * enqueues a FIRMWARE_UPGRADE job (the worker walks the simulated stages;
 * the device flip + audit happen Next-side). Badge colors follow the shared
 * token system (current→success, aging→info, eos→warning, eol→danger) with
 * icon + text, never color-only.
 */

export function FirmwareView() {
  const t = useTranslations("firmware");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const { toast } = useToast();

  const inventory = useFirmwareInventory();
  const upgrade = useFirmwareUpgrade();

  const [upgradeTarget, setUpgradeTarget] = useState<FirmwareDeviceRow | null>(null);
  const [targetVersion, setTargetVersion] = useState("");
  const [targetTouched, setTargetTouched] = useState(false);

  const devices = useMemo(() => inventory.data?.devices ?? [], [inventory.data]);
  const counts = inventory.data?.meta.counts;

  const openUpgradeDialog = (row: FirmwareDeviceRow) => {
    setUpgradeTarget(row);
    setTargetVersion(row.suggestedTarget ?? "");
    setTargetTouched(false);
  };

  const targetValid =
    upgradeTarget !== null &&
    targetVersion.trim().length > 0 &&
    isValidTargetVersion(
      upgradeTarget.vendorKey,
      upgradeTarget.firmware,
      targetVersion
    );
  const targetChanged = targetVersion.trim() !== (upgradeTarget?.firmware ?? "");

  const submitUpgrade = async (): Promise<React.ReactNode> => {
    if (!upgradeTarget) return null;
    const result = await upgrade.mutateAsync({
      deviceId: upgradeTarget.deviceId,
      targetVersion: targetVersion.trim(),
    });
    toast({
      title: t("upgrade.toast.title", { hostname: result.hostname }),
      description: t("upgrade.toast.description", {
        correlation: result.correlationId,
      }),
    });
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border bg-surface-subtle p-3 text-sm">
          <p className="font-medium">
            {t("upgrade.success.title", { correlation: result.correlationId })}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("upgrade.success.description", {
              hostname: result.hostname,
              from: result.fromVersion ?? "—",
              to: result.targetVersion,
            })}
          </p>
        </div>
        <Button
          onClick={() => setActiveView("ops.jobs")}
          size="sm"
          variant="outline"
        >
          {t("upgrade.openJobCenter")}
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description={t("description")}
        title={t("title")}
      />

      {inventory.isError ? (
        <ErrorState
          onRetry={() => void inventory.refetch()}
          reason={inventory.error.message}
          title={t("errorTitle")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* KPI row — total + counts per lifecycle status */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <KpiCard
              description={t("kpi.totalHint")}
              icon={Cpu}
              label={t("kpi.total")}
              loading={!inventory.data}
              value={counts?.total ?? "—"}
            />
            <KpiCard
              description={t("kpi.currentHint")}
              icon={CircleCheck}
              label={t("kpi.current")}
              loading={!inventory.data}
              value={counts?.current ?? "—"}
            />
            <KpiCard
              description={t("kpi.agingHint")}
              icon={Clock}
              label={t("kpi.aging")}
              loading={!inventory.data}
              value={counts?.aging ?? "—"}
            />
            <KpiCard
              className={cn((counts?.eos ?? 0) > 0 && "border-warning/40")}
              description={t("kpi.eosHint")}
              icon={TriangleAlert}
              label={t("kpi.eos")}
              loading={!inventory.data}
              value={counts?.eos ?? "—"}
            />
            <KpiCard
              className={cn((counts?.eol ?? 0) > 0 && "border-danger/40")}
              description={t("kpi.eolHint")}
              icon={OctagonX}
              label={t("kpi.eol")}
              loading={!inventory.data}
              value={counts?.eol ?? "—"}
            />
          </div>

          {/* Ranked inventory — worst lifecycle first (server-ranked) */}
          <SectionCard
            contentClassName="p-0"
            description={t("list.description")}
            title={t("list.title")}
          >
            {inventory.isLoading ? (
              <div className="flex flex-col gap-2 p-4">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div
                    key={index}
                    className="h-12 animate-pulse rounded-md bg-muted/60"
                  />
                ))}
              </div>
            ) : devices.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  description={t("list.emptyDescription")}
                  icon={PackageCheck}
                  title={t("list.emptyTitle")}
                />
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto">
                <Table>
                  <TableHeader className="sticky top-0 z-10 bg-card">
                    <TableRow>
                      <TableHead>{t("list.device")}</TableHead>
                      <TableHead>{t("list.firmware")}</TableHead>
                      <TableHead>{t("list.lifecycle")}</TableHead>
                      <TableHead className="hidden md:table-cell">
                        {t("list.lastUpgrade")}
                      </TableHead>
                      <TableHead className="text-end">{t("list.actions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {devices.map((row) => (
                      <FirmwareRow
                        key={row.deviceId}
                        onUpgrade={openUpgradeDialog}
                        row={row}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="border-t px-4 py-2 text-xs text-muted-foreground">
              {t("matrixNote")}
            </p>
          </SectionCard>
        </div>
      )}

      {/* Guarded upgrade — HighRiskActionDialog with target-version input */}
      <HighRiskActionDialog
        confirmHint={upgradeTarget?.hostname ?? "hostname"}
        confirmLabel={t("upgrade.confirmLabel")}
        confirmPhrase={upgradeTarget?.hostname ?? ""}
        danger={false}
        description={t("upgrade.description")}
        impact={
          upgradeTarget
            ? [
                {
                  label: t("upgrade.impact.device"),
                  value: (
                    <span className="font-tech ltr-technical">
                      {upgradeTarget.hostname}
                    </span>
                  ),
                },
                {
                  label: t("upgrade.impact.vendor"),
                  value: (
                    <span>
                      {upgradeTarget.vendorName}
                      {upgradeTarget.model ? ` · ${upgradeTarget.model}` : ""}
                    </span>
                  ),
                },
                {
                  label: t("upgrade.impact.currentVersion"),
                  value: (
                    <span className="font-tech ltr-technical">
                      {upgradeTarget.firmware ?? "—"}
                    </span>
                  ),
                },
                {
                  label: t("upgrade.impact.targetVersion"),
                  value: (
                    <span
                      className={cn(
                        "font-tech ltr-technical",
                        targetValid && targetChanged && "text-success"
                      )}
                    >
                      {targetVersion.trim() || "—"}
                    </span>
                  ),
                },
                {
                  label: t("upgrade.impact.execution"),
                  value: <span>{t("upgrade.impact.executionValue")}</span>,
                },
              ]
            : []
        }
        onConfirm={submitUpgrade}
        onOpenChange={(open) => {
          if (!open) setUpgradeTarget(null);
        }}
        open={upgradeTarget !== null}
        title={t("upgrade.title", {
          hostname: upgradeTarget?.hostname ?? "",
        })}
      >
        <div className="flex flex-col gap-2">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="firmware-target-input"
          >
            {t("upgrade.targetLabel")}
          </label>
          <Input
            aria-describedby="firmware-target-hint"
            autoComplete="off"
            className="font-tech ltr-technical"
            id="firmware-target-input"
            onChange={(event) => {
              setTargetVersion(event.target.value);
              setTargetTouched(true);
            }}
            spellCheck={false}
            value={targetVersion}
          />
          <p
            aria-live="polite"
            className="text-xs text-muted-foreground"
            id="firmware-target-hint"
          >
            {targetVersion.trim().length > 0 && !targetValid
              ? t("upgrade.targetInvalid", {
                  family: upgradeTarget?.lifecycle?.family ?? "",
                })
              : upgradeTarget?.suggestedTarget
                ? t("upgrade.targetHint", {
                    version: upgradeTarget.suggestedTarget,
                  })
                : ""}
          </p>
          {targetTouched && targetVersion.trim() === upgradeTarget?.firmware && (
            <p className="text-xs text-warning" role="status">
              {t("upgrade.targetSameAsCurrent")}
            </p>
          )}
        </div>
      </HighRiskActionDialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inventory row                                                       */
/* ------------------------------------------------------------------ */

function FirmwareRow({
  row,
  onUpgrade,
}: {
  row: FirmwareDeviceRow;
  onUpgrade: (row: FirmwareDeviceRow) => void;
}) {
  const t = useTranslations("firmware");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const badge = lifecycleBadge(row.lifecycle?.status);
  const upgradeBlocked =
    row.deviceStatus === "UNMANAGED" ||
    row.deviceStatus === "OFFLINE" ||
    row.openUpgradeJob ||
    row.firmware === null;

  return (
    <TableRow className={cn(row.openUpgradeJob && "bg-info-subtle/40")}>
      <TableCell className="max-w-0 align-middle">
        <button
          aria-label={t("list.openDeviceAria", { hostname: row.hostname })}
          className="block min-w-0 truncate text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
          onClick={() =>
            setActiveView("network.device-detail", { deviceId: row.deviceId })
          }
          type="button"
        >
          {row.hostname}
        </button>
        <span className="block truncate text-xs text-muted-foreground">
          {row.vendorName}
          {row.model ? ` · ${row.model}` : ""}
        </span>
      </TableCell>
      <TableCell className="whitespace-nowrap align-middle">
        <span className="font-tech text-sm ltr-technical">
          {row.firmware ?? "—"}
        </span>
        {row.openUpgradeJob && (
          <span className="ms-2 inline-flex items-center gap-1 rounded-full border bg-info-subtle px-1.5 py-0.5 text-[10px] font-medium text-info">
            <ListChecks aria-hidden="true" className="size-3" />
            {t("list.upgradeQueued")}
          </span>
        )}
      </TableCell>
      <TableCell className="align-middle">
        <StatusBadge config={badge} />
      </TableCell>
      <TableCell className="hidden whitespace-nowrap align-middle text-xs text-muted-foreground md:table-cell">
        {row.lastUpgradeAt
          ? formatDistanceToNow(new Date(row.lastUpgradeAt), { addSuffix: true })
          : "—"}
      </TableCell>
      <TableCell className="text-end align-middle">
        <Button
          disabled={upgradeBlocked}
          onClick={() => onUpgrade(row)}
          size="sm"
          variant="outline"
        >
          {t("list.upgrade")}
        </Button>
      </TableCell>
    </TableRow>
  );
}
