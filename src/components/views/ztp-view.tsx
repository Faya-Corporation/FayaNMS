"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowRight,
  Cable,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Clock,
  LoaderCircle,
  OctagonX,
  Plus,
} from "lucide-react";

import { useCreateZtpClaim, useZtp } from "@/hooks/api/use-ztp";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ztpClaimBadge } from "@/components/views/ztp-band";
import { renderZtpConfig } from "@/lib/ztp/templates";
import type { ZtpClaimRow } from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";

/**
 * Zero-touch provisioning (Phase 14-b): claim queue + new-claim form over
 * /api/v1/ztp/claims. KPI row (claims by status), the queue table (status
 * badges, device link when provisioned, job link with live progress,
 * expandable rendered-template preview per claim), the new-claim form
 * (template filtered by vendor, site drives the projected management IP)
 * and the provisioning history (ZTP_* audit rows). Badge colors follow the
 * shared token system via ztp-band (icon + text, never color-only).
 */

const SERIAL_RE = /^[A-Za-z0-9-]{4,64}$/;
const HOSTNAME_RE =
  /^(?=.{3,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function ZtpView() {
  const t = useTranslations("ztp");
  const ztp = useZtp();
  const createClaim = useCreateZtpClaim();
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const { toast } = useToast();

  const [serial, setSerial] = useState("");
  const [hostname, setHostname] = useState("");
  const [vendorKey, setVendorKey] = useState("");
  const [model, setModel] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [formPreviewOpen, setFormPreviewOpen] = useState(false);
  const [expandedClaimId, setExpandedClaimId] = useState<string | null>(null);

  const vendors = useMemo(
    () => (ztp.data?.vendors ?? []).filter((v) => v.hasTemplate),
    [ztp.data]
  );
  const sites = ztp.data?.sites ?? [];
  const templates = useMemo(
    () => (ztp.data?.templates ?? []).filter((tpl) => tpl.vendorKey === vendorKey),
    [ztp.data, vendorKey]
  );
  const selectedSite = sites.find((s) => s.id === siteId) ?? null;
  const selectedTemplate = templates.find((tpl) => tpl.id === templateId) ?? null;
  const claims = ztp.data?.claims ?? [];
  const counts = ztp.data?.counts;

  const serialValid = SERIAL_RE.test(serial.trim());
  const hostnameValid = HOSTNAME_RE.test(hostname.trim());
  const modelValid = model.trim().length >= 1 && model.trim().length <= 80;
  const canSubmit =
    serialValid &&
    hostnameValid &&
    modelValid &&
    vendorKey !== "" &&
    templateId !== "" &&
    siteId !== "";

  const formPreview = selectedTemplate
    ? renderZtpConfig(selectedTemplate.id, {
        hostname: hostname.trim() || "device",
        siteCode: selectedSite?.code ?? "SITE",
      })
    : null;

  const submitClaim = async () => {
    if (!canSubmit) return;
    try {
      const result = await createClaim.mutateAsync({
        serial: serial.trim(),
        hostname: hostname.trim(),
        vendorKey,
        model: model.trim(),
        templateId,
        siteId,
      });
      toast({
        title: t("toast.createdTitle", { hostname: result.claim.hostname }),
        description: t("toast.createdDescription", {
          correlation: result.correlationId,
          mgmtIp: result.projectedMgmtIp,
        }),
      });
      setSerial("");
      setHostname("");
      setModel("");
      setVendorKey("");
      setTemplateId("");
      setSiteId("");
      setFormPreviewOpen(false);
    } catch (error) {
      toast({
        title: t("toast.failedTitle"),
        description: error instanceof Error ? error.message : t("errorTitle"),
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader description={t("description")} title={t("title")} />

      {ztp.isError ? (
        <ErrorState
          onRetry={() => void ztp.refetch()}
          reason={ztp.error.message}
          title={t("errorTitle")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* KPI row — claims by status */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <KpiCard
              description={t("kpi.totalHint")}
              icon={Cable}
              label={t("kpi.total")}
              loading={!ztp.data}
              value={counts?.total ?? "—"}
            />
            <KpiCard
              description={t("kpi.pendingHint")}
              icon={Clock}
              label={t("kpi.pending")}
              loading={!ztp.data}
              value={counts?.pending ?? "—"}
            />
            <KpiCard
              description={t("kpi.provisioningHint")}
              icon={LoaderCircle}
              label={t("kpi.provisioning")}
              loading={!ztp.data}
              value={counts?.provisioning ?? "—"}
            />
            <KpiCard
              description={t("kpi.provisionedHint")}
              icon={CircleCheck}
              label={t("kpi.provisioned")}
              loading={!ztp.data}
              value={counts?.provisioned ?? "—"}
            />
            <KpiCard
              className={cn((counts?.failed ?? 0) > 0 && "border-danger/40")}
              description={t("kpi.failedHint")}
              icon={OctagonX}
              label={t("kpi.failed")}
              loading={!ztp.data}
              value={counts?.failed ?? "—"}
            />
          </div>

          <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
            {/* New claim form */}
            <SectionCard
              contentClassName="flex flex-col gap-3"
              description={t("form.description")}
              title={t("form.title")}
            >
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="ztp-serial">
                  {t("form.serial")}
                </label>
                <Input
                  aria-invalid={serial.length > 0 && !serialValid}
                  autoComplete="off"
                  className="font-tech ltr-technical"
                  id="ztp-serial"
                  onChange={(event) => setSerial(event.target.value)}
                  placeholder="FAB-2026-0117"
                  spellCheck={false}
                  value={serial}
                />
                {serial.length > 0 && !serialValid && (
                  <p className="text-xs text-danger">{t("form.invalidSerial")}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="ztp-hostname">
                  {t("form.hostname")}
                </label>
                <Input
                  aria-invalid={hostname.length > 0 && !hostnameValid}
                  autoComplete="off"
                  className="font-tech ltr-technical"
                  id="ztp-hostname"
                  onChange={(event) => setHostname(event.target.value)}
                  placeholder="BR2-ACC-SW-09"
                  spellCheck={false}
                  value={hostname}
                />
                {hostname.length > 0 && !hostnameValid && (
                  <p className="text-xs text-danger">{t("form.invalidHostname")}</p>
                )}
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="ztp-vendor">
                    {t("form.vendor")}
                  </label>
                  <Select
                    onValueChange={(value) => {
                      setVendorKey(value);
                      setTemplateId("");
                    }}
                    value={vendorKey}
                  >
                    <SelectTrigger aria-label={t("form.vendor")} id="ztp-vendor">
                      <SelectValue placeholder={t("form.selectVendor")} />
                    </SelectTrigger>
                    <SelectContent>
                      {vendors.map((vendor) => (
                        <SelectItem key={vendor.key} value={vendor.key}>
                          {vendor.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="ztp-model">
                    {t("form.model")}
                  </label>
                  <Input
                    aria-invalid={model.length > 0 && !modelValid}
                    autoComplete="off"
                    id="ztp-model"
                    onChange={(event) => setModel(event.target.value)}
                    placeholder="C9200L-48P-4X"
                    value={model}
                  />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="ztp-template">
                  {t("form.template")}
                </label>
                <Select
                  disabled={vendorKey === ""}
                  onValueChange={setTemplateId}
                  value={templateId}
                >
                  <SelectTrigger aria-label={t("form.template")} id="ztp-template">
                    <SelectValue placeholder={t("form.selectTemplate")} />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((tpl) => (
                      <SelectItem key={tpl.id} value={tpl.id}>
                        {tpl.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedTemplate && (
                  <p className="text-xs text-muted-foreground">{selectedTemplate.description}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="ztp-site">
                  {t("form.site")}
                </label>
                <Select onValueChange={setSiteId} value={siteId}>
                  <SelectTrigger aria-label={t("form.site")} id="ztp-site">
                    <SelectValue placeholder={t("form.selectSite")} />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name} ({site.code})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                className="mt-1"
                disabled={!canSubmit || createClaim.isPending}
                onClick={() => void submitClaim()}
              >
                <Plus aria-hidden="true" />
                {createClaim.isPending ? t("form.submitting") : t("form.submit")}
              </Button>

              {/* Rendered template preview (new claim) — mgmt IP is assigned
                  by the worker, so its placeholder stays visible on purpose. */}
              {formPreview && (
                <div className="rounded-md border bg-surface-subtle">
                  <button
                    aria-expanded={formPreviewOpen}
                    className="flex w-full items-center gap-1 px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground"
                    onClick={() => setFormPreviewOpen((open) => !open)}
                    type="button"
                  >
                    {formPreviewOpen ? (
                      <ChevronDown aria-hidden="true" className="size-3" />
                    ) : (
                      <ChevronRight aria-hidden="true" className="size-3" />
                    )}
                    {t("form.preview")}
                  </button>
                  {formPreviewOpen && (
                    <pre className="ltr-technical max-h-64 overflow-auto border-t px-2.5 py-2 font-mono text-[11px] leading-4">
                      {formPreview}
                    </pre>
                  )}
                </div>
              )}
            </SectionCard>

            {/* Claims queue + provisioning history */}
            <div className="flex min-w-0 flex-col gap-4">
              <SectionCard
                contentClassName="p-0"
                description={t("queue.description")}
                title={t("queue.title")}
              >
                {ztp.isLoading ? (
                  <div className="flex flex-col gap-2 p-4">
                    {Array.from({ length: 4 }).map((_, index) => (
                      <div key={index} className="h-12 animate-pulse rounded-md bg-muted/60" />
                    ))}
                  </div>
                ) : claims.length === 0 ? (
                  <div className="p-4">
                    <EmptyState
                      description={t("queue.emptyDescription")}
                      icon={Cable}
                      title={t("queue.emptyTitle")}
                    />
                  </div>
                ) : (
                  <div className="max-h-96 overflow-y-auto">
                    <Table>
                      <TableHeader className="sticky top-0 z-10 bg-card">
                        <TableRow>
                          <TableHead>{t("queue.device")}</TableHead>
                          <TableHead>{t("queue.serial")}</TableHead>
                          <TableHead className="hidden md:table-cell">{t("queue.site")}</TableHead>
                          <TableHead>{t("queue.status")}</TableHead>
                          <TableHead className="hidden lg:table-cell">{t("queue.created")}</TableHead>
                          <TableHead className="text-end">{t("queue.actions")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {claims.map((row) => (
                          <ClaimRow
                            expanded={expandedClaimId === row.id}
                            key={row.id}
                            onToggle={() =>
                              setExpandedClaimId(expandedClaimId === row.id ? null : row.id)
                            }
                            row={row}
                          />
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </SectionCard>

              <SectionCard
                contentClassName="p-0"
                description={t("history.description")}
                title={t("history.title")}
              >
                {(ztp.data?.history ?? []).length === 0 ? (
                  <p className="px-4 py-3 text-sm text-muted-foreground">{t("history.empty")}</p>
                ) : (
                  <ul className="divide-y">
                    {(ztp.data?.history ?? []).map((entry, index) => (
                      <li
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 text-sm"
                        key={`${entry.correlationId ?? "evt"}-${index}`}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-2 shrink-0 rounded-full",
                            entry.result === "SUCCESS" ? "bg-success" : "bg-danger"
                          )}
                        />
                        <span className="font-tech text-xs ltr-technical">{entry.action}</span>
                        <span className="min-w-0 truncate text-muted-foreground">
                          {entry.resourceLabel}
                        </span>
                        {entry.correlationId && (
                          <span className="font-tech text-xs text-muted-foreground ltr-technical">
                            {entry.correlationId}
                          </span>
                        )}
                        <span className="ms-auto whitespace-nowrap text-xs text-muted-foreground">
                          {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t("formNote")}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Queue row                                                           */
/* ------------------------------------------------------------------ */

function ClaimRow({
  row,
  expanded,
  onToggle,
}: {
  row: ZtpClaimRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("ztp");
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  const badge = ztpClaimBadge(row.effectiveStatus);
  const preview = renderZtpConfig(row.templateId, {
    hostname: row.hostname,
    siteCode: row.siteCode ?? "UNASSIGNED",
    mgmtIp: row.mgmtIp ?? row.projectedMgmtIp ?? undefined,
  });

  return (
    <>
      <TableRow className={cn(row.effectiveStatus === "provisioning" && "bg-info-subtle/40")}>
        <TableCell className="max-w-0 align-middle">
          <button
            aria-expanded={expanded}
            aria-label={t("queue.previewAria", { serial: row.serial })}
            className="flex min-w-0 items-center gap-1 text-start"
            onClick={onToggle}
            type="button"
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{row.hostname}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {row.vendorName} · {row.model}
              </span>
            </span>
          </button>
        </TableCell>
        <TableCell className="max-w-0 align-middle">
          <span className="block whitespace-nowrap font-tech text-sm ltr-technical">
            {row.serial}
          </span>
          {(row.mgmtIp || row.projectedMgmtIp) && (
            <span className="block truncate text-xs text-muted-foreground ltr-technical">
              {row.mgmtIp ?? row.projectedMgmtIp}
              {!row.mgmtIp && <span className="ms-1">({t("queue.projected")})</span>}
            </span>
          )}
        </TableCell>
        <TableCell className="hidden whitespace-nowrap align-middle text-sm md:table-cell">
          {row.siteName ?? "—"}
        </TableCell>
        <TableCell className="align-middle">
          <StatusBadge config={badge} />
        </TableCell>
        <TableCell className="hidden whitespace-nowrap align-middle text-xs text-muted-foreground lg:table-cell">
          {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
        </TableCell>
        <TableCell className="text-end align-middle">
          <div className="flex items-center justify-end gap-2">
            {row.activeJob && (
              <button
                className="inline-flex items-center gap-1 rounded-full border bg-info-subtle px-1.5 py-0.5 text-[10px] font-medium text-info hover:bg-info-subtle/70"
                onClick={() => setActiveView("ops.jobs")}
                title={t("queue.jobTitle", { correlation: row.activeJob.correlationId })}
                type="button"
              >
                {row.activeJob.status === "RUNNING" ? (
                  <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
                ) : (
                  <Clock aria-hidden="true" className="size-3" />
                )}
                <span className="font-tech ltr-technical">{row.activeJob.correlationId}</span>
                {row.activeJob.status === "RUNNING" && (
                  <span className="tabular-nums">{row.activeJob.progress}%</span>
                )}
              </button>
            )}
            {row.deviceId && (
              <Button
                aria-label={t("queue.openDeviceAria", { hostname: row.hostname })}
                onClick={() =>
                  setActiveView("network.device-detail", { deviceId: row.deviceId ?? "" })
                }
                size="sm"
                variant="outline"
              >
                {t("queue.openDevice")}
                <ArrowRight aria-hidden="true" />
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {expanded && preview && (
        <TableRow>
          <TableCell className="p-0" colSpan={6}>
            <div className="border-t bg-surface-subtle px-3 py-2">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                {t("queue.previewLabel", { template: row.templateId })}
              </p>
              <pre className="ltr-technical max-h-64 overflow-auto font-mono text-[11px] leading-4">
                {preview}
              </pre>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
