"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import {
  Activity,
  ArrowLeftRight,
  CalendarRange,
  CircleCheck,
  DatabaseBackup,
  Download,
  Gauge,
  Loader2,
  Play,
  Save,
  Siren,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  useRunReportBuilder,
  type ReportBuilderArtifact,
} from "@/hooks/api/use-report-builder";
import {
  useCreateReportSchedule,
  type ReportFormatKey,
  type ReportFrequencyKey,
  type ReportScheduleMutationResult,
  type ReportTypeKey,
} from "@/hooks/api/use-reports";
import { useToast } from "@/hooks/use-toast";
import { EmptyState } from "@/components/domain/empty-state";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
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
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
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
import { useNavigationStore } from "@/stores/navigation";
import { cn } from "@/lib/utils";

/**
 * Report Builder (Task 18-c — "reports.builder").
 *
 * Compose a custom report from the five report types and run it ON DEMAND
 * against POST /api/v1/reports/run (read-only generation, audited
 * REPORT_BUILT with an RB-XXXXXX correlation id):
 *   1. builder card — report type as selectable radio cards, frequency +
 *      format selects, Run preview + Save-as-schedule actions;
 *   2. preview panel — artifact meta (generatedAt / range / rows /
 *      correlationId / delivery-format tag) and the tabular artifact with
 *      sticky header, CSV + JSON downloads (client-side RFC-4180 mirror of
 *      artifactToCsv);
 *   3. save-as-schedule dialog — name + recipients over the SAME
 *      type/frequency/format selection, POSTs /api/v1/reports/schedules
 *      (reuse of the existing schedules hook) with an "Open scheduled
 *      reports" deep link on success.
 *
 * PDF/XLSX honesty note: on this demo platform the scheduled pipeline tags
 * the delivery format only (artifact rows/columns are identical) — the same
 * is true here, so CSV/JSON downloads stay enabled for every format and the
 * meta line surfaces the requested delivery tag.
 *
 * The server module src/lib/reports/generate.ts imports the db client and
 * can never be imported from client code — the two tiny pure helpers it
 * exports (expectedRangeFor / artifactToCsv) are mirrored below.
 */

