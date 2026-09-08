"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { format, formatDistanceToNow } from "date-fns";
import {
  Ban,
  ChevronDown,
  ChevronRight,
  RotateCcw,
} from "lucide-react";

import { useCancelJob, useJobs, useRetryJob } from "@/hooks/api/use-jobs";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { JobStatusBadge } from "@/components/domain/job-status-badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { JobRow } from "@/lib/api-client";

interface JobCenterContentProps {
  pageSize?: number;
  className?: string;
  /** Auto refresh is on by default in the sheet, toggleable in the Jobs view. */
  autoRefresh: boolean;
  onAutoRefreshChange?: (enabled: boolean) => void;
  footerSlot?: React.ReactNode;
}

/** Status filter chips — the FAILED chip folds DEAD (retries exhausted) in. */
const STATUS_FILTERS = [
  { key: "ALL", param: undefined },
  { key: "RUNNING", param: "RUNNING" },
  { key: "QUEUED", param: "QUEUED" },
  { key: "SUCCEEDED", param: "SUCCEEDED" },
  { key: "FAILED", param: "FAILED,DEAD" },
] as const;

/** Every job type the platform can execute (worker + Next engines). */
const JOB_TYPES = [
  "CONFIG_BACKUP",
  "CONFIG_RESTORE",
  "CONFIG_APPLY",
  "VALIDATION",
  "DISCOVERY",
  "INVENTORY_POLL",
  "METRIC_POLL",
  "REPORT_GENERATION",
  "NOTIFICATION",
  "CHANGE_EXECUTE",
  "DRIFT_CHECK",
  "ALERT_EVALUATION",
  "METRIC_RETENTION",
  "REPORT_RUN",
  "FIRMWARE_UPGRADE",
] as const;

const CANCELLABLE = new Set(["QUEUED", "RUNNING"]);
const RETRYABLE = new Set(["FAILED", "DEAD"]);

/** Localized type labels with an honest fallback for unknown types. */
function jobTypeLabel(
  type: string,
  t: (key: string) => string
): string {
  const map: Record<string, string> = {
    CONFIG_BACKUP: "type.CONFIG_BACKUP",
    CONFIG_RESTORE: "type.CONFIG_RESTORE",
    CONFIG_APPLY: "type.CONFIG_APPLY",
    VALIDATION: "type.VALIDATION",
    DISCOVERY: "type.DISCOVERY",
    INVENTORY_POLL: "type.INVENTORY_POLL",
    METRIC_POLL: "type.METRIC_POLL",
    REPORT_GENERATION: "type.REPORT_GENERATION",
    NOTIFICATION: "type.NOTIFICATION",
    CHANGE_EXECUTE: "type.CHANGE_EXECUTE",
    DRIFT_CHECK: "type.DRIFT_CHECK",
    ALERT_EVALUATION: "type.ALERT_EVALUATION",
    METRIC_RETENTION: "type.METRIC_RETENTION",
    REPORT_RUN: "type.REPORT_RUN",
    FIRMWARE_UPGRADE: "type.FIRMWARE_UPGRADE",
  };
  const key = map[type];
  return key ? t(key) : type;
}

function formatStamp(value: string | null): string {
  return value ? format(new Date(value), "MMM d, HH:mm:ss") : "—";
}

/** Pretty-printed JSON block — technical content, always LTR. */
function JsonBlock({ label, value }: { label: string; value: string | null }) {
  let pretty: string | null = null;
  if (value) {
    try {
      pretty = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      pretty = value;
    }
  }
  return (
    <div className="min-w-0 rounded-md border bg-surface-subtle">
      <p className="border-b px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </p>
      {pretty ? (
        <pre
          className="max-h-40 overflow-auto p-2.5 font-tech text-[11px] leading-relaxed ltr-technical"
          dir="ltr"
        >
          {pretty}
        </pre>
      ) : (
        <p className="px-2.5 py-2 text-xs text-muted-foreground">—</p>
      )}
    </div>
  );
}

