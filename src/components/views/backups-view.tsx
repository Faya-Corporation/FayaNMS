"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format, formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  Download,
  LoaderCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";

import { useMeta } from "@/hooks/api/use-meta";
import { useSnapshots } from "@/hooks/api/use-snapshots";
import { useStatusLabel } from "@/hooks/use-status-label";
import {
  useBackupPolicies,
  useCreateBackupPolicy,
  useDeleteBackupPolicy,
  useUpdateBackupPolicy,
} from "@/hooks/api/use-backup-policies";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { FilterChip } from "@/components/domain/filter-chip";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { StatusBadge } from "@/components/domain/status-badge";
import {
  SNAPSHOT_SOURCE,
  SNAPSHOT_STATUS,
  DEVICE_STATUS,
  SEVERITY,
  getStatusConfig,
} from "@/lib/domain/status";
import { cronHint, isValidCronExpr } from "@/lib/cron";
import type {
  BackupPolicyRow,
  FleetSnapshotRow,
} from "@/lib/api-client";
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
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

/**
 * Backups (Phase 3-a): fleet-wide snapshot history with audited raw-config
 * downloads plus backup policy management — policies become live schedules
 * on the next worker tick (30 s).
 */

const ALL = "ALL";
const PAGE_SIZE = 25;

const CRITICALITY_OPTIONS = [
  { value: "LOW" },
  { value: "MEDIUM" },
  { value: "HIGH" },
  { value: "CRITICAL" },
];

// OFFLINE/UNMANAGED are never scheduled by the worker, so the scope
// include-filter does not offer them.
const STATUS_OPTIONS = [
  { value: "ONLINE" },
  { value: "DEGRADED" },
  { value: "MAINTENANCE" },
  { value: "UNKNOWN" },
];

const CRON_PRESETS = [
  { key: "daily", value: "0 2 * * *" },
  { key: "everySixHours", value: "0 */6 * * *" },
  { key: "weekly", value: "0 3 * * 0" },
];

type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

function formatSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

/* ------------------------------------------------------------------ */
/* History tab                                                          */
/* ------------------------------------------------------------------ */

