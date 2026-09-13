"use client";

import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  GitBranch,
  GitCompareArrows,
  History,
  MoreHorizontal,
  Pin,
  ShieldAlert,
  ShieldCheck,
  Undo2,
  X,
} from "lucide-react";

import { useDevice, useDeviceSnapshots } from "@/hooks/api/use-device-detail";
import { useApproveBaseline } from "@/hooks/api/use-baselines";
import { apiFetch, apiRequest, type DeviceSnapshotRow, type RestoreSnapshotResult } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { HighRiskActionDialog } from "@/components/domain/high-risk-action-dialog";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  SNAPSHOT_SOURCE,
  SNAPSHOT_STATUS,
  getStatusConfig,
} from "@/lib/domain/status";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ConfigViewer } from "@/components/device/config-viewer";
import { ConfigDiff } from "@/components/device/config-diff";
import { useNavigationStore } from "@/stores/navigation";

interface DeviceConfigTabProps {
  deviceId: string;
  selectedSnapshotId: string | null;
  onSelectSnapshot: (snapshotId: string) => void;
}

/**
 * Config tab (Phase 2 viewer + Phase 3-b compare + Phase 3-c actions):
 * version history on the left, read-only viewer on the right. Compare
 * model: pick a reference version, then a second version — a floating
 * compare bar opens the diff in a side Sheet. Per-version actions add the
 * guarded "Approve as baseline" and "Restore this version" flows.
 */
