"use client";

import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import {
  FileDiff,
  GitBranch,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { useBaselines, useRevokeBaseline } from "@/hooks/api/use-baselines";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import type { BaselineRow } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";
import { ConfigDiff } from "@/components/device/config-diff";

/**
 * Baselines view (Task 3-c): the golden reference configuration per device
 * (latest ConfigBaseline row wins). Actions: compare baseline vs running
 * config (3-b diff) and revoke the approval. Approvals themselves happen in
 * the device Config tab ("Approve as baseline"). The secondary strip lists
 * baseline-less devices so gaps are visible at a glance.
 */
export function BaselinesView() {
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const baselines = useBaselines();
  const revoke = useRevokeBaseline();

  const rows = baselines.data?.rows ?? [];
  const meta = baselines.data?.meta;

  const [diffBaseline, setDiffBaseline] = useState<BaselineRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<BaselineRow | null>(null);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Approved golden configurations — the reference the drift engine compares running configs against. Approve new baselines from a device's Config tab."
        title="Baselines"
      />

      <SectionCard
        contentClassName="p-0"
        description="The latest approval per device wins — older approvals stay in the audit trail"
        title="Approved baselines"
      >
        {baselines.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void baselines.refetch()}
              reason={
                baselines.error instanceof Error
                  ? baselines.error.message
                  : "Unknown error"
              }
              title="Baselines could not be loaded"
            />
          </div>
        ) : baselines.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description="Open a device → Config tab → version actions → “Approve as baseline”. The approved snapshot becomes the golden reference for drift detection."
              icon={ShieldCheck}
              title="No baselines approved yet"
            />
          </div>
        ) : (
          <div className="max-h-[560px] overflow-y-auto">
            <div className="min-w-[980px]">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Device</TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                      Site
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">
                      Baseline
                    </TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                      Approved
                    </TableHead>
                    <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) xl:table-cell">
                      Note
                    </TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Drift</TableHead>
                    <TableHead className="h-(--density-row-h) px-(--density-cell-x) text-end">
                      Actions
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <button
                          aria-label={`Open ${row.hostname} device detail`}
                          className="text-sm font-medium text-foreground underline-offset-4 hover:text-primary hover:underline"
                          onClick={() =>
                            setActiveView("network.device-detail", { deviceId: row.deviceId })
                          }
                          type="button"
                        >
                          {row.hostname}
                        </button>
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground md:table-cell">
                        {row.siteCode ?? "—"}
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-col">
                          <span className="font-tech text-sm ltr-technical">
                            v{row.version}
                          </span>
                          <span
                            className="font-tech text-xs ltr-technical text-muted-foreground"
                            title={row.sha256}
                          >
                            {row.sha256.slice(0, 10)}…
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground lg:table-cell">
                        {formatDistanceToNow(new Date(row.approvedAt), {
                          addSuffix: true,
                        })}
                        {row.approvedBy ? ` · by ${row.approvedBy}` : ""}
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) max-w-0 px-(--density-cell-x) xl:table-cell">
                        <p
                          className="max-w-[260px] truncate text-xs text-muted-foreground"
                          title={row.note ?? undefined}
                        >
                          {row.note ?? "—"}
                        </p>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        {row.openDriftCount > 0 ? (
                          <button
                            className="inline-flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning-subtle px-2 py-0.5 text-xs font-medium text-warning transition-colors hover:bg-warning-subtle/70"
                            onClick={() => setActiveView("config.drift")}
                            title={`${row.openDriftCount} open drift record(s) — open the Drift view`}
                            type="button"
                          >
                            <TriangleAlert aria-hidden="true" className="size-3" />
                            {row.openDriftCount} open
                          </button>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 rounded-full border border-success/25 bg-success-subtle px-2 py-0.5 text-xs font-medium text-success">
                            <ShieldCheck aria-hidden="true" className="size-3" />
                            Clean
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-end">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            aria-label={`Diff baseline vs running config for ${row.hostname}`}
                            disabled={!row.current}
                            onClick={() => setDiffBaseline(row)}
                            size="sm"
                            variant="outline"
                          >
                            <FileDiff aria-hidden="true" />
                            {row.current
                              ? `vs running (v${row.current.version})`
                              : "vs running"}
                          </Button>
                          <Button
                            aria-label={`Revoke baseline for ${row.hostname}`}
                            disabled={revoke.isPending && revoke.variables === row.id}
                            onClick={() => setRevokeTarget(row)}
                            size="sm"
                            variant="ghost"
                          >
                            Revoke
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </SectionCard>

      {/* Devices without a baseline — cheap strip from the baselines meta */}
      {meta && meta.devicesWithoutBaseline > 0 && (
        <SectionCard
          description="These managed devices have no approved reference — drift cannot be evaluated until one is approved"
          title={`Devices without a baseline — ${meta.devicesWithoutBaseline}`}
        >
          <ul className="flex flex-wrap gap-2">
            {meta.withoutBaselineDevices.map((device) => (
              <li key={device.id}>
                <button
                  className="inline-flex items-center gap-1.5 rounded-full border bg-surface-subtle px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  onClick={() =>
                    setActiveView("network.device-detail", { deviceId: device.id })
                  }
                  type="button"
                >
                  <span className="font-tech ltr-technical">{device.hostname}</span>
                  <span className="text-muted-foreground">· open device</span>
                </button>
              </li>
            ))}
            {meta.devicesWithoutBaseline > meta.withoutBaselineDevices.length && (
              <li className="flex items-center text-xs text-muted-foreground">
                +{meta.devicesWithoutBaseline - meta.withoutBaselineDevices.length} more
              </li>
            )}
          </ul>
        </SectionCard>
      )}

      {/* Baseline vs running diff */}
      <Dialog
        onOpenChange={(open) => {
          if (!open) setDiffBaseline(null);
        }}
        open={diffBaseline !== null}
      >
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 sm:max-w-[min(95vw,1100px)]">
          <DialogHeader className="border-b">
            <DialogTitle className="font-tech ltr-technical">
              Baseline vs running — {diffBaseline?.hostname} v{diffBaseline?.version} → v
              {diffBaseline?.current?.version}
            </DialogTitle>
            <DialogDescription>
              Any visible difference here is exactly what a drift check would
              flag. Secrets are masked.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {diffBaseline && diffBaseline.current && (
              <ConfigDiff
                deviceId={diffBaseline.deviceId}
                from={diffBaseline.snapshotId}
                hostname={diffBaseline.hostname}
                maxHeightClass="max-h-[calc(90vh-12rem)]"
                to={diffBaseline.current.snapshotId}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation */}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        open={revokeTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke baseline of {revokeTarget?.hostname}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The approval row is deleted and{" "}
              <span className="font-tech ltr-technical">v{revokeTarget?.version}</span>{" "}
              returns to Historical (unless another approval still references
              it). The drift engine stops comparing this device until a new
              baseline is approved. Audit-recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-danger text-white hover:bg-danger/90")}
              onClick={() => {
                if (!revokeTarget) return;
                revoke.mutate(revokeTarget.id);
                setRevokeTarget(null);
              }}
            >
              Revoke baseline
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
