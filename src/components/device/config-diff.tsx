"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Columns2,
  EyeOff,
  FileCode2,
  LoaderCircle,
  Rows3,
  ShieldCheck,
} from "lucide-react";

import { useSnapshotDiff } from "@/hooks/api/use-snapshot-diff";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { maskSecretLine } from "@/lib/config/normalize";
import type { SnapshotDiffRow } from "@/lib/api-client";

/**
 * Config diff (Task 3-b): renders precomputed diff rows from
 * /api/v1/devices/[id]/snapshots/diff — the client never runs the diff
 * algorithm itself. Toolbar: raw|normalized mode, unified|split view
 * (split collapses to unified below md), stats chips, secret masking.
 */

const MAX_RENDER_ROWS = 1500;

type DiffMode = "raw" | "normalized";
type DiffView = "unified" | "split";

type LineTone = "equal" | "added" | "removed" | "changed";

interface VisualLine {
  key: string;
  aLine?: number;
  bLine?: number;
  text: string;
  tone: LineTone;
}

const TONE_BG: Record<LineTone, string> = {
  equal: "",
  added: "bg-success-subtle",
  removed: "bg-danger-subtle",
  changed: "bg-warning-subtle",
};

const TONE_BORDER: Record<LineTone, string> = {
  equal: "",
  added: "border-l-success",
  removed: "border-l-danger",
  changed: "border-l-warning",
};

function StatsChip({
  tone,
  label,
  value,
}: {
  tone: "success" | "danger" | "warning";
  label: string;
  value: number;
}) {
  const tones = {
    success: "border-success/25 bg-success-subtle text-success",
    danger: "border-danger/25 bg-danger-subtle text-danger",
    warning: "border-warning/25 bg-warning-subtle text-warning",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tabular-nums",
        tones[tone]
      )}
      title={`${value} ${label}`}
    >
      {label === "added" ? `+${value}` : label === "removed" ? `−${value}` : `~${value}`}{" "}
      {label}
    </span>
  );
}

/** Flatten API rows into git-style visual lines for the unified view. */
function toVisualLines(rows: SnapshotDiffRow[]): VisualLine[] {
  const lines: VisualLine[] = [];
  rows.forEach((row, index) => {
    if (row.type === "changed") {
      lines.push({
        key: `c-${index}-a`,
        aLine: row.aLine,
        text: row.aText ?? "",
        tone: "changed",
      });
      lines.push({
        key: `c-${index}-b`,
        bLine: row.bLine,
        text: row.bText ?? "",
        tone: "changed",
      });
      return;
    }
    lines.push({
      key: `${row.type}-${index}`,
      aLine: row.type === "added" ? undefined : row.aLine,
      bLine: row.type === "removed" ? undefined : row.bLine,
      text: row.aText ?? row.bText ?? "",
      tone: row.type,
    });
  });
  return lines;
}

function useIsWideScreen() {
  const [isWide, setIsWide] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setIsWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return isWide;
}

export interface ConfigDiffProps {
  deviceId: string;
  /** Snapshot version number or id (from). */
  from: string | number;
  /** Snapshot version number or id (to). */
  to: string | number;
  /** Optional hostname for the sticky header / labels. */
  hostname?: string;
  /** Max-height class for the scroll container (default max-h-[60vh]). */
  maxHeightClass?: string;
}

