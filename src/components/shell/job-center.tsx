"use client";

import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";

import { useJobs } from "@/hooks/api/use-jobs";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { JobStatusBadge } from "@/components/domain/job-status-badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

interface JobCenterContentProps {
  pageSize?: number;
  className?: string;
  /** Auto refresh is on by default in the sheet, toggleable in the Jobs view. */
  autoRefresh: boolean;
  onAutoRefreshChange?: (enabled: boolean) => void;
  footerSlot?: React.ReactNode;
}

const JOB_TYPE_LABEL: Record<string, string> = {
  CONFIG_BACKUP: "Configuration backup",
  CONFIG_RESTORE: "Configuration restore",
  CONFIG_APPLY: "Configuration apply",
  VALIDATION: "Validation",
  DISCOVERY: "Discovery scan",
  INVENTORY_POLL: "Inventory poll",
  METRIC_POLL: "Metric poll",
  REPORT_GENERATION: "Report generation",
  NOTIFICATION: "Notification",
};

/**
 * Shared job queue surface used by both the Job Center sheet and the
 * Operations → Job Center view. Polls every 5s while auto refresh is on.
 */
export function JobCenterContent({
  pageSize = 12,
  className,
  autoRefresh,
  footerSlot,
}: JobCenterContentProps) {
  const jobs = useJobs(
    { pageSize },
    { refetchInterval: autoRefresh ? 5000 : undefined }
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col gap-3", className)}>
      {jobs.isError ? (
        <ErrorState
          onRetry={() => void jobs.refetch()}
          reason={jobs.error.message}
          title="Jobs could not be loaded"
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
      ) : (jobs.data?.data.length ?? 0) === 0 ? (
        <EmptyState
          description="Queued backups, validations and polls will appear here as they run."
          title="No jobs yet"
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-2 pe-2">
            {jobs.data?.data.map((job) => (
              <li
                key={job.id}
                className="rounded-lg border bg-card p-3 shadow-e1"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <JobStatusBadge value={job.status} />
                  <span className="text-sm font-medium">
                    {JOB_TYPE_LABEL[job.type] ?? job.type}
                  </span>
                  <span className="ms-auto text-[11px] text-muted-foreground">
                    {job.finishedAt
                      ? formatDistanceToNow(new Date(job.finishedAt), {
                          addSuffix: true,
                        })
                      : `queued ${formatDistanceToNow(new Date(job.createdAt), {
                          addSuffix: true,
                        })}`}
                  </span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="font-tech ltr-technical">
                    {job.correlationId}
                  </span>
                  {job.targetId && (
                    <span className="truncate font-tech ltr-technical" title={job.targetId}>
                      {job.targetType === "DEVICE" ? "device " : ""}
                      {job.targetId}
                    </span>
                  )}
                  {job.attempts > 0 && (
                    <span>
                      attempt {job.attempts}/{job.maxAttempts}
                    </span>
                  )}
                </div>
                {(job.status === "RUNNING" || job.status === "QUEUED") && (
                  <Progress
                    aria-label={`Job ${job.correlationId} progress`}
                    className="mt-2 h-1.5"
                    value={job.progress}
                  />
                )}
                {job.error && (
                  <p className="mt-2 rounded-md bg-danger-subtle px-2 py-1.5 text-xs text-danger">
                    {job.error}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <ScrollBar orientation="vertical" />
        </ScrollArea>
      )}
      {footerSlot}
      <p className="text-center text-[11px] text-muted-foreground">
        {autoRefresh
          ? "Auto-refreshing every 5 seconds"
          : `Updated ${format(new Date(), "HH:mm:ss")}`}
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
  const [autoRefresh, setAutoRefresh] = useState(true);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader className="border-b">
          <SheetTitle>Job Center</SheetTitle>
          <SheetDescription>
            Background job queue — backups, validations and polls.
          </SheetDescription>
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