/**
 * One expandable job row: summary line (status, type, correlation, target,
 * attempt counter, progress) + chevron-revealed detail panel with the
 * payload/result/error JSON, timestamps and cancel/retry actions.
 */
const JobItem = function JobItem({
  job,
  expanded,
  onToggle,
  onCancel,
  onRetry,
  cancelPending,
  retryPending,
}: {
  job: JobRow;
  expanded: boolean;
  onToggle: () => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  cancelPending: boolean;
  retryPending: boolean;
}) {
  const t = useTranslations("jobs");
  const cancellable = CANCELLABLE.has(job.status);
  const retryable = RETRYABLE.has(job.status);

  return (
    <li className="rounded-lg border bg-card p-3 shadow-e1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? t("collapseAria") : t("expandAria")} ${job.correlationId}`}
          className="-ms-1 flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onToggle}
          type="button"
        >
          {expanded ? (
            <ChevronDown aria-hidden="true" className="size-4" />
          ) : (
            <ChevronRight aria-hidden="true" className="size-4 rtl:-scale-x-100" />
          )}
        </button>
        <JobStatusBadge value={job.status} />
        <span className="text-sm font-medium">{jobTypeLabel(job.type, t)}</span>
        <span className="ms-auto text-[11px] text-muted-foreground">
          {job.finishedAt
            ? formatDistanceToNow(new Date(job.finishedAt), {
                addSuffix: true,
              })
            : t("queuedRel", {
                time: formatDistanceToNow(new Date(job.createdAt), {
                  addSuffix: true,
                }),
              })}
        </span>
        {(cancellable || retryable) && (
          <span className="flex shrink-0 items-center gap-1">
            {cancellable && (
              <Button
                aria-label={t("cancelAria", { correlation: job.correlationId })}
                disabled={cancelPending}
                onClick={() => onCancel(job.id)}
                size="sm"
                variant="ghost"
              >
                <Ban aria-hidden="true" />
                {t("actions.cancel")}
              </Button>
            )}
            {retryable && (
              <Button
                aria-label={t("retryAria", { correlation: job.correlationId })}
                disabled={retryPending}
                onClick={() => onRetry(job.id)}
                size="sm"
                variant="outline"
              >
                <RotateCcw aria-hidden="true" />
                {t("actions.retry")}
              </Button>
            )}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:ps-7">
        <span className="font-tech ltr-technical">{job.correlationId}</span>
        {job.targetId && (
          <span
            className="truncate font-tech ltr-technical"
            title={job.targetId}
          >
            {job.targetType === "DEVICE" ? t("deviceTarget") : ""} {job.targetId}
          </span>
        )}
        {(job.attempts > 0 || job.status === "RUNNING") && (
          <span>
            {t("attempt", { current: job.attempts, max: job.maxAttempts })}
          </span>
        )}
        {job.payloadJson?.includes("retryOfCorrelationId") && (
          <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-1.5 py-0.5 font-tech text-[10px] ltr-technical">
            RETRY_OF
          </span>
        )}
      </div>
      {(job.status === "RUNNING" || job.status === "QUEUED") && (
        <Progress
          aria-label={t("progressAria", { correlation: job.correlationId })}
          className="mt-2 h-1.5 sm:ms-7 sm:w-[calc(100%-1.75rem)]"
          value={job.progress}
        />
      )}
      {job.error && (
        <p className="mt-2 rounded-md bg-danger-subtle px-2 py-1.5 text-xs text-danger sm:ms-7">
          {job.error}
        </p>
      )}

      {expanded && (
        <div className="mt-3 flex flex-col gap-2.5 border-t pt-3 sm:ps-7">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {(
              [
                ["createdAt", job.createdAt],
                ["scheduledAt", job.scheduledAt],
                ["startedAt", job.startedAt],
                ["finishedAt", job.finishedAt],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="flex min-w-0 flex-col">
                <dt className="text-[11px] text-muted-foreground">{t(`times.${key}`)}</dt>
                <dd className="font-tech text-[11px] ltr-technical">{formatStamp(value)}</dd>
              </div>
            ))}
            <div className="flex min-w-0 flex-col">
              <dt className="text-[11px] text-muted-foreground">{t("times.priority")}</dt>
              <dd className="font-tech text-[11px] ltr-technical">{job.priority}</dd>
            </div>
          </dl>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            <JsonBlock label={t("payload")} value={job.payloadJson} />
            <JsonBlock label={t("result")} value={job.resultJson} />
          </div>
        </div>
      )}
    </li>
  );
};

/**
 * Shared job queue surface used by both the Job Center sheet and the
 * Operations → Job Center view. Polls every 5s while auto refresh is on.
 * Phase 9-b: status/type filters, expandable rows with payload/result JSON
 * and cancel/retry actions.
 */
export function JobCenterContent({
  pageSize = 12,
  className,
  autoRefresh,
  footerSlot,
}: JobCenterContentProps) {
  const t = useTranslations("jobs");
  const [statusKey, setStatusKey] = useState<string>("ALL");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const cancelJob = useCancelJob();
  const retryJob = useRetryJob();

  const statusParam = STATUS_FILTERS.find((f) => f.key === statusKey)?.param;

  // The API filters server-side by status (csv); the type select narrows the
  // fetched page client-side (the list endpoint returns the latest entries).
  const params = useMemo(
    () => ({
      pageSize,
      ...(statusParam ? { status: statusParam } : {}),
    }),
    [pageSize, statusParam]
  );

  const jobs = useJobs(params, {
    refetchInterval: autoRefresh ? 5000 : undefined,
  });

  const rows = useMemo(
    () =>
      (jobs.data?.data ?? []).filter(
        (job) => typeFilter === "ALL" || job.type === typeFilter
      ),
    [jobs.data, typeFilter]
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}>
      {/* Filter row: status chips + type select */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t("filterStatusAria")}>
          {STATUS_FILTERS.map((filter) => (
            <button
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                statusKey === filter.key
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
              key={filter.key}
              onClick={() => setStatusKey(filter.key)}
              type="button"
            >
              {t(`status.${filter.key}`)}
            </button>
          ))}
        </div>
        <Select onValueChange={setTypeFilter} value={typeFilter}>
          <SelectTrigger
            aria-label={t("filterTypeAria")}
            className="ms-auto h-8 w-44 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-60">
            <SelectItem value="ALL">{t("filterTypeAll")}</SelectItem>
            {JOB_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`type.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {jobs.isError ? (
        <ErrorState
          onRetry={() => void jobs.refetch()}
          reason={jobs.error.message}
          title={t("errorTitle")}
        />
      ) : jobs.isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-md border bg-muted/40"
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          description={t("emptyDescription")}
          title={t("emptyTitle")}
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-2 pe-2">
            {rows.map((job) => (
              <JobItem
                cancelPending={cancelJob.isPending && cancelJob.variables === job.id}
                expanded={expandedId === job.id}
                job={job}
                key={job.id}
                onCancel={(id) => cancelJob.mutate(id)}
                onRetry={(id) => retryJob.mutate(id)}
                onToggle={() =>
                  setExpandedId((current) => (current === job.id ? null : job.id))
                }
                retryPending={retryJob.isPending && retryJob.variables === job.id}
              />
            ))}
          </ul>
          <ScrollBar orientation="vertical" />
        </ScrollArea>
      )}
      {footerSlot}
      <p className="text-center text-[11px] text-muted-foreground">
        {autoRefresh
          ? t("autoRefreshOn")
          : t("updated", { time: format(new Date(), "HH:mm:ss") })}
      </p>
    </div>
  );
}

/** Right-hand sheet wrapper around JobCenterContent. */
export function JobCenterSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("jobs");
  const [autoRefresh, setAutoRefresh] = useState(true);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>{t("sheetTitle")}</SheetTitle>
          <SheetDescription>{t("sheetDescription")}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <JobCenterContent
            autoRefresh={autoRefresh}
            onAutoRefreshChange={setAutoRefresh}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
