"use client";

import { useState } from "react";

import { JobCenterContent } from "@/components/shell/job-center";
import { PageHeader } from "@/components/domain/page-header";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Operations → Job Center (Phase 1 slice): the same job queue surface as
 * the header sheet, with a 5s auto-refresh toggle. Full worker integration
 * (progress streaming, retries, DLQ) arrives with the Phase 2 worker.
 */
export function JobsView() {
  const [autoRefresh, setAutoRefresh] = useState(true);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description="Background job queue — backups, validations and polls"
        primaryAction={
          <div className="flex items-center gap-2">
            <Switch
              aria-label="Auto refresh every 5 seconds"
              checked={autoRefresh}
              id="jobs-auto-refresh"
              onCheckedChange={setAutoRefresh}
            />
            <Label className="text-sm font-normal text-muted-foreground" htmlFor="jobs-auto-refresh">
              Auto refresh (5s)
            </Label>
          </div>
        }
        title="Job Center"
      />

      <div className="flex min-h-[50vh] flex-col">
        <JobCenterContent autoRefresh={autoRefresh} pageSize={20} />
      </div>
    </div>
  );
}