export function DeviceConfigTab({
  deviceId,
  selectedSnapshotId,
  onSelectSnapshot,
}: DeviceConfigTabProps) {
  const snapshots = useDeviceSnapshots(deviceId);
  const device = useDevice(deviceId);

  // Compare selection state (reference → target), plus the diff Sheet.
  const [compareRefId, setCompareRefId] = useState<string | null>(null);
  const [compareTargetId, setCompareTargetId] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);

  // Reset transient state when the tab is reused for another device
  // (same prev-id pattern as the parent detail view).
  const [prevDeviceId, setPrevDeviceId] = useState(deviceId);
  if (prevDeviceId !== deviceId) {
    setPrevDeviceId(deviceId);
    setCompareRefId(null);
    setCompareTargetId(null);
    setDiffOpen(false);
  }

  const versions = useMemo(
    () =>
      [...(snapshots.data?.data ?? [])].sort(
        (a, b) => b.version - a.version
      ),
    [snapshots.data]
  );

  // Keep the compare selection valid when the history refreshes (e.g. a
  // retention prune removed a picked snapshot). Render-time adjustment on
  // the version-id list — the documented alternative to effect-based resets.
  const pickedIdsKey = versions.map((s) => s.id).join("|");
  const [prevPickedIdsKey, setPrevPickedIdsKey] = useState(pickedIdsKey);
  if (prevPickedIdsKey !== pickedIdsKey) {
    setPrevPickedIdsKey(pickedIdsKey);
    const ids = new Set(versions.map((s) => s.id));
    if (compareRefId && !ids.has(compareRefId)) setCompareRefId(null);
    if (compareTargetId && !ids.has(compareTargetId)) setCompareTargetId(null);
  }

  const selected = useMemo(
    () => versions.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null,
    [versions, selectedSnapshotId]
  );

  const refSnapshot = useMemo(
    () => versions.find((s) => s.id === compareRefId) ?? null,
    [versions, compareRefId]
  );
  const targetSnapshot = useMemo(
    () => versions.find((s) => s.id === compareTargetId) ?? null,
    [versions, compareTargetId]
  );

  const newest = versions[0] ?? null;
  const baseline = useMemo(
    () => versions.find((s) => s.status === "BASELINE") ?? null,
    [versions]
  );

  /** Order the pair oldest → newest so diffs always read left-to-right. */
  const openDiff = (first: { id: string; version: number }, second: { id: string; version: number }) => {
    const [a, b] =
      first.version <= second.version ? [first, second] : [second, first];
    setCompareRefId(a.id);
    setCompareTargetId(b.id);
    setDiffOpen(true);
  };

  const handleComparePick = (snapshotId: string) => {
    if (!compareRefId || compareRefId === snapshotId) {
      setCompareRefId((current) => (current === snapshotId ? null : snapshotId));
      setCompareTargetId(null);
      return;
    }
    setCompareTargetId((current) =>
      current === snapshotId ? null : snapshotId
    );
  };

  const vendorKey = device.data?.vendor.key ?? "generic";

  /* ── Phase 3-c: baseline + restore actions ─────────────────────────── */
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const [approveTarget, setApproveTarget] = useState<DeviceSnapshotRow | null>(null);
  const [approveNote, setApproveNote] = useState("");
  const [restoreTarget, setRestoreTarget] = useState<DeviceSnapshotRow | null>(null);
  // SAFE-007 honesty: restore changes on LIVE_SSH devices fail closed at the
  // engine until snapshot-exact restore ships (SAFE-008/009) — the dialog
  // states this up front instead of letting an approver discover it at run time.
  const isLiveDevice =
    (device.data?.dataSource ?? "SIMULATOR").trim().toUpperCase() === "LIVE_SSH";

  const approve = useApproveBaseline();

  // Open drift count for the restore dialog risk preview — only fetched
  // while the restore dialog is open (meta.total = device+status filtered).
  const deviceDrift = useQuery({
    queryKey: ["drift", { deviceId, status: "OPEN", scope: "restore-preview" }],
    queryFn: async () => {
      const envelope = await apiRequest<unknown[]>(
        `/api/v1/drift?deviceId=${encodeURIComponent(deviceId)}&status=OPEN&pageSize=1`
      );
      return envelope.meta as unknown as { total: number };
    },
    enabled: restoreTarget !== null,
  });
  const openDriftCount = deviceDrift.data?.total ?? 0;

  const restore = useMutation({
    mutationFn: (payload: { snapshotId: string; confirmHostname: string }) =>
      apiFetch<RestoreSnapshotResult>(
        `/api/v1/devices/${deviceId}/snapshots/${payload.snapshotId}/restore`,
        {
          method: "POST",
          body: JSON.stringify({
            confirmHostname: payload.confirmHostname,
          }),
        }
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["changes"] });
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast({
        title: `${result.change.number} created`,
        description: result.message,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Restore request failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (snapshots.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 pt-2 xl:grid-cols-[280px_1fr]">
        <div className="h-72 animate-pulse rounded-xl bg-muted/60" />
        <div className="h-72 animate-pulse rounded-xl bg-muted/60" />
      </div>
    );
  }

  if (snapshots.isError) {
    return (
      <div className="pt-2">
        <ErrorState
          onRetry={() => void snapshots.refetch()}
          reason={snapshots.error.message}
          title="Configuration history could not be loaded"
        />
      </div>
    );
  }

  if (versions.length === 0) {
    return (
      <div className="pt-2">
        <EmptyState
          description="Run a backup from the device header or the Backups tab to capture the first configuration version."
          icon={History}
          title="No configuration versions yet"
        />
      </div>
    );
  }

  const diffReady = Boolean(refSnapshot && targetSnapshot);
  const compareBarLabel = refSnapshot
    ? `v${refSnapshot.version} → ${targetSnapshot ? `v${targetSnapshot.version}` : "…"}`
    : "";

  return (
    <div className="relative grid grid-cols-1 gap-4 pt-2 xl:grid-cols-[280px_1fr]">
      {/* Version list */}
      <SectionCard
        className="xl:max-h-[560px]"
        contentClassName="p-0"
        description={`${versions.length} versions on record`}
        title="Version History"
      >
        <ul
          aria-label="Configuration versions"
          className="max-h-96 overflow-y-auto xl:max-h-[460px]"
        >
          {versions.map((snapshot) => {
            const source = getStatusConfig(SNAPSHOT_SOURCE, snapshot.source);
            const status = getStatusConfig(SNAPSHOT_STATUS, snapshot.status);
            const isSelected = snapshot.id === selected?.id;
            const isRef = snapshot.id === compareRefId;
            const isTarget = snapshot.id === compareTargetId;
            const isPicked = isRef || isTarget;
            return (
              <li
                className={cn(
                  "border-b last:border-b-0",
                  isPicked && "bg-brand-accent/10"
                )}
                key={snapshot.id}
              >
                <div className="flex items-stretch">
                  <button
                    aria-pressed={isSelected}
                    className={cn(
                      "flex min-w-0 flex-1 flex-col gap-1 px-4 py-2.5 text-start transition-colors",
                      isSelected && !isPicked
                        ? "bg-primary-subtle/60"
                        : "hover:bg-surface-subtle"
                    )}
                    onClick={() => onSelectSnapshot(snapshot.id)}
                    type="button"
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className="font-tech text-sm font-medium ltr-technical">
                        v{snapshot.version}
                      </span>
                      <StatusBadge config={status} withIcon={false} />
                      {snapshot.status === "BASELINE" && (
                        <GitBranch
                          aria-hidden="true"
                          className="ms-auto size-3.5 text-brand-accent"
                        />
                      )}
                      {isRef && (
                        <span className="ms-auto rounded-full border border-brand-accent/40 bg-brand-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-brand-accent">
                          {isTarget ? "A→B" : "ref"}
                        </span>
                      )}
                    </span>
                    <span className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{source.label}</span>
                      <span className="tabular-nums">
                        {formatDistanceToNow(new Date(snapshot.createdAt), {
                          addSuffix: true,
                        })}
                      </span>
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {(snapshot.sizeBytes / 1024).toFixed(1)} KB ·{" "}
                      <span className="font-tech ltr-technical">
                        {snapshot.sha256.slice(0, 10)}…
                      </span>
                    </span>
                  </button>
                  <div className="flex flex-col items-center justify-center gap-0.5 border-s border-border/60 px-1.5">
                    <Button
                      aria-label={
                        isPicked
                          ? `Remove v${snapshot.version} from comparison`
                          : `Compare with v${snapshot.version}`
                      }
                      aria-pressed={isPicked}
                      className="size-7"
                      onClick={() => handleComparePick(snapshot.id)}
                      size="icon"
                      title={`Compare with v${snapshot.version}`}
                      variant={isPicked ? "default" : "ghost"}
                    >
                      <GitCompareArrows aria-hidden="true" className="size-3.5" />
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          aria-label={`More actions for v${snapshot.version}`}
                          className="size-7"
                          size="icon"
                          variant="ghost"
                        >
                          <MoreHorizontal aria-hidden="true" className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuLabel className="font-tech ltr-technical">
                          v{snapshot.version}
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => {
                            setCompareRefId(snapshot.id);
                            setCompareTargetId(null);
                          }}
                        >
                          <Pin aria-hidden="true" className="size-3.5" />
                          Set as reference
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!newest || newest.id === snapshot.id}
                          onClick={() => {
                            if (newest && newest.id !== snapshot.id) {
                              openDiff(snapshot, newest);
                            }
                          }}
                        >
                          <GitCompareArrows aria-hidden="true" className="size-3.5" />
                          Compare with latest (v{newest?.version})
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!baseline || baseline.id === snapshot.id}
                          onClick={() => {
                            if (baseline && baseline.id !== snapshot.id) {
                              openDiff(snapshot, baseline);
                            }
                          }}
                        >
                          <GitBranch aria-hidden="true" className="size-3.5" />
                          Compare with baseline (v{baseline?.version})
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          disabled={snapshot.status === "BASELINE"}
                          onClick={() => {
                            setApproveNote("");
                            setApproveTarget(snapshot);
                          }}
                        >
                          <ShieldCheck aria-hidden="true" className="size-3.5" />
                          {snapshot.status === "BASELINE"
                            ? "Current baseline"
                            : "Approve as baseline"}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setRestoreTarget(snapshot);
                          }}
                        >
                          <Undo2 aria-hidden="true" className="size-3.5" />
                          Restore this version
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      {/* Viewer */}
      <div>
        {selected ? (
          <SectionCard
            contentClassName="p-4"
            title={`Config Viewer — v${selected.version}`}
          >
            <ConfigViewer snapshot={selected} vendorKey={vendorKey} />
          </SectionCard>
        ) : (
          <EmptyState
            className="h-full"
            description="Select a version from the history to inspect its configuration text."
            icon={History}
            title="No version selected"
          />
        )}
      </div>

      {/* Floating compare bar */}
      {compareBarLabel && (
        <div
          className="sticky bottom-4 z-20 mt-2 flex w-fit flex-wrap items-center gap-2 rounded-full border bg-card px-3 py-1.5 shadow-e3 xl:col-start-2"
          role="status"
        >
          <span className="font-tech text-sm font-medium ltr-technical">
            {compareBarLabel}
          </span>
          {!diffReady && (
            <span className="text-xs text-muted-foreground">
              Pick a second version to diff
            </span>
          )}
          <Button
            disabled={!diffReady}
            onClick={() => {
              if (refSnapshot && targetSnapshot) {
                openDiff(refSnapshot, targetSnapshot);
              }
            }}
            size="sm"
          >
            <ArrowRight aria-hidden="true" />
            Diff
          </Button>
          <Button
            aria-label="Clear comparison selection"
            onClick={() => {
              setCompareRefId(null);
              setCompareTargetId(null);
            }}
            size="icon"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* Diff sheet */}
      <Sheet onOpenChange={setDiffOpen} open={diffOpen}>
        <SheetContent
          className="flex w-[min(90vw,900px)] flex-col gap-0 sm:max-w-[min(90vw,900px)]"
          side="right"
        >
          <SheetHeader className="border-b">
            <SheetTitle className="font-tech ltr-technical">
              Config diff — {device.data?.hostname ?? ""}{" "}
              {refSnapshot && targetSnapshot
                ? `v${Math.min(refSnapshot.version, targetSnapshot.version)} → v${Math.max(refSnapshot.version, targetSnapshot.version)}`
                : ""}
            </SheetTitle>
            <SheetDescription>
              {diffReady
                ? "Secrets are masked; switch to raw mode to see the untouched text."
                : ""}
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {diffReady && refSnapshot && targetSnapshot && (
              <ConfigDiff
                deviceId={deviceId}
                from={
                  refSnapshot.version <= targetSnapshot.version
                    ? refSnapshot.version
                    : targetSnapshot.version
                }
                hostname={device.data?.hostname}
                maxHeightClass="max-h-[calc(100vh-14rem)]"
                to={
                  refSnapshot.version <= targetSnapshot.version
                    ? targetSnapshot.version
                    : refSnapshot.version
                }
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Approve as baseline */}
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) setApproveTarget(null);
        }}
        open={approveTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Approve v{approveTarget?.version} as baseline?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This snapshot becomes the golden reference for{" "}
              <span className="font-tech ltr-technical">
                {device.data?.hostname ?? "this device"}
              </span>
              . The previous baseline snapshot (if any) is demoted to
              Historical, and future drift checks compare running configs
              against this version. Audit-recorded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            aria-label="Baseline note (optional)"
            autoComplete="off"
            maxLength={500}
            onChange={(event) => setApproveNote(event.target.value)}
            placeholder="Note (optional) — e.g. why this state is approved"
            value={approveNote}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={approve.isPending}
              onClick={(event) => {
                event.preventDefault(); // keep the dialog open while pending
                if (!approveTarget) return;
                approve.mutate(
                  {
                    deviceId,
                    snapshotId: approveTarget.id,
                    note: approveNote.trim() || undefined,
                  },
                  {
                    onSettled: () => setApproveTarget(null),
                  }
                );
              }}
            >
              <ShieldCheck aria-hidden="true" />
              Approve as baseline
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Guarded restore — HighRiskActionDialog */}
      <HighRiskActionDialog
        confirmLabel="Create restore change"
        confirmPhrase={device.data?.hostname ?? ""}
        confirmHint={device.data?.hostname ?? "hostname"}
        description="Restoring pushes a stored configuration back onto the device. This is never executed directly — a tracked EMERGENCY change is created and run by the change engine. Approval policy (SoD-enforced) always applies: there is no auto-approval path."
        impact={[
          {
            label: "Device",
            value: (
              <span className="font-tech ltr-technical">
                {device.data?.hostname ?? "—"}
              </span>
            ),
          },
          {
            label: "Target version",
            value: (
              <span className="font-tech ltr-technical">
                v{restoreTarget?.version} · {restoreTarget?.sha256.slice(0, 10)}…
              </span>
            ),
          },
          {
            label: "Current version",
            value: (
              <span className="font-tech ltr-technical">
                v{newest?.version ?? "—"}
              </span>
            ),
          },
          {
            label: "Open drift records",
            value: <span className="tabular-nums">{openDriftCount}</span>,
          },
          {
            label: "Estimated risk",
            value: (
              <RestoreRiskChip
                criticality={device.data?.criticality ?? "MEDIUM"}
                isLatest={restoreTarget?.version === newest?.version}
                openDrifts={openDriftCount}
              />
            ),
          },
        ]}
        onConfirm={async () => {
          if (!restoreTarget) return null;
          const result = await restore.mutateAsync({
            snapshotId: restoreTarget.id,
            confirmHostname: device.data?.hostname ?? "",
          });
          return (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border bg-surface-subtle p-3 text-sm">
                <p className="font-medium">
                  Change{" "}
                  <span className="font-tech ltr-technical">{result.change.number}</span>{" "}
                  created
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{result.message}</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Type: EMERGENCY · Risk score {result.change.riskScore} ·{" "}
                  {result.change.riskLevel.toLowerCase()} risk
                </p>
              </div>
              <Button
                onClick={() =>
                  setActiveView("changes.all")
                }
                size="sm"
                variant="outline"
              >
                Open Changes queue
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          );
        }}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
        open={restoreTarget !== null}
        title={`Restore ${device.data?.hostname ?? "device"} to v${restoreTarget?.version ?? ""}`}
      >
        {isLiveDevice && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <ShieldAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
            <span>
              <span className="font-medium">LIVE device — restore execution is NOT CERTIFIED yet.</span>{" "}
              Until snapshot-exact restore ships (SAFE-008/009), the engine refuses to apply a
              restore change to LIVE_SSH devices fail-closed (no device is contacted). The
              change can still be filed and approved, but execution will fail by design.
            </span>
          </div>
        )}
      </HighRiskActionDialog>
    </div>
  );
}