function HistoryTab() {
  const t = useTranslations("backups");
  const { toast } = useToast();
  const setActiveView = useNavigationStore((state) => state.setActiveView);
  // Status labels resolve in the active locale (falls back to config.label).
  const resolveStatusLabel = useStatusLabel();

  const [searchInput, setSearchInput] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(ALL);
  const [source, setSource] = useState(ALL);
  const [page, setPage] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const snapshots = useSnapshots({
    q: q || undefined,
    status: status !== ALL ? status : undefined,
    source: source !== ALL ? source : undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  // Debounce the search box into the query (same pattern as Devices view).
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = searchInput.trim();
      if (next !== q) {
        setQ(next);
        setPage(1);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, q]);

  const rows = snapshots.data?.data ?? [];
  const metaInfo = snapshots.data?.meta;

  /** Audited raw-config download: fetch → blob → anchor click (F-12). */
  const handleDownload = async (row: FleetSnapshotRow) => {
    setDownloadingId(row.id);
    try {
      const res = await fetch(
        `/api/v1/devices/${row.deviceId}/snapshots/${row.id}/download`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: { message?: string } };
          if (body?.error?.message) message = body.error.message;
        } catch {
          // not a JSON envelope — keep the HTTP status message
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `${row.hostname}-v${row.version}.cfg`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast({
        title: t("download.started"),
        description: t("download.startedDescription", {
          hostname: row.hostname,
          version: row.version,
          filename,
        }),
      });
    } catch (error) {
      toast({
        title: t("download.failed"),
        description: error instanceof Error ? error.message : t("download.unknownError"),
        variant: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  };

  const statusFilter = (
    <Select
      onValueChange={(value) => {
        setStatus(value);
        setPage(1);
      }}
      value={status}
    >
      <SelectTrigger aria-label={t("history.filterStatus")} className="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("history.allStatuses")}</SelectItem>
        {Object.values(SNAPSHOT_STATUS).map((config) => (
          <SelectItem key={config.key} value={config.key}>
            {resolveStatusLabel(config)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const sourceFilter = (
    <Select
      onValueChange={(value) => {
        setSource(value);
        setPage(1);
      }}
      value={source}
    >
      <SelectTrigger aria-label={t("history.filterSource")} className="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{t("history.allSources")}</SelectItem>
        {Object.values(SNAPSHOT_SOURCE).map((config) => (
          <SelectItem key={config.key} value={config.key}>
            {resolveStatusLabel(config)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <SectionCard
      contentClassName="p-0"
      description={t("history.description")}
      title={t("history.title")}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            aria-hidden="true"
            className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={t("history.searchAria")}
            className="h-8 ps-8 text-xs"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder={t("history.searchPlaceholder")}
            value={searchInput}
          />
        </div>
        {statusFilter}
        {sourceFilter}
        <Button
          onClick={() => {
            setStatus(ALL);
            setSource(ALL);
            setSearchInput("");
            setPage(1);
          }}
          size="sm"
          variant="ghost"
        >
          {t("history.reset")}
        </Button>
        <Button
          className="ms-auto"
          onClick={() => setActiveView("network.devices")}
          size="sm"
          variant="outline"
        >
          {t("history.backupNow")}
        </Button>
      </div>

      {snapshots.isError ? (
        <div className="p-4">
          <ErrorState
            onRetry={() => void snapshots.refetch()}
            reason={snapshots.error.message}
            title={t("history.errorTitle")}
          />
        </div>
      ) : snapshots.isLoading ? (
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-md bg-muted/60" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState
            description={t("history.emptyDescription")}
            icon={CloudUpload}
            title={t("history.emptyTitle")}
          />
        </div>
      ) : (
        <div className="max-h-[600px] overflow-y-auto">
          <div className="min-w-[980px]">
            <Table aria-label={t("history.tableAria")}>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("history.time")}</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("history.device")}</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                    {t("history.site")}
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("history.version")}</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    {t("history.source")}
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    {t("history.size")}
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                    {t("history.checksum")}
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("history.status")}</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                    {t("history.correlation")}
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x) text-end">
                    {t("history.action")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground tabular-nums">
                      {format(new Date(row.createdAt), "MMM d, HH:mm")}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <button
                        aria-label={t("history.openDevice", { hostname: row.hostname })}
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
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x) font-tech text-sm ltr-technical">
                      v{row.version}
                    </TableCell>
                    <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                      <StatusBadge
                        config={getStatusConfig(SNAPSHOT_SOURCE, row.source)}
                        withIcon={false}
                      />
                    </TableCell>
                    <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs tabular-nums sm:table-cell">
                      {formatSize(row.sizeBytes)}
                    </TableCell>
                    <TableCell
                      className="hidden h-(--density-row-h) px-(--density-cell-x) font-tech text-xs ltr-technical text-muted-foreground lg:table-cell"
                      title={row.sha256}
                    >
                      {row.sha256.slice(0, 10)}…
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <StatusBadge
                        config={getStatusConfig(SNAPSHOT_STATUS, row.status)}
                        withIcon={false}
                      />
                    </TableCell>
                    <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) font-tech text-xs ltr-technical text-muted-foreground lg:table-cell">
                      {row.correlationId ?? "—"}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-end">
                      <Button
                        aria-label={t("history.download", { hostname: row.hostname, version: row.version })}
                        disabled={downloadingId === row.id}
                        onClick={() => void handleDownload(row)}
                        size="sm"
                        variant="ghost"
                      >
                        {downloadingId === row.id ? (
                          <LoaderCircle aria-hidden="true" className="animate-spin" />
                        ) : (
                          <Download aria-hidden="true" />
                        )}
                        <span className="sr-only sm:not-sr-only">{t("history.downloadText")}</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {/* Pagination footer */}
      {metaInfo && rows.length > 0 && (
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t("history.pagination", {
              total: metaInfo.total,
              page: metaInfo.page,
              totalPages: metaInfo.totalPages,
            })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              aria-label={t("history.previousPage")}
              disabled={metaInfo.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              size="sm"
              variant="outline"
            >
              <ChevronLeft aria-hidden="true" />
              {t("history.prev")}
            </Button>
            <Button
              aria-label={t("history.nextPage")}
              disabled={metaInfo.page >= metaInfo.totalPages}
              onClick={() => setPage((p) => p + 1)}
              size="sm"
              variant="outline"
            >
              {t("history.next")}
              <ChevronRight aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ */
/* Policy form dialog (create + edit)                                   */
/* ------------------------------------------------------------------ */

const policyFormSchema = (t: TranslateFn) => z.object({
  name: z.string().trim().min(1, t("validation.nameRequired")).max(120),
  cronExpr: z
    .string()
    .trim()
    .min(1, t("validation.cronRequired"))
    .refine(isValidCronExpr, {
      message: t("validation.cronFormat", { example: "0 2 * * *" }),
    }),
  siteCodes: z.array(z.string()),
  criticalities: z.array(z.string()),
  statuses: z.array(z.string()),
  // Kept as a string input so zodResolver's input/output types align with
  // the form values; converted to a number on submit.
  retentionDays: z
    .string()
    .trim()
    .min(1, t("validation.retentionRequired"))
    .regex(/^\d+$/, t("validation.wholeDays"))
    .refine((value) => {
      const n = Number(value);
      return n >= 1 && n <= 3650;
    }, t("validation.retentionRange")),
  isActive: z.boolean(),
});

type PolicyFormValues = z.infer<ReturnType<typeof policyFormSchema>>;

interface CheckboxGroupProps {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  optionAriaLabel: (option: { value: string; label: string }) => string;
  error?: string;
}

function CheckboxGroup({
  label,
  hint,
  options,
  value,
  onChange,
  optionAriaLabel,
  error,
}: CheckboxGroupProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="grid grid-cols-2 gap-2 rounded-md border bg-surface-subtle p-3">
        {options.map((option) => {
          const checked = value.includes(option.value);
          return (
            <label
              className="flex min-h-11 cursor-pointer items-center gap-2 text-sm md:min-h-0"
              key={option.value}
            >
              <Checkbox
                aria-label={optionAriaLabel(option)}
                checked={checked}
                onCheckedChange={(checkedState) =>
                  onChange(
                    checkedState === true
                      ? [...value, option.value]
                      : value.filter((entry) => entry !== option.value)
                  )
                }
              />
              {option.label}
            </label>
          );
        })}
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}

function PolicyFormDialog({
  open,
  onOpenChange,
  policy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided the dialog edits this policy instead of creating one. */
  policy?: BackupPolicyRow | null;
}) {
  const t = useTranslations("backups");
  const meta = useMeta();
  const createPolicy = useCreateBackupPolicy();
  const updatePolicy = useUpdateBackupPolicy();
  // Scope option labels resolve in the active locale through the same
  // status maps the rest of the app uses (SEVERITY / DEVICE_STATUS).
  const resolveStatusLabel = useStatusLabel();
  const criticalityOptions = CRITICALITY_OPTIONS.map((option) => ({
    ...option,
    label: resolveStatusLabel(getStatusConfig(SEVERITY, option.value)),
  }));
  const statusOptions = STATUS_OPTIONS.map((option) => ({
    ...option,
    label: resolveStatusLabel(getStatusConfig(DEVICE_STATUS, option.value)),
  }));

  const editing = Boolean(policy);
  const defaultValues: PolicyFormValues = useMemo(
    () => ({
      name: policy?.name ?? "",
      cronExpr: policy?.cronExpr ?? "0 2 * * *",
      siteCodes: policy?.scope.siteCodes ?? [],
      criticalities: policy?.scope.criticalities ?? [],
      statuses: policy?.scope.statuses ?? [],
      retentionDays: String(policy?.retentionDays ?? 90),
      isActive: policy?.isActive ?? true,
    }),
    [policy]
  );

  const form = useForm<PolicyFormValues>({
    defaultValues,
    resolver: zodResolver(policyFormSchema(t)),
    mode: "onSubmit",
  });

  // useWatch (compiler-safe) instead of form.watch() — see device-form-sheet.
  const cronExpr = useWatch({ control: form.control, name: "cronExpr" });
  const siteCodes = useWatch({ control: form.control, name: "siteCodes" });
  const criticalities = useWatch({ control: form.control, name: "criticalities" });
  const statuses = useWatch({ control: form.control, name: "statuses" });
  const isActive = useWatch({ control: form.control, name: "isActive" });

  useEffect(() => {
    if (open) {
      form.reset(defaultValues);
    }
  }, [open, defaultValues, form]);

  const pending = createPolicy.isPending || updatePolicy.isPending;

  const onSubmit = (values: PolicyFormValues) => {
    const payload = {
      name: values.name,
      cronExpr: values.cronExpr,
      scope: {
        siteCodes: values.siteCodes,
        criticalities: values.criticalities,
        statuses: values.statuses,
      },
      retentionDays: Number(values.retentionDays),
      isActive: values.isActive,
    };
    if (editing && policy) {
      updatePolicy.mutate(
        { id: policy.id, data: payload },
        { onSuccess: () => onOpenChange(false) }
      );
      return;
    }
    createPolicy.mutate(payload, { onSuccess: () => onOpenChange(false) });
  };

  const sites = meta.data?.sites ?? [];
  const siteOptions = [
    { value: "*", label: t("form.allSites") },
    ...sites.map((site) => ({ value: site.code, label: `${site.name} (${site.code})` })),
  ];

  /** "All sites" is mutually exclusive with explicit site codes. */
  const handleSiteCodesChange = (next: string[]) => {
    const hadStar = siteCodes.includes("*");
    const hasStar = next.includes("*");
    if (!hadStar && hasStar) {
      form.setValue("siteCodes", ["*"], { shouldValidate: true });
      return;
    }
    form.setValue(
      "siteCodes",
      next.filter((code) => code !== "*" || next.length === 1),
      { shouldValidate: true }
    );
  };

  const hint = cronHint(cronExpr ?? "", t);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? t("form.editTitle") : t("form.newTitle")}</DialogTitle>
          <DialogDescription>
            {t("form.description")}
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-name">{t("form.nameLabel")}</Label>
            <Input
              {...form.register("name")}
              aria-invalid={Boolean(form.formState.errors.name)}
              id="policy-name"
              placeholder={t("form.namePlaceholder")}
            />
            {form.formState.errors.name && (
              <p className="text-xs text-danger">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-cron">{t("form.scheduleLabel")}</Label>
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((preset) => (
                <Button
                  key={preset.value}
                  onClick={() =>
                    form.setValue("cronExpr", preset.value, { shouldValidate: true })
                  }
                  size="sm"
                  type="button"
                  variant={cronExpr === preset.value ? "secondary" : "outline"}
                >
                  {t(`form.cronPreset.${preset.key}`)}
                </Button>
              ))}
            </div>
            <Input
              {...form.register("cronExpr")}
              aria-invalid={Boolean(form.formState.errors.cronExpr)}
              className="font-tech ltr-technical"
              id="policy-cron"
              placeholder={t("form.cronPlaceholder")}
            />
            {hint && !form.formState.errors.cronExpr && (
              <p className="text-xs text-info">{hint}</p>
            )}
            {form.formState.errors.cronExpr && (
              <p className="text-xs text-danger">{form.formState.errors.cronExpr.message}</p>
            )}
          </div>

          <CheckboxGroup
            error={form.formState.errors.siteCodes?.message}
            hint={t("form.sitesHint")}
            label={t("form.sitesLabel")}
            onChange={handleSiteCodesChange}
            optionAriaLabel={(option) => t("form.scopeOption", { scope: t("form.sitesLabel"), option: option.label })}
            options={siteOptions}
            value={siteCodes ?? []}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <CheckboxGroup
              label={t("form.criticalitiesLabel")}
              onChange={(next) =>
                form.setValue("criticalities", next, { shouldValidate: true })
              }
              options={criticalityOptions}
              optionAriaLabel={(option) => t("form.scopeOption", { scope: t("form.criticalitiesLabel"), option: option.label })}
              value={criticalities ?? []}
            />
            <CheckboxGroup
              hint={t("form.offlineHint")}
              label={t("form.statusesLabel")}
              onChange={(next) =>
                form.setValue("statuses", next, { shouldValidate: true })
              }
              options={statusOptions}
              optionAriaLabel={(option) => t("form.scopeOption", { scope: t("form.statusesLabel"), option: option.label })}
              value={statuses ?? []}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-retention">{t("form.retentionLabel")}</Label>
              <Input
                {...form.register("retentionDays")}
                aria-invalid={Boolean(form.formState.errors.retentionDays)}
                id="policy-retention"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">
                {t("form.retentionHint")}
              </p>
              {form.formState.errors.retentionDays && (
                <p className="text-xs text-danger">
                  {form.formState.errors.retentionDays.message}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-active">{t("form.activeLabel")}</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  aria-label={t("form.activeAria")}
                  checked={isActive}
                  id="policy-active"
                  onCheckedChange={(checked) => form.setValue("isActive", checked)}
                />
                <span className="text-sm text-muted-foreground">
                  {isActive ? t("form.activeRunning") : t("form.paused")}
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {t("form.cancel")}
            </Button>
            <Button disabled={pending} type="submit">
              {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {editing ? t("form.save") : t("form.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Policies tab                                                         */
/* ------------------------------------------------------------------ */

function ScopeChips({ policy }: { policy: BackupPolicyRow }) {
  const t = useTranslations("backups");
  const { scope } = policy;
  // Status/criticality chip values resolve in the active locale through the
  // same status maps the rest of the app uses (SEVERITY / DEVICE_STATUS).
  const resolveStatusLabel = useStatusLabel();
  const chips: { label: string; value: string }[] = [];

  if (scope.siteCodes.length > 0) {
    chips.push({
      label: t("scope.sites"),
      value: scope.siteCodes.includes("*")
        ? t("scope.allSites")
        : scope.siteCodes.join(", "),
    });
  }
  for (const criticality of scope.criticalities) {
    chips.push({
      label: t("scope.criticality"),
      value: resolveStatusLabel(getStatusConfig(SEVERITY, criticality)),
    });
  }
  for (const status of scope.statuses) {
    chips.push({
      label: t("scope.status"),
      value: resolveStatusLabel(getStatusConfig(DEVICE_STATUS, status)),
    });
  }

  if (chips.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("scope.fleetWide")}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <FilterChip key={`${chip.label}-${chip.value}`} label={chip.label} value={chip.value} />
      ))}
    </div>
  );
}

function PoliciesTab() {
  const t = useTranslations("backups");
  const policies = useBackupPolicies();
  const updatePolicy = useUpdateBackupPolicy();
  const deletePolicy = useDeleteBackupPolicy();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BackupPolicyRow | null>(null);
  const [deleting, setDeleting] = useState<BackupPolicyRow | null>(null);

  const rows = policies.data ?? [];

  return (
    <>
      <SectionCard
        contentClassName="p-0"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
            size="sm"
          >
            <Plus aria-hidden="true" />
            {t("policies.newPolicy")}
          </Button>
        }
        description={t("policies.description")}
        title={t("policies.title")}
      >
        {policies.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void policies.refetch()}
              reason={policies.error.message}
              title={t("policies.errorTitle")}
            />
          </div>
        ) : policies.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="h-12 animate-pulse rounded-md bg-muted/60" />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={t("policies.emptyDescription")}
              icon={CalendarClock}
              title={t("policies.emptyTitle")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("policies.tableAria")} className="min-w-[900px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("policies.policy")}</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("policies.schedule")}</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                    {t("policies.scope")}
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    {t("policies.devices")}
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                    {t("policies.retention")}
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) xl:table-cell">
                    {t("policies.lastEnqueued")}
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">{t("policies.active")}</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x) text-end">
                    {t("policies.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((policy) => {
                  const hint = cronHint(policy.cronExpr, t);
                  return (
                    <TableRow key={policy.id}>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <span className="text-sm font-medium">{policy.name}</span>
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <div className="flex flex-col">
                          <span className="font-tech text-sm ltr-technical">
                            {policy.cronExpr}
                          </span>
                          {hint && (
                            <span className="text-xs text-muted-foreground">{hint}</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) max-w-[280px] px-(--density-cell-x) lg:table-cell">
                        <ScopeChips policy={policy} />
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) tabular-nums sm:table-cell">
                        {policy.scopedDeviceCount}
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs tabular-nums md:table-cell">
                        {t("policies.days", { count: policy.retentionDays })}
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground tabular-nums xl:table-cell">
                        {policy.lastEnqueuedAt
                          ? formatDistanceToNow(new Date(policy.lastEnqueuedAt), {
                              addSuffix: true,
                            })
                          : t("policies.never")}
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <Switch
                          aria-label={t("policies.toggle", {
                            action: policy.isActive ? t("policies.pause") : t("policies.enable"),
                            name: policy.name,
                          })}
                          checked={policy.isActive}
                          disabled={updatePolicy.isPending}
                          onCheckedChange={(checked) =>
                            updatePolicy.mutate({
                              id: policy.id,
                              data: { isActive: checked },
                            })
                          }
                        />
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x) text-end">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            aria-label={t("policies.editAria", { name: policy.name })}
                            onClick={() => {
                              setEditing(policy);
                              setFormOpen(true);
                            }}
                            size="sm"
                            variant="ghost"
                          >
                            <Pencil aria-hidden="true" />
                            <span className="sr-only">{t("policies.edit")}</span>
                          </Button>
                          <Button
                            aria-label={t("policies.deleteAria", { name: policy.name })}
                            onClick={() => setDeleting(policy)}
                            size="sm"
                            variant="ghost"
                          >
                            <Trash2 aria-hidden="true" className="text-danger" />
                            <span className="sr-only">{t("policies.delete")}</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <PolicyFormDialog
        onOpenChange={setFormOpen}
        open={formOpen}
        policy={editing}
      />

      <AlertDialog
        onOpenChange={(open) => !open && setDeleting(null)}
        open={deleting !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("policies.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("policies.deleteDescription", { name: deleting?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("policies.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-danger text-white hover:bg-danger/90")}
              onClick={() => {
                if (deleting) deletePolicy.mutate(deleting.id);
                setDeleting(null);
              }}
            >
              {t("policies.deletePolicy")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                 */
/* ------------------------------------------------------------------ */

export function BackupsView() {
  const t = useTranslations("backups");
  const [tab, setTab] = useState("history");

  return (
    <div className="flex flex-col gap-4">
      <div data-tour="backups-header">
        <PageHeader
          description={t("page.description")}
          title={t("page.title")}
        />
      </div>
      <Tabs
        onValueChange={setTab}
        value={tab}
      >
        <TabsList>
          <TabsTrigger value="history">{t("page.history")}</TabsTrigger>
          <TabsTrigger value="policies">{t("page.policies")}</TabsTrigger>
        </TabsList>
        <TabsContent className="mt-4" value="history">
          <HistoryTab />
        </TabsContent>
        <TabsContent className="mt-4" value="policies">
          <PoliciesTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
