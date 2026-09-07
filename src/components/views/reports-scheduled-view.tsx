"use client";

import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { format, formatDistanceToNow } from "date-fns";
import {
  CalendarClock,
  CalendarRange,
  CircleCheck,
  FileText,
  Mail,
  Pencil,
  Play,
  Plus,
  Trash2,
} from "lucide-react";

import {
  useCreateReportSchedule,
  useDeleteReportSchedule,
  useReportSchedules,
  useRunReportNow,
  useUpdateReportSchedule,
  type ReportFormatKey,
  type ReportFrequencyKey,
  type ReportScheduleRow,
  type ReportTypeKey,
} from "@/hooks/api/use-reports";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { ErrorState } from "@/components/domain/error-state";
import { KpiCard } from "@/components/domain/kpi-card";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/**
 * Scheduled Reports — Task 9-a "reports.scheduled".
 *
 * KPI row (active schedules / runs 7 d / success rate / next-run estimate),
 * schedule table (active switch, run-now, edit dialog, guarded delete) and
 * the create/edit dialog. "Run now" queues a REPORT_RUN job and toasts the
 * shared REP-XXXXXX correlation id; the run shows up in the Reports history
 * within ~5–10 s (worker claims every 3 s).
 */

const REPORT_TYPES: readonly ReportTypeKey[] = [
  "AVAILABILITY",
  "BACKUP_COMPLIANCE",
  "CHANGE_SUMMARY",
  "INCIDENT_SUMMARY",
  "CAPACITY",
];
const REPORT_FREQUENCIES: readonly ReportFrequencyKey[] = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "QUARTERLY",
];
const REPORT_FORMATS: readonly ReportFormatKey[] = [
  "PDF",
  "XLSX",
  "CSV",
  "JSON",
];