const REPORT_TYPE_KEYS: readonly ReportTypeKey[] = [
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

const TYPE_ICONS: Record<ReportTypeKey, LucideIcon> = {
  AVAILABILITY: Activity,
  BACKUP_COMPLIANCE: DatabaseBackup,
  CHANGE_SUMMARY: ArrowLeftRight,
  INCIDENT_SUMMARY: Siren,
  CAPACITY: Gauge,
};

/** Same whitelist as the reports.ranges.* i18n keys. */
const RANGE_KEYS = [
  "LAST_24_HOURS",
  "LAST_7_DAYS",
  "LAST_30_DAYS",
  "CURRENT_SNAPSHOT",
] as const;

/**
 * Mirrors expectedRangeFor in generate.ts (server module — imports the db
 * client, hence this deliberate client-side duplicate). Pure mapping from
 * type + frequency to the analysis-window enum; labels resolve through the
 * existing reports.ranges.* keys.
 */
function expectedRangeFor(
  reportType: ReportTypeKey,
  frequency: ReportFrequencyKey
): string {
  if (reportType === "AVAILABILITY") {
    return frequency === "DAILY" ? "LAST_24_HOURS" : "LAST_7_DAYS";
  }
  if (reportType === "BACKUP_COMPLIANCE") return "CURRENT_SNAPSHOT";
  return "LAST_30_DAYS";
}

/**
 * Mirrors artifactToCsv in generate.ts (client-side copy for the download
 * buttons). RFC-4180: fields containing commas/quotes/newlines are quoted,
 * embedded quotes doubled, CRLF line endings, null cells empty.
 */
function artifactToCsv(artifact: ReportBuilderArtifact): string {
  const escape = (value: string | number | null | undefined): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: string[] = [
    artifact.columns.map((column) => escape(column.label)).join(","),
  ];
  for (const row of artifact.rows) {
    lines.push(
      artifact.columns.map((column) => escape(row[column.key])).join(",")
    );
  }
  return lines.join("\r\n") + "\r\n";
}

/** Blob + object-URL download with a deferred revoke (small text files). */
function downloadTextFile(filename: string, mime: string, text: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Basic recipient validation (same shape the schedules API enforces). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ReportBuilderView() {
  const t = useTranslations("builder");
  const tRoot = useTranslations("reports");
  const tCommon = useTranslations("common");
  const { toast } = useToast();
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  const run = useRunReportBuilder();
  const createSchedule = useCreateReportSchedule();

  // Builder selection — shared by the run and the save-as-schedule dialog.
  const [reportType, setReportType] = useState<ReportTypeKey>("AVAILABILITY");
  const [frequency, setFrequency] = useState<ReportFrequencyKey>("WEEKLY");
  const [deliveryFormat, setDeliveryFormat] =
    useState<ReportFormatKey>("CSV");

  const [artifact, setArtifact] = useState<ReportBuilderArtifact | null>(null);
  const [correlationId, setCorrelationId] = useState<string | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [savedName, setSavedName] = useState("");
  const [recipients, setRecipients] = useState("");
  const [nameError, setNameError] = useState(false);
  const [recipientsError, setRecipientsError] = useState(false);
  const [savedResult, setSavedResult] =
    useState<ReportScheduleMutationResult | null>(null);

  const rangeLabel = (range: string): string =>
    (RANGE_KEYS as readonly string[]).includes(range)
      ? tRoot(`ranges.${range}`)
      : range;

  const onRun = () => {
    run.mutate(
      { reportType, frequency, format: deliveryFormat },
      {
        onSuccess: (result) => {
          setArtifact(result.artifact);
          setCorrelationId(result.correlationId);
        },
        onError: (error: Error) =>
          toast({
            title: t("toast.runFailed"),
            description: error.message,
            variant: "destructive",
          }),
      }
    );
  };

  const openSaveDialog = () => {
    setSavedName("");
    setRecipients("");
    setNameError(false);
    setRecipientsError(false);
    setSavedResult(null);
    setSaveOpen(true);
  };

  const submitSchedule = () => {
    const trimmedName = savedName.trim();
    const parsedRecipients = recipients
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);

    const nameOk = trimmedName.length >= 1 && trimmedName.length <= 120;
    const recipientsOk =
      parsedRecipients.length >= 1 &&
      parsedRecipients.length <= 20 &&
      parsedRecipients.every((entry) => EMAIL_RE.test(entry));
    setNameError(!nameOk);
    setRecipientsError(!recipientsOk);
    if (!nameOk || !recipientsOk) return;

    createSchedule.mutate(
      {
        name: trimmedName,
        reportType,
        frequency,
        format: deliveryFormat,
        recipients: parsedRecipients,
        isActive: true,
      },
      {
        onSuccess: (result) => {
          toast({
            title: t("toast.saved"),
            description: t("toast.savedDescription", {
              name: result.schedule.name,
            }),
          });
          setSavedResult(result);
        },
        onError: (error: Error) =>
          toast({
            title: t("toast.saveFailed"),
            description: error.message,
            variant: "destructive",
          }),
      }
    );
  };

  const onDownload = (kind: "CSV" | "JSON") => {
    if (!artifact) return;
    const stamp = format(new Date(artifact.generatedAt), "yyyyMMdd-HHmmss");
    const base = `fayanms-${artifact.reportType.toLowerCase()}-${stamp}`;
    if (kind === "CSV") {
      downloadTextFile(`${base}.csv`, "text/csv;charset=utf-8", artifactToCsv(artifact));
    } else {
      downloadTextFile(
        `${base}.json`,
        "application/json;charset=utf-8",
        JSON.stringify(artifact, null, 2)
      );
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader description={t("description")} title={t("title")} />

      {/* Builder card */}
      <SectionCard
        contentClassName="p-4 flex flex-col gap-5 sm:p-6"
        description={t("cardDescription")}
        title={t("cardTitle")}
      >
        <div className="flex flex-col gap-2">
          <Label>{t("typeGroupLabel")}</Label>
          <RadioGroup
            aria-label={t("typeGroupAria")}
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onValueChange={(value) => setReportType(value as ReportTypeKey)}
            value={reportType}
          >
            {REPORT_TYPE_KEYS.map((type) => {
              const Icon = TYPE_ICONS[type];
              const selected = reportType === type;
              return (
                <Label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border bg-surface-subtle p-4 transition-colors hover:bg-accent/40",
                    selected && "border-primary ring-1 ring-primary"
                  )}
                  key={type}
                >
                  <RadioGroupItem className="mt-0.5 shrink-0" value={type} />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">{tRoot(`types.${type}`)}</span>
                    </span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {t(`typeHint.${type}`)}
                    </span>
                    <span className="text-[11px] font-normal text-muted-foreground">
                      {t("rangeHint", {
                        range: rangeLabel(expectedRangeFor(type, frequency)),
                      })}
                    </span>
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:max-w-xl">
          <div className="flex flex-col gap-1.5">
            <Label>{t("frequencyLabel")}</Label>
            <Select
              onValueChange={(value) =>
                setFrequency(value as ReportFrequencyKey)
              }
              value={frequency}
            >
              <SelectTrigger aria-label={t("frequencyAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_FREQUENCIES.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {tRoot(`frequencies.${entry}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{t("formatLabel")}</Label>
            <Select
              onValueChange={(value) =>
                setDeliveryFormat(value as ReportFormatKey)
              }
              value={deliveryFormat}
            >
              <SelectTrigger aria-label={t("formatAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_FORMATS.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    {tRoot(`formats.${entry}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("formatNote")}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={run.isPending} onClick={onRun}>
            {run.isPending ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Play aria-hidden="true" />
            )}
            {t("run")}
          </Button>
          <Button onClick={openSaveDialog} variant="outline">
            <Save aria-hidden="true" />
            {t("saveSchedule")}
          </Button>
        </div>

        {/* Run failure — destructive alert with the envelope message */}
        {run.isError && (
          <Alert variant="destructive">
            <AlertTitle>{t("errorTitle")}</AlertTitle>
            <AlertDescription>
              {run.error instanceof Error ? run.error.message : ""}
            </AlertDescription>
          </Alert>
        )}

        {/* Empty state before the first run */}
        {!artifact && !run.isError && (
          <EmptyState
            description={t("emptyDescription")}
            icon={CalendarRange}
            title={t("emptyTitle")}
          />
        )}
      </SectionCard>

      {/* Preview panel — appears after the first successful run */}
      {artifact && (
        <SectionCard
          contentClassName="p-0"
          title={`${t("previewTitle")} — ${tRoot(`types.${artifact.reportType}`)}`}
          actions={
            <div className="flex items-center gap-2">
              <Button
                onClick={() => onDownload("CSV")}
                size="sm"
                variant="outline"
              >
                <Download aria-hidden="true" />
                {t("downloadCsv")}
              </Button>
              <Button
                onClick={() => onDownload("JSON")}
                size="sm"
                variant="outline"
              >
                <Download aria-hidden="true" />
                {t("downloadJson")}
              </Button>
            </div>
          }
        >
          {/* Meta line: generatedAt · range · rows · correlationId · delivery format tag */}
          <div className="flex flex-col gap-1 border-b px-4 py-3 text-xs text-muted-foreground sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4 sm:px-6">
            <span>
              {t("metaGeneratedAt")}:{" "}
              <span className="font-tech tabular-nums ltr-technical">
                {format(new Date(artifact.generatedAt), "MMM d, HH:mm:ss")}
              </span>
            </span>
            <span>
              {t("metaRange")}:{" "}
              <span className="text-foreground">
                {rangeLabel(artifact.range)}
              </span>
            </span>
            <span>
              {t("metaRows")}:{" "}
              <span className="tabular-nums text-foreground">
                {artifact.rows.length}
              </span>
            </span>
            {correlationId && (
              <span>
                {t("metaCorrelation")}:{" "}
                <span className="font-tech ltr-technical">
                  {correlationId}
                </span>
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 font-tech text-[11px] ltr-technical">
              {t("metaFormat")}: {artifact.format}
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <div className="overflow-x-auto">
              <Table
                aria-label={t("previewTableAria")}
                className="min-w-[640px]"
              >
                <TableHeader className="sticky top-0 z-10 bg-card">
                  <TableRow className="hover:bg-transparent">
                    {artifact.columns.map((column) => (
                      <TableHead
                        className="h-(--density-row-h) whitespace-nowrap px-(--density-cell-x)"
                        key={column.key}
                        scope="col"
                      >
                        {column.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {artifact.rows.map((row, rowIndex) => (
                    <TableRow key={rowIndex}>
                      {artifact.columns.map((column) => {
                        const value = row[column.key];
                        return (
                          <TableCell
                            className="h-(--density-row-h) whitespace-nowrap px-(--density-cell-x) font-tech text-xs ltr-technical tabular-nums"
                            key={column.key}
                          >
                            {value === null || value === undefined
                              ? "—"
                              : String(value)}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </SectionCard>
      )}

      {/* Save-as-schedule dialog — reuses the SAME builder selection */}
      <Dialog onOpenChange={setSaveOpen} open={saveOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("dialog.title")}</DialogTitle>
            <DialogDescription>{t("dialog.description")}</DialogDescription>
          </DialogHeader>

          {savedResult ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2 rounded-md border bg-success-subtle p-4">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <CircleCheck aria-hidden="true" className="size-4 text-success" />
                  {t("success.title")}
                </span>
                <p className="text-sm text-muted-foreground">
                  {t("success.body", { name: savedResult.schedule.name })}
                </p>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => setSaveOpen(false)}
                  variant="outline"
                >
                  {t("success.close")}
                </Button>
                <Button
                  onClick={() => {
                    setActiveView("reports.scheduled");
                    setSaveOpen(false);
                  }}
                >
                  {t("success.openScheduled")}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border bg-surface-subtle px-3 py-2.5 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">
                  {t("dialog.selectionSummary")}
                </p>
                <p className="mt-1">
                  {tRoot(`types.${reportType}`)} ·{" "}
                  {tRoot(`frequencies.${frequency}`)} ·{" "}
                  {tRoot(`formats.${deliveryFormat}`)}
                </p>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rb-schedule-name">{t("dialog.name")} *</Label>
                <Input
                  aria-invalid={nameError}
                  id="rb-schedule-name"
                  maxLength={120}
                  onChange={(event) => {
                    setSavedName(event.target.value);
                    if (nameError) setNameError(false);
                  }}
                  placeholder={t("dialog.namePlaceholder")}
                  value={savedName}
                />
                {nameError && (
                  <p className="text-xs text-danger">{t("dialog.nameInvalid")}</p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="rb-schedule-recipients">
                  {t("dialog.recipients")} *
                </Label>
                <Input
                  aria-invalid={recipientsError}
                  className="ltr-technical"
                  id="rb-schedule-recipients"
                  onChange={(event) => {
                    setRecipients(event.target.value);
                    if (recipientsError) setRecipientsError(false);
                  }}
                  placeholder={t("dialog.recipientsPlaceholder")}
                  value={recipients}
                />
                {recipientsError ? (
                  <p className="text-xs text-danger">
                    {t("dialog.recipientsInvalid")}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t("dialog.recipientsHint")}
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button
                  onClick={() => setSaveOpen(false)}
                  type="button"
                  variant="outline"
                >
                  {tCommon("cancel")}
                </Button>
                <Button disabled={createSchedule.isPending} onClick={submitSchedule}>
                  {createSchedule.isPending ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : null}
                  {t("dialog.submit")}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
