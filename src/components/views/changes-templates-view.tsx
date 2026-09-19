"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Info, LayoutTemplate, Play } from "lucide-react";

import { CHANGE_TEMPLATES, type ChangeTemplate } from "@/lib/change/templates";
import { EmptyState } from "@/components/domain/empty-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChangeWizard } from "@/components/change/change-wizard";
import { lookupStatusConfig, CHANGE_STEP_TYPE_UI } from "./status-extras";
import { StatusIcon } from "@/components/domain/status-icon";

const VENDOR_LABELS: Record<string, string> = {
  cisco: "Cisco IOS / IOS-XE",
  fortinet: "Fortinet FortiOS",
  sophos: "Sophos SFOS",
  hpe: "HPE AOS-CX",
};

/**
 * Change templates view (Task 4-a): static per-vendor starting points.
 * "Use template" opens the wizard prefilled (type NORMAL + plans + steps);
 * the note makes clear templates are editable starting points, not fixed
 * runbooks.
 */
export function ChangeTemplatesView() {
  const t = useTranslations("changeTemplates");
  const [activeTemplate, setActiveTemplate] = useState<ChangeTemplate | null>(null);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={t("description")}
        title={t("title")}
      />

      <p className="flex items-start gap-2 rounded-lg border border-info/25 bg-info-subtle px-3 py-2 text-xs text-info">
        <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        {t("banner")}
      </p>

      {CHANGE_TEMPLATES.length === 0 ? (
        <EmptyState
          description={t("emptyDescription")}
          icon={LayoutTemplate}
          title={t("emptyTitle")}
        />
      ) : (
        <div className="grid gap-4 [&>*]:min-w-0 md:grid-cols-2">
          {CHANGE_TEMPLATES.map((template) => (
            <SectionCard
              actions={
                <Button onClick={() => setActiveTemplate(template)} size="sm">
                  <Play aria-hidden="true" />
                  {t("useTemplate")}
                </Button>
              }
              contentClassName="flex flex-col gap-3"
              description={VENDOR_LABELS[template.vendorKey] ?? template.vendorKey}
              key={template.id}
              title={template.name}
            >
              <p className="text-sm text-muted-foreground">{template.description}</p>

              <div className="rounded-lg border">
                <p className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                  {t("defaultTitle")}
                </p>
                <p className="px-3 py-2 text-sm">{template.defaultTitle}</p>
              </div>

              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {t("executionSteps", { count: template.defaultSteps.length })}
                </p>
                <ol className="flex flex-col gap-1">
                  {template.defaultSteps.map((step, index) => {
                    const typeConfig = lookupStatusConfig(CHANGE_STEP_TYPE_UI, step.type);
                    return (
                      <li className="flex items-center gap-2 text-sm" key={`${template.id}-${index}`}>
                        <span
                          className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-medium tabular-nums text-muted-foreground"
                          aria-hidden="true"
                        >
                          {index + 1}
                        </span>
                        <StatusIcon
                          className={typeConfig.iconClass}
                          icon={typeConfig.icon}
                        />
                        <span className="min-w-0 flex-1 truncate">{step.name}</span>
                        <Badge className="font-tech" variant="outline">
                          {step.type}
                        </Badge>
                      </li>
                    );
                  })}
                </ol>
              </div>

              <div className="flex flex-wrap gap-1.5">
                <Badge variant="outline">{t("badgeImplementation")}</Badge>
                <Badge variant="outline">{t("badgeValidation")}</Badge>
                <Badge variant="outline">{t("badgeRollback")}</Badge>
              </div>
            </SectionCard>
          ))}
        </div>
      )}

      <ChangeWizard
        onOpenChange={(open) => !open && setActiveTemplate(null)}
        open={activeTemplate !== null}
        template={activeTemplate}
      />
    </div>
  );
}