/** Basic recipient validation (same shape the API enforces via Zod). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const scheduleFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  reportType: z.enum([
    "AVAILABILITY",
    "BACKUP_COMPLIANCE",
    "CHANGE_SUMMARY",
    "INCIDENT_SUMMARY",
    "CAPACITY",
  ]),
  frequency: z.enum(["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY"]),
  format: z.enum(["PDF", "XLSX", "CSV", "JSON"]),
  recipients: z
    .string()
    .trim()
    .min(1, "Enter at least one valid email address.")
    .refine(
      (value) =>
        value
          .split(",")
          .map((entry) => entry.trim().toLowerCase())
          .filter((entry) => entry.length > 0)
          .every((entry) => EMAIL_RE.test(entry)),
      "Enter at least one valid email address."
    )
    .refine(
      (value) =>
        value.split(",").filter((entry) => entry.trim().length > 0).length <=
        20,
      "At most 20 recipients are allowed."
    ),
  isActive: z.boolean(),
});

type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

function fmtRelative(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

function fmtAbsolute(iso: string): string {
  return format(new Date(iso), "MMM d, HH:mm");
}

function RecipientChips({ recipients }: { recipients: string[] }) {
  const visible = recipients.slice(0, 2);
  const rest = recipients.length - visible.length;
  return (
    <div className="flex max-w-[26ch] flex-wrap items-center gap-1">
      {visible.map((email) => (
        <span
          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-[11px] ltr-technical"
          key={email}
          title={email}
        >
          <Mail aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{email}</span>
        </span>
      ))}
      {rest > 0 && (
        <span
          className="rounded-full border bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground"
          title={recipients.slice(2).join(", ")}
        >
          +{rest}
        </span>
      )}
    </div>
  );
}

function ScheduleFormDialog({
  open,
  onOpenChange,
  row,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ReportScheduleRow | null;
}) {
  const t = useTranslations("reports.scheduled");
  const tRoot = useTranslations("reports");
  const tCommon = useTranslations("common");
  const { toast } = useToast();
  const createSchedule = useCreateReportSchedule();
  const updateSchedule = useUpdateReportSchedule();

  const editing = Boolean(row);
  const defaultValues: ScheduleFormValues = useMemo(
    () => ({
      name: row?.name ?? "",
      reportType: row?.reportType ?? "BACKUP_COMPLIANCE",
      frequency: row?.frequency ?? "WEEKLY",
      format: row?.format ?? "CSV",
      recipients: row ? row.recipients.join(", ") : "",
      isActive: row?.isActive ?? true,
    }),
    [row]
  );

  const form = useForm<ScheduleFormValues>({
    defaultValues,
    resolver: zodResolver(scheduleFormSchema),
    mode: "onSubmit",
  });

  // Reset when the dialog opens so editing a different row starts clean.
  useEffect(() => {
    if (open) form.reset(defaultValues);
  }, [open, defaultValues, form]);

  const watchedType = useWatch({ control: form.control, name: "reportType" });
  const watchedFrequency = useWatch({
    control: form.control,
    name: "frequency",
  });
  const watchedFormat = useWatch({ control: form.control, name: "format" });
  const watchedActive = useWatch({ control: form.control, name: "isActive" });

  const pending = createSchedule.isPending || updateSchedule.isPending;

  const onSubmit = (values: ScheduleFormValues) => {
    const payload = {
      name: values.name.trim(),
      reportType: values.reportType,
      frequency: values.frequency,
      format: values.format,
      recipients: values.recipients
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
      isActive: values.isActive,
    };

    if (editing && row) {
      updateSchedule.mutate(
        { id: row.id, data: payload },
        {
          onSuccess: (result) => {
            toast({
              title: t("toast.updated"),
              description: t("toast.updatedDescription", {
                name: result.schedule.name,
              }),
            });
            onOpenChange(false);
          },
          onError: (error: Error) =>
            toast({
              title: t("toast.updateFailed"),
              description: error.message,
              variant: "destructive",
            }),
        }
      );
      return;
    }

    createSchedule.mutate(payload, {
      onSuccess: (result) => {
        toast({
          title: t("toast.created"),
          description: t("toast.createdDescription", {
            name: result.schedule.name,
            frequency: tRoot(`frequencies.${result.schedule.frequency}`),
            type: tRoot(`types.${result.schedule.reportType}`),
            format: result.schedule.format,
          }),
        });
        onOpenChange(false);
      },
      onError: (error: Error) =>
        toast({
          title: t("toast.createFailed"),
          description: error.message,
          variant: "destructive",
        }),
    });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? t("dialog.editTitle") : t("dialog.createTitle")}
          </DialogTitle>
          <DialogDescription>{t("dialog.description")}</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit(onSubmit)}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rs-name">{t("dialog.name")} *</Label>
            <Input
              {...form.register("name")}
              aria-invalid={Boolean(form.formState.errors.name)}
              id="rs-name"
              placeholder={t("dialog.namePlaceholder")}
            />
            {form.formState.errors.name && (
              <p className="text-xs text-danger">
                {form.formState.errors.name.message}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>{t("dialog.type")}</Label>
              <Select
                onValueChange={(value) =>
                  form.setValue("reportType", value as ReportTypeKey)
                }
                value={watchedType}
              >
                <SelectTrigger aria-label={t("dialog.typeAria")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {tRoot(`types.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t("dialog.frequency")}</Label>
              <Select
                onValueChange={(value) =>
                  form.setValue("frequency", value as ReportFrequencyKey)
                }
                value={watchedFrequency}
              >
                <SelectTrigger aria-label={t("dialog.frequencyAria")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_FREQUENCIES.map((frequency) => (
                    <SelectItem key={frequency} value={frequency}>
                      {tRoot(`frequencies.${frequency}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("dialog.format")}</Label>
            <Select
              onValueChange={(value) =>
                form.setValue("format", value as ReportFormatKey)
              }
              value={watchedFormat}
            >
              <SelectTrigger aria-label={t("dialog.formatAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_FORMATS.map((format) => (
                  <SelectItem key={format} value={format}>
                    <span className="flex items-center gap-2">
                      <FileText aria-hidden="true" className="size-3.5" />
                      {tRoot(`formats.${format}`)}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rs-recipients">{t("dialog.recipients")} *</Label>
            <Input
              {...form.register("recipients")}
              aria-invalid={Boolean(form.formState.errors.recipients)}
              className="ltr-technical"
              id="rs-recipients"
              placeholder={t("dialog.recipientsPlaceholder")}
              type="email"
            />
            {form.formState.errors.recipients ? (
              <p className="text-xs text-danger">
                {t("dialog.recipientsInvalid")}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("dialog.recipientsHint")}
              </p>
            )}
          </div>

          <label className="flex items-center justify-between gap-3 rounded-md border bg-surface-subtle px-3 py-2.5">
            <span className="text-sm font-medium">
              {t("dialog.active")}
              <span className="block text-xs font-normal text-muted-foreground">
                {t("dialog.activeHint")}
              </span>
            </span>
            <Switch
              aria-label={t("dialog.active")}
              checked={watchedActive}
              onCheckedChange={(checked) => form.setValue("isActive", checked)}
            />
          </label>

          <DialogFooter>
            <Button
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              {tCommon("cancel")}
            </Button>
            <Button disabled={pending} type="submit">
              {editing ? t("dialog.submitEdit") : t("dialog.submitCreate")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ReportsScheduledView() {
  const t = useTranslations("reports.scheduled");
  const tRoot = useTranslations("reports");
  const tCommon = useTranslations("common");
  const { toast } = useToast();

  const schedules = useReportSchedules({ page: 1, pageSize: 50 });
  const runNow = useRunReportNow();
  const deleteSchedule = useDeleteReportSchedule();
  const toggleSchedule = useUpdateReportSchedule();

  const [formOpen, setFormOpen] = useState(false);
  const [editRow, setEditRow] = useState<ReportScheduleRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReportScheduleRow | null>(
    null
  );

  const rows = schedules.data?.data ?? [];
  const meta = schedules.data?.meta;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        description={t("description")}
        primaryAction={
          <Button
            onClick={() => {
              setEditRow(null);
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" />
            {t("create")}
          </Button>
        }
        title={t("title")}
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          description={t("kpiActiveHint")}
          icon={CalendarRange}
          label={t("kpiActive")}
          loading={schedules.isLoading}
          value={meta?.activeSchedules ?? "—"}
        />
        <KpiCard
          description={t("kpiRuns7dHint")}
          icon={Play}
          label={t("kpiRuns7d")}
          loading={schedules.isLoading}
          value={meta?.runsLast7d ?? "—"}
        />
        <KpiCard
          description={t("kpiSuccessRateHint")}
          icon={CircleCheck}
          label={t("kpiSuccessRate")}
          loading={schedules.isLoading}
          value={
            meta?.successRate7d !== null && meta?.successRate7d !== undefined
              ? `${meta.successRate7d}%`
              : "—"
          }
        />
        <KpiCard
          description={t("kpiNextRunHint")}
          icon={CalendarClock}
          label={t("kpiNextRun")}
          loading={schedules.isLoading}
          value={
            meta?.nextEstimatedRunAt
              ? fmtRelative(meta.nextEstimatedRunAt)
              : "—"
          }
        />
      </div>

      <SectionCard contentClassName="p-0" title={`${t("title")}${meta ? ` — ${meta.total}` : ""}`}>
        {schedules.isError ? (
          <div className="p-4">
            <ErrorState
              onRetry={() => void schedules.refetch()}
              reason={
                schedules.error instanceof Error
                  ? schedules.error.message
                  : undefined
              }
              title={t("errorTitle")}
            />
          </div>
        ) : schedules.isLoading ? (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 3 }).map((_, index) => (
              <div
                key={index}
                className="h-11 animate-pulse rounded-md bg-muted/60"
              />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              description={t("emptyDescription")}
              icon={CalendarRange}
              title={t("emptyTitle")}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={t("tableAria")} className="min-w-[900px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colName")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colType")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colFrequency")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colFormat")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colRecipients")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colActive")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x)"
                    scope="col"
                  >
                    {t("colLastRun")}
                  </TableHead>
                  <TableHead
                    className="h-(--density-row-h) px-(--density-cell-x) text-end"
                    scope="col"
                  >
                    {t("colActions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} className={cn(!row.isActive && "opacity-70")}>
                    <TableCell className="h-(--density-row-h) max-w-[26ch] px-(--density-cell-x)">
                      <span
                        className="block truncate text-sm font-medium"
                        title={row.name}
                      >
                        {row.name}
                      </span>
                      <span className="font-tech text-[11px] ltr-technical text-muted-foreground">
                        {row.expectedRange}
                      </span>
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      {tRoot(`types.${row.reportType}`)}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      {tRoot(`frequencies.${row.frequency}`)}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <span className="font-tech text-xs ltr-technical">
                        {tRoot(`formats.${row.format}`)}
                      </span>
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <RecipientChips recipients={row.recipients} />
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <Switch
                        aria-label={`${row.isActive ? "Pause" : "Enable"} ${row.name}`}
                        checked={row.isActive}
                        disabled={toggleSchedule.isPending}
                        onCheckedChange={(checked) =>
                          toggleSchedule.mutate(
                            { id: row.id, data: { isActive: checked } },
                            {
                              onSuccess: (result) => {
                                toast({
                                  title: checked
                                    ? t("toast.toggledOn")
                                    : t("toast.toggledOff"),
                                  description: checked
                                    ? t("toast.toggledOnDescription", {
                                        name: result.schedule.name,
                                        frequency: tRoot(
                                          `frequencies.${result.schedule.frequency}`
                                        ),
                                      })
                                    : t("toast.toggledOffDescription", {
                                        name: result.schedule.name,
                                      }),
                                });
                              },
                              onError: (error: Error) =>
                                toast({
                                  title: t("toast.toggleFailed"),
                                  description: error.message,
                                  variant: "destructive",
                                }),
                            }
                          )
                        }
                      />
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      {row.lastRunAt ? (
                        <div className="flex flex-col">
                          <span className="font-tech text-xs ltr-technical tabular-nums">
                            {fmtAbsolute(row.lastRunAt)}
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            {fmtRelative(row.lastRunAt)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t("neverRun")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="h-(--density-row-h) px-(--density-cell-x)">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          aria-label={t("runNowAria", { name: row.name })}
                          disabled={runNow.isPending}
                          onClick={() =>
                            runNow.mutate(row.id, {
                              onSuccess: (result) => {
                                toast({
                                  title: t("toast.runQueued"),
                                  description: t("toast.runQueuedDescription", {
                                    name: result.schedule.name,
                                    correlationId: result.job.correlationId,
                                  }),
                                });
                              },
                              onError: (error: Error) =>
                                toast({
                                  title: t("toast.runFailed"),
                                  description: error.message,
                                  variant: "destructive",
                                }),
                            })
                          }
                          size="icon"
                          title={t("runNow")}
                          variant="ghost"
                        >
                          <Play aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={t("editAria", { name: row.name })}
                          onClick={() => {
                            setEditRow(row);
                            setFormOpen(true);
                          }}
                          size="icon"
                          title={t("dialog.editTitle")}
                          variant="ghost"
                        >
                          <Pencil aria-hidden="true" />
                        </Button>
                        <Button
                          aria-label={t("deleteAria", { name: row.name })}
                          onClick={() => setDeleteTarget(row)}
                          size="icon"
                          title={t("deleteTitle")}
                          variant="ghost"
                        >
                          <Trash2 aria-hidden="true" className="text-danger" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <ScheduleFormDialog
        onOpenChange={setFormOpen}
        open={formOpen}
        row={editRow}
      />

      <AlertDialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={deleteTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("deleteTitle")} “{deleteTarget?.name}”
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteDescription", { name: deleteTarget?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={() => {
                if (!deleteTarget) return;
                const target = deleteTarget;
                deleteSchedule.mutate(target.id, {
                  onSuccess: () => {
                    toast({
                      title: t("toast.deleted"),
                      description: t("toast.deletedDescription"),
                    });
                  },
                  onError: (error: Error) =>
                    toast({
                      title: t("toast.deleteFailed"),
                      description: error.message,
                      variant: "destructive",
                    }),
                  onSettled: () => setDeleteTarget(null),
                });
              }}
            >
              {tCommon("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
