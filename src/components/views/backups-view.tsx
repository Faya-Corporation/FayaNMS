"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format, formatDistanceToNow } from "date-fns";
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
  { value: "LOW", label: "Low" },
  { value: "MEDIUM", label: "Medium" },
  { value: "HIGH", label: "High" },
  { value: "CRITICAL", label: "Critical" },
];

// OFFLINE/UNMANAGED are never scheduled by the worker, so the scope
// include-filter does not offer them.
const STATUS_OPTIONS = [
  { value: "ONLINE", label: "Online" },
  { value: "DEGRADED", label: "Degraded" },
  { value: "MAINTENANCE", label: "Maintenance" },
  { value: "UNKNOWN", label: "Unknown" },
];

const CRON_PRESETS = [
  { label: "Daily 02:00", value: "0 2 * * *" },
  { label: "Every 6h", value: "0 */6 * * *" },
  { label: "Weekly Sun 03:00", value: "0 3 * * 0" },
];

function formatSize(sizeBytes: number): string {
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

/* ------------------------------------------------------------------ */
/* History tab                                                          */
/* ------------------------------------------------------------------ */

function HistoryTab() {
  const { toast } = useToast();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

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
        title: "Download started — recorded in audit log",
        description: `${row.hostname} v${row.version} · ${filename}`,
      });
    } catch (error) {
      toast({
        title: "Download failed",
        description: error instanceof Error ? error.message : "Unknown error",
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
      <SelectTrigger aria-label="Filter by snapshot status" className="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All statuses</SelectItem>
        {Object.values(SNAPSHOT_STATUS).map((config) => (
          <SelectItem key={config.key} value={config.key}>
            {config.label}
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
      <SelectTrigger aria-label="Filter by capture source" className="h-8 w-36 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All sources</SelectItem>
        {Object.values(SNAPSHOT_SOURCE).map((config) => (
          <SelectItem key={config.key} value={config.key}>
            {config.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <SectionCard
      contentClassName="p-0"
      description="Every configuration version captured across the fleet — raw downloads are audited"
      title="Backup history"
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search
            aria-hidden="true"
            className="absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label="Search by device hostname or IP"
            className="h-8 ps-8 text-xs"
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search device…"
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
          Reset
        </Button>
        <Button
          className="ms-auto"
          onClick={() => setActiveView("network.devices")}
          size="sm"
          variant="outline"
        >
          Backup now — open Devices
        </Button>
      </div>

      {snapshots.isError ? (
        <div className="p-4">
          <ErrorState
            onRetry={() => void snapshots.refetch()}
            reason={snapshots.error.message}
            title="Backup history could not be loaded"
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
            description="Trigger “Backup now” from a device, or let a schedule run — captured configurations appear here."
            icon={CloudUpload}
            title="No backup snapshots found"
          />
        </div>
      ) : (
        <div className="max-h-[600px] overflow-y-auto">
          <div className="min-w-[980px]">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Time</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Device</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                    Site
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Version</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    Source
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    Size
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                    SHA-256
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Status</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                    Correlation
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x) text-end">
                    Action
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
                        aria-label={`Open ${row.hostname} device detail`}
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
                        aria-label={`Download ${row.hostname} configuration v${row.version}`}
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
                        <span className="sr-only sm:not-sr-only">Download</span>
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
            {metaInfo.total} snapshot{metaInfo.total === 1 ? "" : "s"} · page{" "}
            {metaInfo.page} of {metaInfo.totalPages}
          </span>
          <div className="flex items-center gap-1">
            <Button
              aria-label="Previous page"
              disabled={metaInfo.page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              size="sm"
              variant="outline"
            >
              <ChevronLeft aria-hidden="true" />
              Prev
            </Button>
            <Button
              aria-label="Next page"
              disabled={metaInfo.page >= metaInfo.totalPages}
              onClick={() => setPage((p) => p + 1)}
              size="sm"
              variant="outline"
            >
              Next
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

const policyFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  cronExpr: z
    .string()
    .trim()
    .min(1, "Cron expression is required")
    .refine(isValidCronExpr, {
      message: "Use a 5-field numeric cron expression, e.g. 0 2 * * *",
    }),
  siteCodes: z.array(z.string()),
  criticalities: z.array(z.string()),
  statuses: z.array(z.string()),
  // Kept as a string input so zodResolver's input/output types align with
  // the form values; converted to a number on submit.
  retentionDays: z
    .string()
    .trim()
    .min(1, "Retention is required")
    .regex(/^\d+$/, "Whole days only")
    .refine((value) => {
      const n = Number(value);
      return n >= 1 && n <= 3650;
    }, "Retention must be between 1 and 3650 days"),
  isActive: z.boolean(),
});

type PolicyFormValues = z.infer<typeof policyFormSchema>;

interface CheckboxGroupProps {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  error?: string;
}

function CheckboxGroup({
  label,
  hint,
  options,
  value,
  onChange,
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
                aria-label={`Scope ${label}: ${option.label}`}
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
  const meta = useMeta();
  const createPolicy = useCreateBackupPolicy();
  const updatePolicy = useUpdateBackupPolicy();

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
    resolver: zodResolver(policyFormSchema),
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
    { value: "*", label: "All sites (fleet-wide)" },
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

  const hint = cronHint(cronExpr ?? "");

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit backup policy" : "New backup policy"}</DialogTitle>
          <DialogDescription>
            The worker scheduler evaluates active policies every 30 seconds —
            saved changes become live schedules automatically.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-name">Name *</Label>
            <Input
              {...form.register("name")}
              aria-invalid={Boolean(form.formState.errors.name)}
              id="policy-name"
              placeholder="Daily Full Fleet 02:00"
            />
            {form.formState.errors.name && (
              <p className="text-xs text-danger">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="policy-cron">Schedule (cron) *</Label>
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
                  {preset.label}
                </Button>
              ))}
            </div>
            <Input
              {...form.register("cronExpr")}
              aria-invalid={Boolean(form.formState.errors.cronExpr)}
              className="font-tech ltr-technical"
              id="policy-cron"
              placeholder="0 2 * * *"
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
            hint="Devices from the selected sites. Leave empty for all sites."
            label="Sites"
            onChange={handleSiteCodesChange}
            options={siteOptions}
            value={siteCodes ?? []}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <CheckboxGroup
              label="Criticalities"
              onChange={(next) =>
                form.setValue("criticalities", next, { shouldValidate: true })
              }
              options={CRITICALITY_OPTIONS}
              value={criticalities ?? []}
            />
            <CheckboxGroup
              hint="Offline and unmanaged devices are never scheduled."
              label="Statuses"
              onChange={(next) =>
                form.setValue("statuses", next, { shouldValidate: true })
              }
              options={STATUS_OPTIONS}
              value={statuses ?? []}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-retention">Retention (days) *</Label>
              <Input
                {...form.register("retentionDays")}
                aria-invalid={Boolean(form.formState.errors.retentionDays)}
                id="policy-retention"
                inputMode="numeric"
              />
              <p className="text-xs text-muted-foreground">
                Historical versions older than this are pruned by the scheduler.
              </p>
              {form.formState.errors.retentionDays && (
                <p className="text-xs text-danger">
                  {form.formState.errors.retentionDays.message}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="policy-active">Active</Label>
              <div className="flex h-9 items-center gap-2">
                <Switch
                  aria-label="Policy active"
                  checked={isActive}
                  id="policy-active"
                  onCheckedChange={(checked) => form.setValue("isActive", checked)}
                />
                <span className="text-sm text-muted-foreground">
                  {isActive ? "Scheduler runs this policy" : "Paused"}
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
              Cancel
            </Button>
            <Button disabled={pending} type="submit">
              {pending && <LoaderCircle aria-hidden="true" className="animate-spin" />}
              {editing ? "Save changes" : "Create policy"}
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
  const { scope } = policy;
  const chips: { label: string; value: string }[] = [];

  if (scope.siteCodes.length > 0) {
    chips.push({
      label: "Sites",
      value: scope.siteCodes.includes("*")
        ? "All sites"
        : scope.siteCodes.join(", "),
    });
  }
  for (const criticality of scope.criticalities) {
    chips.push({
      label: "Criticality",
      value:
        CRITICALITY_OPTIONS.find((option) => option.value === criticality)?.label ??
        criticality,
    });
  }
  for (const status of scope.statuses) {
    chips.push({
      label: "Status",
      value: getStatusConfig(DEVICE_STATUS, status).label,
    });
  }

  if (chips.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        Fleet-wide — all manageable devices
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
            New policy
          </Button>
        }
        description="Schedules evaluated by the worker every 30 seconds; retention pruning runs on each tick"
        title="Backup policies"
      >
        {policies.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void policies.refetch()}
              reason={policies.error.message}
              title="Backup policies could not be loaded"
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
              description="Create a policy with a cron schedule and scope — it starts enqueueing backup jobs on the next tick."
              icon={CalendarClock}
              title="No backup policies yet"
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Policy</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Schedule</TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) lg:table-cell">
                    Scope
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) sm:table-cell">
                    Devices
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) md:table-cell">
                    Retention
                  </TableHead>
                  <TableHead className="hidden h-(--density-row-h) px-(--density-cell-x) xl:table-cell">
                    Last enqueued
                  </TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x)">Active</TableHead>
                  <TableHead className="h-(--density-row-h) px-(--density-cell-x) text-end">
                    Actions
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((policy) => {
                  const hint = cronHint(policy.cronExpr);
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
                        {policy.retentionDays} days
                      </TableCell>
                      <TableCell className="hidden h-(--density-row-h) px-(--density-cell-x) text-xs text-muted-foreground tabular-nums xl:table-cell">
                        {policy.lastEnqueuedAt
                          ? formatDistanceToNow(new Date(policy.lastEnqueuedAt), {
                              addSuffix: true,
                            })
                          : "never"}
                      </TableCell>
                      <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                        <Switch
                          aria-label={`${policy.isActive ? "Pause" : "Enable"} policy ${policy.name}`}
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
                            aria-label={`Edit policy ${policy.name}`}
                            onClick={() => {
                              setEditing(policy);
                              setFormOpen(true);
                            }}
                            size="sm"
                            variant="ghost"
                          >
                            <Pencil aria-hidden="true" />
                            <span className="sr-only">Edit</span>
                          </Button>
                          <Button
                            aria-label={`Delete policy ${policy.name}`}
                            onClick={() => setDeleting(policy)}
                            size="sm"
                            variant="ghost"
                          >
                            <Trash2 aria-hidden="true" className="text-danger" />
                            <span className="sr-only">Delete</span>
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
            <AlertDialogTitle>Delete backup policy?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleting?.name}” will stop enqueueing scheduled backups. Existing
              snapshots, jobs and audit history are kept. This action is recorded
              in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn("bg-danger text-white hover:bg-danger/90")}
              onClick={() => {
                if (deleting) deletePolicy.mutate(deleting.id);
                setDeleting(null);
              }}
            >
              Delete policy
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
  const [tab, setTab] = useState("history");

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        description="Fleet-wide configuration backup history, policies and retention"
        title="Backups"
      />
      <Tabs
        onValueChange={setTab}
        value={tab}
      >
        <TabsList>
          <TabsTrigger value="history">History</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
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