export function ConfigDiff({
  deviceId,
  from,
  to,
  hostname,
  maxHeightClass = "max-h-[60vh]",
}: ConfigDiffProps) {
  const [mode, setMode] = useState<DiffMode>("normalized");
  const [view, setView] = useState<DiffView>("unified");
  const [mask, setMask] = useState(true);
  const isWide = useIsWideScreen();

  const diff = useSnapshotDiff(deviceId, from, to, mode);

  // Split is physically impossible on narrow screens — force unified.
  const effectiveView: DiffView = isWide ? view : "unified";

  const data = diff.data;
  const stats = data?.stats;

  const displayRows = useMemo(() => {
    if (!data) return [];
    const rows = data.rows.slice(0, MAX_RENDER_ROWS);
    if (!mask) return rows;
    return rows.map((row) => ({
      ...row,
      aText: row.aText === undefined ? undefined : maskSecretLine(row.aText),
      bText: row.bText === undefined ? undefined : maskSecretLine(row.bText),
    }));
  }, [data, mask]);

  const visualLines = useMemo(
    () => (effectiveView === "unified" ? toVisualLines(displayRows) : []),
    [effectiveView, displayRows]
  );

  const truncated =
    (data?.rows.length ?? 0) > MAX_RENDER_ROWS;

  const versionLabel = `${hostname ? `${hostname} · ` : ""}v${data?.from.version ?? from} → v${data?.to.version ?? to}`;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="flex min-w-0 items-center gap-1.5 font-tech text-sm font-medium ltr-technical">
          <FileCode2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{versionLabel}</span>
        </p>

        <div className="flex flex-wrap items-center gap-2 md:ms-auto">
          <ToggleGroup
            aria-label="Diff text mode"
            onValueChange={(value) => value && setMode(value as DiffMode)}
            size="sm"
            type="single"
            value={mode}
            variant="outline"
          >
            <ToggleGroupItem aria-label="Raw text mode" value="raw">
              Raw
            </ToggleGroupItem>
            <ToggleGroupItem aria-label="Normalized text mode" value="normalized">
              Normalized
            </ToggleGroupItem>
          </ToggleGroup>

          {isWide ? (
            <ToggleGroup
              aria-label="Diff layout"
              onValueChange={(value) => value && setView(value as DiffView)}
              size="sm"
              type="single"
              value={effectiveView}
              variant="outline"
            >
              <ToggleGroupItem aria-label="Unified view" value="unified">
                <Rows3 aria-hidden="true" className="size-3.5" />
                Unified
              </ToggleGroupItem>
              <ToggleGroupItem aria-label="Split view" value="split">
                <Columns2 aria-hidden="true" className="size-3.5" />
                Split
              </ToggleGroupItem>
            </ToggleGroup>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <ToggleGroup
                    aria-label="Diff layout"
                    size="sm"
                    type="single"
                    value="unified"
                    variant="outline"
                  >
                    <ToggleGroupItem disabled value="unified">
                      <Rows3 aria-hidden="true" className="size-3.5" />
                      Unified
                    </ToggleGroupItem>
                  </ToggleGroup>
                </span>
              </TooltipTrigger>
              <TooltipContent>Split view needs a wider screen</TooltipContent>
            </Tooltip>
          )}

          {stats && (
            <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
              <StatsChip label="added" tone="success" value={stats.added} />
              <StatsChip label="removed" tone="danger" value={stats.removed} />
              <StatsChip label="changed" tone="warning" value={stats.changed} />
            </div>
          )}

          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              aria-label="Mask secret values"
              checked={mask}
              onCheckedChange={setMask}
            />
            <EyeOff aria-hidden="true" className="size-3.5" />
            Mask
          </label>
        </div>
      </div>

      {/* Body */}
      {diff.isLoading ? (
        <div
          aria-busy="true"
          className="flex flex-col gap-2 rounded-lg border bg-surface-subtle p-4"
        >
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              className="h-5 animate-pulse rounded-sm bg-muted/60"
              key={index}
              style={{ width: `${88 - ((index * 13) % 45)}%` }}
            />
          ))}
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
            Computing diff…
          </p>
        </div>
      ) : diff.isError ? (
        <ErrorState
          onRetry={() => void diff.refetch()}
          reason={diff.error.message}
          title="The configuration diff could not be computed"
        />
      ) : data?.identical ? (
        <EmptyState
          className="border-success/30 bg-success-subtle/40"
          description={`Both snapshots carry the same content (sha256 ${data.from.sha256.slice(0, 12)}…).`}
          icon={ShieldCheck}
          title="No differences — snapshots are byte-identical (same sha256)"
        />
      ) : (data?.rows.length ?? 0) === 0 ? (
        <EmptyState
          description={
            mode === "normalized"
              ? "The configurations differ only outside the compared text (volatile lines are ignored in normalized mode)."
              : "No line-level differences were found between the two versions."
          }
          icon={ShieldCheck}
          title="No differences found"
        />
      ) : effectiveView === "unified" ? (
        <UnifiedDiff
          fromVersion={data!.from.version}
          hostname={hostname}
          lines={visualLines}
          maxHeightClass={maxHeightClass}
          toVersion={data!.to.version}
        />
      ) : (
        <SplitDiff
          fromVersion={data!.from.version}
          maxHeightClass={maxHeightClass}
          rows={displayRows}
          toVersion={data!.to.version}
        />
      )}

      {truncated && (
        <p className="text-xs text-muted-foreground">
          Showing first {MAX_RENDER_ROWS} changed rows — open a narrower pair or use
          normalized mode for the full picture.
        </p>
      )}

      {mode === "normalized" && data && !(data.normalized.from && data.normalized.to) && (
        <p className="text-xs text-muted-foreground">
          {data.normalized.from || data.normalized.to
            ? "Normalized text was computed on the fly for the newest of these snapshots (none was stored at capture time)."
            : "Normalized text was computed on the fly for both snapshots (none was stored at capture time)."}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Unified view — single column, two line-number gutters (a / b)       */
/* ------------------------------------------------------------------ */

function UnifiedDiff({
  lines,
  fromVersion,
  toVersion,
  hostname,
  maxHeightClass,
}: {
  lines: VisualLine[];
  fromVersion: number;
  toVersion: number;
  hostname?: string;
  maxHeightClass: string;
}) {
  return (
    // dir="ltr" + text-left: diff content and the +/- gutter columns are
    // technical blocks that must never mirror under RTL (Task 8-a).
    <div
      className={cn(
        "overflow-auto rounded-lg border bg-card text-left font-tech text-[13px] leading-relaxed",
        maxHeightClass
      )}
      dir="ltr"
    >
      <table className="w-full border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            <th
              className="border-b bg-surface-subtle px-3 py-2 text-start text-xs font-medium text-muted-foreground"
              colSpan={3}
            >
              <span className="ltr-technical">
                {hostname ? `${hostname} · ` : ""}v{fromVersion} → v{toVersion}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className={TONE_BG[line.tone]}>
              <td
                className={cn(
                  "w-10 select-none border-e border-e-border/60 pe-2 text-end align-top text-muted-foreground/70",
                  line.tone !== "equal" &&
                    `border-l-2 ${TONE_BORDER[line.tone]}`
                )}
              >
                {line.aLine ?? ""}
              </td>
              <td
                aria-hidden="true"
                className="w-10 select-none border-e border-e-border/60 pe-2 text-end align-top text-muted-foreground/70"
              >
                {line.bLine ?? ""}
              </td>
              <td
                className={cn(
                  "whitespace-pre align-top text-foreground",
                  line.tone === "removed" && "text-danger",
                  line.tone === "added" && "text-success",
                  line.tone === "changed" && "text-warning"
                )}
              >
                {line.text.length === 0 ? " " : line.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Split view — removed side | added side, aligned row-by-row          */
/* ------------------------------------------------------------------ */

function SplitDiff({
  rows,
  fromVersion,
  toVersion,
  maxHeightClass,
}: {
  rows: SnapshotDiffRow[];
  fromVersion: number;
  toVersion: number;
  maxHeightClass: string;
}) {
  return (
    // dir="ltr" + text-left: the removed|added split columns never mirror
    // under RTL (Task 8-a).
    <div
      className={cn(
        "overflow-auto rounded-lg border bg-card text-left font-tech text-[13px] leading-relaxed",
        maxHeightClass
      )}
      dir="ltr"
    >
      <table className="w-full table-fixed border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            <th className="w-1/2 border-b border-e bg-surface-subtle px-3 py-2 text-start text-xs font-medium text-muted-foreground">
              <span className="inline-flex items-center gap-1 ltr-technical">
                Removed / from · v{fromVersion}
              </span>
            </th>
            <th className="w-1/2 border-b bg-surface-subtle px-3 py-2 text-start text-xs font-medium text-muted-foreground">
              <span className="inline-flex items-center gap-1 ltr-technical">
                Added / to · v{toVersion} <ArrowRight aria-hidden="true" className="hidden size-3" />
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const leftTone =
              row.type === "removed" ? "removed" : row.type === "changed" ? "changed" : "equal";
            const rightTone =
              row.type === "added" ? "added" : row.type === "changed" ? "changed" : "equal";
            return (
              <tr key={`s-${index}`}>
                <td
                  className={cn(
                    "w-1/2 border-e border-e-border/60 align-top",
                    TONE_BG[leftTone],
                    leftTone !== "equal" && `border-l-2 ${TONE_BORDER[leftTone]}`
                  )}
                >
                  <span className="flex">
                    <span
                      aria-hidden="true"
                      className="w-9 shrink-0 select-none border-e border-e-border/60 pe-2 text-end text-muted-foreground/70"
                    >
                      {row.aLine ?? ""}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 whitespace-pre-wrap break-all ps-2",
                        leftTone === "removed" && "text-danger",
                        leftTone === "changed" && "text-warning"
                      )}
                    >
                      {row.aText !== undefined ? (row.aText.length === 0 ? " " : row.aText) : " "}
                    </span>
                  </span>
                </td>
                <td
                  className={cn(
                    "w-1/2 align-top",
                    TONE_BG[rightTone],
                    rightTone !== "equal" && `border-l-2 ${TONE_BORDER[rightTone]}`
                  )}
                >
                  <span className="flex">
                    <span
                      aria-hidden="true"
                      className="w-9 shrink-0 select-none border-e border-e-border/60 pe-2 text-end text-muted-foreground/70"
                    >
                      {row.bLine ?? ""}
                    </span>
                    <span
                      className={cn(
                        "min-w-0 flex-1 whitespace-pre-wrap break-all ps-2",
                        rightTone === "added" && "text-success",
                        rightTone === "changed" && "text-warning"
                      )}
                    >
                      {row.bText !== undefined ? (row.bText.length === 0 ? " " : row.bText) : " "}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
