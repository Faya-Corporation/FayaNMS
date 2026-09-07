"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  FileDiff,
  GitBranch,
  History,
  Play,
  Radar,
} from "lucide-react";

import { useDrift, useRunDriftCheck, useTriageDrift } from "@/hooks/api/use-drift";
import { DriftStatusBadge } from "@/components/domain/drift-status-badge";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import {
  DRIFT_STATUS,
  getStatusConfig,
} from "@/lib/domain/status";
import type { DriftRow } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";
import { ConfigDiff } from "@/components/device/config-diff";

/**
 * Drift view (Task 3-c): OPEN drift records between approved baselines and
 * running configs. KPI row from the list meta, triage actions (Accept =
 * intentional deviation, Resolve = brought back into compliance) and the
 * 3-b ConfigDiff dialog for baseline↔current. "Run drift check" queues a
 * fleet DRIFT_CHECK the worker evaluates server-side.
 */

const ALL = "ALL";
const PAGE_SIZE = 25;

type TriageAction = "ACCEPT" | "RESOLVE";

export function DriftView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [status, setStatus] = useState(ALL);
  const [page, setPage] = useState(1);

  const drift = useDrift({
    page,
    pageSize: PAGE_SIZE,
    status: status !== ALL ? status : undefined,
  });
  const runCheck = useRunDriftCheck();
  const triage = useTriageDrift();

  const rows = drift.data?.data ?? [];
  const meta = drift.data?.meta;

  const [diffRecord, setDiffRecord] = useState<DriftRow | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    record: DriftRow;
    action: TriageAction;
  } | null>(null);

  const hasBaselines = meta?.hasBaselines ?? false;

  const lastCheckedLabel = meta?.lastCheckedAt
    ? formatDistanceToNow(new Date(meta.lastCheckedAt), { addSuffix: true })
    : "never";

  const runButton = (
    <Button
      disabled={!hasBaselines || runCheck.isPending}
      onClick={() => runCheck.mutate({})}
      size="sm"
    >
      {runCheck.isPending ? (
        <History aria-hidden="true" className="animate-spin" />
      ) : (
        <Play aria-hidden="true" />
      )}
      Run drift check
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Running configs compared against approved baselines — triage deviations as accepted or resolved"
        primaryAction={
          hasBaselines ? (
            runButton
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">{runButton}</span>
              </TooltipTrigger>
              <TooltipContent>
                Approve a baseline first (device → Config → Approve as baseline)
              </TooltipContent>
            </Tooltip>
          )
        }
        title="Drift"
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          className={(meta?.open ?? 0) > 0 ? "border-warning/40" : undefined}
          description="Records awaiting triage (OPEN status)"
          icon={FileDiff}
          label="Open drifts"
          loading={drift.isLoading}
          value={meta?.open ?? 0}
        />
        <KpiCard
          description="Distinct devices with open drift"
          icon={Radar}
          label="Devices affected"
          loading={drift.isLoading}
          value={meta?.devicesAffected ?? 0}
        />
        <KpiCard
          description="Records resolved since midnight"
          icon={CircleCheck}
          label="Resolved today"
          loading={drift.isLoading}
          value={meta?.resolvedToday ?? 0}
        />
        <KpiCard
          description="Latest finished DRIFT_CHECK job"
          icon={History}
          label="Last checked"
          loading={drift.isLoading}
          value={lastCheckedLabel}
        />
      </div>

      <SectionCard
        contentClassName="p-0"
        description="Open records first — refreshed by every DRIFT_CHECK the worker completes"
        title="Drift records"
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground md:inline">
              Last checked: {lastCheckedLabel}
            </span>
            <Select
              onValueChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
              value={status}
            >
              <SelectTrigger aria-label="Filter by drift status" className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {Object.values(DRIFT_STATUS).map((config) => (
                  <SelectItem key={config.key} value={config.key}>
                    {config.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      >
        {drift.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void drift.refetch()}
              reason={drift.error.message}
              title="Drift records could not be loaded"
            />
          </div>
        ) : drift.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={
                status !== ALL
                  ? "No records with this status — try All statuses."
                  : "No drift detected — baseline configs match running configs. Run a check to compare every baseline-covered device."
              }
              icon={GitBranch}
              title="No drift detected"
            />
          </div>
        ) : (
          <div className="max-h-[600px] overflow-y-auto">
            <div className="min-w-[980px]">
              <Table aria-label="Drift records — device, baseline vs current version, status and detection time">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Device</TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                      Baseline → Current
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                      Detected
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                      Summary
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Status</TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x) text-end">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <DriftRowRow
                      key={row.id}
                      onDiff={() => setDiffRecord(row)}
                      onNavigateDevice={() =>
                        setActiveView("network.device-detail", { deviceId: row.deviceId })
                      }
                      onTriage={(action) => setConfirmAction({ record: row, action })}
                      row={row}
                      triagePending={
                        triage.isPending && triage.variables?.id === row.id
                      }
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Pagination footer */}
        {meta && rows.length > 0 && (
          <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {meta.total} record{meta.total === 1 ? "" : "s"} · page {meta.page} of{" "}
              {meta.totalPages}
            </span>
            <div className="flex items-center gap-1">
              <Button
                aria-label="Previous page"
                disabled={meta.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                size="sm"
                variant="outline"
              >
                <ChevronLeft aria-hidden="true" />
                Prev
              </Button>
              <Button
                aria-label="Next page"
                disabled={meta.page >= meta.totalPages}
                onClick={() => setPage((p) => p + 1)}
                size="sm"
                variant="outline"
              >
                Next
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Diff dialog — snapshot ids (cuid) accepted by the 3-b endpoint */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setDiffRecord(null);
        }}
        open={diffRecord !== null}
      >
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 sm:max-w-[min(95vw,1100px)]">
          <DialogHeader className="border-b">
            <DialogTitle className="font-tech ltr-technical">
              Drift diff — {diffRecord?.hostname} v{diffRecord?.baselineVersion} → v
              {diffRecord?.currentVersion}
            </DialogTitle>
            <DialogDescription>
              Baseline vs running configuration — secrets are masked; normalized
              mode is the drift-equivalent view.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {diffRecord && (
              <ConfigDiff
                deviceId={diffRecord.deviceId}
                from={diffRecord.baselineSnapshotId}
                hostname={diffRecord.hostname}
                maxHeightClass="max-h-[calc(90vh-12rem)]"
                to={diffRecord.currentSnapshotId}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Triage confirmation */}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
        }}
        open={confirmAction !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.action === "ACCEPT" ? "Accept drift?" : "Resolve drift?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction?.action === "ACCEPT"
                ? "Marks the deviation on "
                : "Marks the deviation on "}
              <span className="font-tech ltr-technical">
                {confirmAction?.record.hostname}
              </span>{" "}
              as{" "}
              {confirmAction?.action === "ACCEPT"
                ? "an intentional, accepted change. The record closes as Accepted."
                : "brought back into compliance. The record closes as Resolved."}{" "}
              {confirmAction?.action === "RESOLVE" &&
                "Resolve this only when the config actually matches the baseline again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                confirmAction?.action === "RESOLVE" &&
                  "bg-success text-white hover:bg-success/90"
              )}
              onClick={() => {
                if (!confirmAction) return;
                triage.mutate({
                  id: confirmAction.record.id,
                  action: confirmAction.action,
                });
                setConfirmAction(null);
              }}
            >
              {confirmAction?.action === "ACCEPT" ? "Accept drift" : "Resolve drift"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function DriftRowRow({
  row,
  onDiff,
  onNavigateDevice,
  onTriage,
  triagePending,
}: {
  row: DriftRow;
  onDiff: () => void;
  onNavigateDevice: () => void;
  onTriage: (action: TriageAction) => void;
  triagePending: boolean;
}) {
  const config = getStatusConfig(DRIFT_STATUS, row.status);
  const isOpen = row.status === "OPEN";

  return (
    <TableRow>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <div className="flex flex-col">
          <button
            aria-label={`Open ${row.hostname} device detail`}
            className="text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
            onClick={onNavigateDevice}
            type="button"
          >
            {row.hostname}
          </button>
          <span className="text-xs text-muted-foreground">{row.siteCode ?? "—"}</span>
        </div>
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <span className="inline-flex items-center gap-1.5 font-tech text-sm ltr-technical">
          <GitBranch aria-hidden="true" className="size-3.5 text-muted-foreground" />
          v{row.baselineVersion}
          <span aria-hidden="true" className="text-muted-foreground">
            →
          </span>
          v{row.currentVersion}
        </span>
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground tabular-nums">
        {formatDistanceToNow(new Date(row.detectedAt), { addSuffix: true })}
      </TableCell>
      <TableCell className="h-(--density-row-h) max-w-0 px-(--density-cell-x)">
        <p className="max-w-[320px] truncate text-xs text-muted-foreground" title={row.diffSummary ?? undefined}>
          {row.diffSummary ?? "—"}
        </p>
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
        <DriftStatusBadge value={row.status} />
      </TableCell>
      <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-end">
        <div className="flex items-center justify-end gap-1">
          <Button
            aria-label={`View diff for ${row.hostname} v${row.baselineVersion} to v${row.currentVersion}`}
            onClick={onDiff}
            size="sm"
            variant="outline"
          >
            <FileDiff aria-hidden="true" />
            View diff
          </Button>
          {isOpen && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  aria-label={`Triage drift record for ${row.hostname}`}
                  disabled={triagePending}
                  size="sm"
                  variant="ghost"
                >
                  <span
                    aria-hidden="true"
                    className={cn("size-2 rounded-full", config.dotClass)}
                  />
                  Triage
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem
                  onClick={() => {
                    onTriage("ACCEPT");
                  }}
                >
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full bg-info"
                  />
                  Accept as intentional
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    onTriage("RESOLVE");
                  }}
                >
                  <CircleCheck aria-hidden="true" className="size-3.5 text-success" />
                  Resolve (fixed)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
