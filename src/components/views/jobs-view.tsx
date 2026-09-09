"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import { JobCenterContent } from "@/components/shell/job-center";
import { PageHeader } from "@/components/domain/page-header";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * Operations → Job Center: the same job queue surface as the header sheet,
 * with a 5s auto-refresh toggle, status/type filters, expandable rows and
 * cancel/retry actions (Phase 9-b).
 */
export function JobsView() {
  const t = useTranslations("jobs");
  const [autoRefresh, setAutoRefresh] = useState(true);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={t("pageDescription")}
        primaryAction={
          <div className="flex items-center gap-2">
            <Switch
              aria-label={t("autoRefreshAria")}
              checked={autoRefresh}
              id="jobs-auto-refresh"
              onCheckedChange={setAutoRefresh}
            />
            <Label
              className="text-sm font-normal text-muted-foreground"
              htmlFor="jobs-auto-refresh"
            >
              {t("autoRefreshLabel")}
            </Label>
          </div>
        }
        title={t("pageTitle")}
      />

      <div className="flex min-h-[50vh] flex-col">
        <JobCenterContent autoRefresh={autoRefresh} pageSize={20} />
      </div>
    </div>
  );
}
