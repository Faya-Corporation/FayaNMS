"use client";

import { useMemo } from "react";
import { formatDistanceToNow } from "date-fns";
import { GitBranch, History } from "lucide-react";

import { useDeviceSnapshots } from "@/hooks/api/use-device-detail";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  SNAPSHOT_SOURCE,
  SNAPSHOT_STATUS,
  getStatusConfig,
} from "@/lib/domain/status";
import { cn } from "@/lib/utils";
import { ConfigViewer } from "@/components/device/config-viewer";

interface DeviceConfigTabProps {
  deviceId: string;
  selectedSnapshotId: string | null;
  onSelectSnapshot: (snapshotId: string) => void;
}

/**
 * Config tab (Phase 2): version history on the left, read-only viewer on
 * the right. Selecting a version renders its raw text in the shared
 * ConfigViewer (mask/wrap/search/fullscreen). Diff + normalization tooling
 * is Phase 3 and intentionally out of scope.
 */
export function DeviceConfigTab({
  deviceId,
  selectedSnapshotId,
  onSelectSnapshot,
}: DeviceConfigTabProps) {
  const snapshots = useDeviceSnapshots(deviceId);

  const versions = useMemo(
    () =>
      [...(snapshots.data?.data ?? [])].sort(
        (a, b) => b.version - a.version
      ),
    [snapshots.data]
  );

  const selected = useMemo(
    () => versions.find((snapshot) => snapshot.id === selectedSnapshotId) ?? null,
    [versions, selectedSnapshotId]
  );

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

  return (
    <div className="grid grid-cols-1 gap-4 pt-2 xl:grid-cols-[280px_1fr]">
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
            return (
              <li key={snapshot.id}>
                <button
                  aria-pressed={isSelected}
                  className={cn(
                    "flex w-full flex-col gap-1 border-b px-4 py-2.5 text-start transition-colors last:border-b-0",
                    isSelected
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
                    {snapshot.source === "BASELINE" && (
                      <GitBranch
                        aria-hidden="true"
                        className="ms-auto size-3.5 text-brand-accent"
                      />
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
            <ConfigViewer snapshot={selected} />
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
    </div>
  );
}