/** Client-side mirror of the restore risk heuristic (server recomputes). */
function estimateRestoreRisk(
  isLatest: boolean,
  openDrifts: number,
  criticality: string
): number {
  let score = 0;
  if (!isLatest) score += 45;
  if (openDrifts > 0) score += 15;
  if (criticality === "CRITICAL") score += 10;
  return Math.min(100, Math.max(0, score));
}

function riskLevelFor(score: number): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (score >= 71) return "CRITICAL";
  if (score >= 41) return "HIGH";
  if (score >= 21) return "MEDIUM";
  return "LOW";
}

function RestoreRiskChip({
  isLatest,
  openDrifts,
  criticality,
}: {
  isLatest: boolean;
  openDrifts: number;
  criticality: string;
}) {
  const score = estimateRestoreRisk(isLatest, openDrifts, criticality);
  const level = riskLevelFor(score);
  const tone: Record<string, string> = {
    LOW: "border-success/25 bg-success-subtle text-success",
    MEDIUM: "border-warning/25 bg-warning-subtle text-warning",
    HIGH: "border-danger-orange/25 bg-danger-orange-subtle text-danger-orange",
    CRITICAL: "border-danger/25 bg-danger-subtle text-danger",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        tone[level]
      )}
    >
      {level.toLowerCase()} risk ({score})
    </span>
  );
}
