"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Loader2,
  Sparkles,
} from "lucide-react";

import { aiErrorKey, useAskNetwork } from "@/hooks/api/use-ai";
import { useCurrentLocale } from "@/i18n/locale-provider";
import { ErrorState } from "@/components/domain/error-state";
import { ChangeStatusBadge } from "@/components/domain/change-status-badge";
import { DeviceStatusBadge } from "@/components/domain/device-status-badge";
import { JobStatusBadge } from "@/components/domain/job-status-badge";
import { SeverityBadge } from "@/components/domain/severity-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ApiError,
  type AskNetworkResult,
} from "@/lib/api-client";
import { useNavigationStore } from "@/stores/navigation";

/**
 * "Ask the network" dialog (Phase 14-a): an operator asks a natural-language
 * question about the whole network; the backend classifies it into a query
 * plan, executes a bounded READ-ONLY query over FayaNMS and answers strictly
 * from the returned rows. The answer panel shows the grounded summary plus
 * the structured result groups with deep links into the owning views.
 * The whole flow is read-only — nothing is ever created or modified.
 */

const PROMPT_MIN = 10;
/** Max prompt length — mirrored by the API contract (500). */
const PROMPT_MAX = 500;

const EXAMPLE_KEYS = [
  "firmware",
  "incidents",
  "changes",
  "summary",
] as const;

/** Group header: label + "View in <view>" deep link. */
function GroupHeader({
  label,
  viewLabel,
  onView,
}: {
  label: string;
  viewLabel: string;
  onView: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <Button
        className="h-7 gap-1 px-2 text-xs"
        onClick={onView}
        size="sm"
        variant="ghost"
      >
        {viewLabel}
        <ArrowRight aria-hidden="true" className="size-3 rtl:-scale-x-100" />
      </Button>
    </div>
  );
}

/**
 * Structured rendering of the query results. Every deep link (group headers
 * and row links) closes the dialog first via onNavigate, then navigates.
 */
function ResultRows({
  result,
  onNavigate,
}: {
  result: AskNetworkResult;
  /** Wraps a navigation callback with "close the dialog first". */
  onNavigate: (navigate: () => void) => () => void;
}) {
  const t = useTranslations("ai.query");
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  return (
    <div className="flex flex-col gap-5">
      {result.results.devices && result.results.devices.length > 0 && (
        <section className="flex flex-col gap-2">
          <GroupHeader
            label={`${t("devices")} (${result.results.devices.length})`}
            onView={onNavigate(() => setActiveView("network.devices"))}
            viewLabel={t("viewInDevices")}
          />
          <ul className="flex flex-col gap-1.5">
            {result.results.devices.map((row) => (
              <li
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                key={row.id}
              >
                <button
                  className="font-tech text-sm font-medium underline-offset-2 hover:underline ltr-technical"
                  onClick={onNavigate(() =>
                    setActiveView("network.device-detail", { deviceId: row.id })
                  )}
                  type="button"
                >
                  {row.hostname}
                </button>
                {row.model && (
                  <span className="truncate text-xs text-muted-foreground">
                    {row.model}
                  </span>
                )}
                {row.siteCode && (
                  <span className="font-tech text-xs text-muted-foreground ltr-technical">
                    {row.siteCode}
                  </span>
                )}
                {row.firmware && (
                  <span className="font-tech text-xs text-muted-foreground ltr-technical">
                    {row.firmware}
                  </span>
                )}
                <span className="ms-auto">
                  <DeviceStatusBadge value={row.status} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.results.incidents && result.results.incidents.length > 0 && (
        <section className="flex flex-col gap-2">
          <GroupHeader
            label={`${t("incidents")} (${result.results.incidents.length})`}
            onView={onNavigate(() => setActiveView("ops.incidents"))}
            viewLabel={t("viewInIncidents")}
          />
          <ul className="flex flex-col gap-1.5">
            {result.results.incidents.map((row) => (
              <li
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                key={row.id}
              >
                <SeverityBadge value={row.severity} />
                <button
                  className="font-tech text-sm font-medium underline-offset-2 hover:underline ltr-technical"
                  onClick={onNavigate(() =>
                    setActiveView("ops.incident-detail", { incidentId: row.id })
                  )}
                  type="button"
                >
                  {row.number}
                </button>
                <span className="min-w-0 flex-1 truncate" title={row.title}>
                  {row.title}
                </span>
                {row.siteCode && (
                  <span className="font-tech text-xs text-muted-foreground ltr-technical">
                    {row.siteCode}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.results.changes && result.results.changes.length > 0 && (
        <section className="flex flex-col gap-2">
          <GroupHeader
            label={`${t("changes")} (${result.results.changes.length})`}
            onView={onNavigate(() => setActiveView("changes.all"))}
            viewLabel={t("viewInChanges")}
          />
          <ul className="flex flex-col gap-1.5">
            {result.results.changes.map((row) => (
              <li
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                key={row.id}
              >
                <button
                  className="font-tech text-sm font-medium underline-offset-2 hover:underline ltr-technical"
                  onClick={onNavigate(() =>
                    setActiveView("changes.change-detail", { changeId: row.id })
                  )}
                  type="button"
                >
                  {row.number}
                </button>
                <span className="min-w-0 flex-1 truncate" title={row.title}>
                  {row.title}
                </span>
                <ChangeStatusBadge value={row.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.results.jobs && result.results.jobs.length > 0 && (
        <section className="flex flex-col gap-2">
          <GroupHeader
            label={`${t("jobs")} (${result.results.jobs.length})`}
            onView={onNavigate(() => setActiveView("ops.jobs"))}
            viewLabel={t("viewInJobs")}
          />
          <ul className="flex flex-col gap-1.5">
            {result.results.jobs.map((row) => (
              <li
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                key={row.correlationId}
              >
                <span className="font-tech text-xs ltr-technical">{row.type}</span>
                <JobStatusBadge value={row.status} />
                <span className="font-tech text-xs text-muted-foreground ltr-technical">
                  {row.progress}%
                </span>
                <span className="ms-auto font-tech text-xs text-muted-foreground ltr-technical">
                  {row.correlationId}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.results.predictive && result.results.predictive.length > 0 && (
        <section className="flex flex-col gap-2">
          <GroupHeader
            label={`${t("predictive")} (${result.results.predictive.length})`}
            onView={onNavigate(() => setActiveView("perf.predictive"))}
            viewLabel={t("viewInPredictive")}
          />
          <ul className="flex flex-col gap-1.5">
            {result.results.predictive.map((row) => (
              <li
                className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-sm"
                key={row.hostname}
              >
                <span className="font-tech text-sm font-medium ltr-technical">
                  {row.hostname}
                </span>
                <span className="font-tech text-xs text-muted-foreground ltr-technical">
                  {row.activeAlerts}
                </span>
                {row.worstSeverity && <SeverityBadge value={row.worstSeverity} />}
                {row.siteCode && (
                  <span className="ms-auto font-tech text-xs text-muted-foreground ltr-technical">
                    {row.siteCode}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {result.results.snapshot && (
        <section className="flex flex-col gap-2">
          <GroupHeader
            label={t("snapshot")}
            onView={onNavigate(() => setActiveView("dashboard"))}
            viewLabel={t("viewInDashboard")}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {Object.entries(result.results.snapshot.devicesByStatus).map(
              ([status, count]) => (
                <div
                  className="flex items-center justify-between gap-2 rounded-lg border bg-background px-2.5 py-1.5"
                  key={status}
                >
                  <DeviceStatusBadge value={status} />
                  <span className="font-tech text-sm tabular-nums ltr-technical">
                    {count}
                  </span>
                </div>
              )
            )}
            {Object.entries(
              result.results.snapshot.openIncidentsBySeverity
            ).map(([severity, count]) => (
              <div
                className="flex items-center justify-between gap-2 rounded-lg border bg-background px-2.5 py-1.5"
                key={severity}
              >
                <SeverityBadge value={severity} />
                <span className="font-tech text-sm tabular-nums ltr-technical">
                  {count}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between gap-2 rounded-lg border bg-background px-2.5 py-1.5">
              <span className="font-tech text-xs ltr-technical">24h</span>
              <span className="font-tech text-sm tabular-nums ltr-technical">
                {result.results.snapshot.backupJobs24h.total > 0
                  ? `${result.results.snapshot.backupJobs24h.succeeded}/${result.results.snapshot.backupJobs24h.total} · ${result.results.snapshot.backupJobs24h.successRatePct ?? 0}%`
                  : "—"}
              </span>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

export function AskNetworkDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("ai.query");
  const tAi = useTranslations("ai");
  const locale = useCurrentLocale();

  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const ask = useAskNetwork();

  const result: AskNetworkResult | undefined = ask.data;
  const error = ask.error;

  // Informative spinner: two LLM round-trips (plan + answer) can take up to
  // ~90 s worst case, so the wait state shows elapsed seconds. The tick only
  // runs while a request is in flight.
  useEffect(() => {
    if (!ask.isPending || pendingSince === null) return;
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - pendingSince) / 1000)),
      1000
    );
    return () => clearInterval(timer);
  }, [ask.isPending, pendingSince]);

  // Fresh dialog content on every open (keep the typed prompt, drop any
  // stale result/error from a previous session).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) ask.reset();
  }

  const submit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length < PROMPT_MIN || ask.isPending) return;
    setLastPrompt(trimmed);
    setPendingSince(Date.now());
    setElapsed(0);
    ask.mutate({ prompt: trimmed, locale });
  };

  const retry = () => {
    if (lastPrompt) submit(lastPrompt);
  };

  const errorReason = (() => {
    if (!error) return undefined;
    const key = aiErrorKey(error instanceof ApiError ? error.code : "");
    return key ? tAi(key) : error.message;
  })();

  const canSubmit = prompt.trim().length >= PROMPT_MIN && !ask.isPending;

  // Deep links close the dialog first, then navigate to the target view.
  const onNavigate = (navigate: () => void) => () => {
    onOpenChange(false);
    navigate();
  };

  // "Grounded in N devices / N incidents …" footer line.
  const groundedParts: string[] = [];
  if (result) {
    const deviceCount =
      (result.results.devices?.length ?? 0) +
      (result.results.predictive?.length ?? 0);
    if (result.results.snapshot) {
      groundedParts.push(t("groundedSnapshot"));
    }
    if (deviceCount > 0) {
      groundedParts.push(t("groundedDevices", { count: deviceCount }));
    }
    if ((result.results.incidents?.length ?? 0) > 0) {
      groundedParts.push(
        t("groundedIncidents", { count: result.results.incidents?.length ?? 0 })
      );
    }
    if ((result.results.changes?.length ?? 0) > 0) {
      groundedParts.push(
        t("groundedChanges", { count: result.results.changes?.length ?? 0 })
      );
    }
    if ((result.results.jobs?.length ?? 0) > 0) {
      groundedParts.push(
        t("groundedJobs", { count: result.results.jobs?.length ?? 0 })
      );
    }
  }

  const filterChips = result
    ? (
        [
          result.appliedFilters.site,
          result.appliedFilters.vendor,
          result.appliedFilters.severity,
          result.appliedFilters.status,
          result.appliedFilters.hostnameLike,
        ] as (string | null)[]
      ).filter((value): value is string => Boolean(value))
    : [];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[92vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4 pb-4 text-start">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles aria-hidden="true" className="size-4 text-primary" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 p-4">
            {/* ------------------------- ask ------------------------- */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="ask-network-prompt">{t("promptLabel")}</Label>
              <Textarea
                id="ask-network-prompt"
                maxLength={PROMPT_MAX}
                onChange={(event) =>
                  setPrompt(event.target.value.slice(0, PROMPT_MAX))
                }
                placeholder={t("placeholder")}
                rows={3}
                value={prompt}
                className="min-h-20 resize-y"
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className={
                    prompt.trim().length > 0 && prompt.trim().length < PROMPT_MIN
                      ? "font-tech text-xs text-warning ltr-technical"
                      : "font-tech text-xs text-muted-foreground ltr-technical"
                  }
                >
                  {prompt.length}/{PROMPT_MAX}
                </span>
                {ask.isPending && (
                  <span
                    aria-live="polite"
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                    {t("elapsed", { seconds: elapsed })}
                  </span>
                )}
              </div>

              {/* Example chips */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("examplesLabel")}
                </span>
                {EXAMPLE_KEYS.map((key) => (
                  <button
                    className="inline-flex items-center gap-1 rounded-full border bg-background px-3 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                    disabled={ask.isPending}
                    key={key}
                    onClick={() => setPrompt(t(`example_${key}`))}
                    type="button"
                  >
                    <Sparkles
                      aria-hidden="true"
                      className="size-3 text-muted-foreground"
                    />
                    {t(`example_${key}`)}
                  </button>
                ))}
              </div>

              <div className="flex justify-end">
                <Button
                  disabled={!canSubmit}
                  onClick={() => submit(prompt)}
                  size="sm"
                >
                  {ask.isPending ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Sparkles aria-hidden="true" />
                  )}
                  {ask.isPending ? t("asking") : t("ask")}
                </Button>
              </div>
            </div>

            {/* ---------------------- error+retry --------------------- */}
            {ask.isError && error && (
              <ErrorState
                className="py-8"
                onRetry={lastPrompt ? retry : undefined}
                reason={errorReason}
                title={t("errorTitle")}
              />
            )}

            {/* --------------------- answer panel --------------------- */}
            {result && !ask.isError && (
              <section
                aria-label={t("summaryTitle")}
                className="flex flex-col gap-4 rounded-xl border bg-surface-subtle/60 p-4"
              >
                {result.fallback && (
                  <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning-subtle/60 p-2.5 text-xs text-foreground">
                    <AlertTriangle
                      aria-hidden="true"
                      className="mt-0.5 size-3.5 shrink-0 text-warning"
                    />
                    {t("fallbackNote")}
                  </p>
                )}

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("summaryTitle")}
                  </span>
                  <p className="whitespace-pre-wrap text-sm">{result.summary}</p>
                </div>

                {filterChips.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("filtersLabel")}
                    </span>
                    {filterChips.map((chip) => (
                      <Badge
                        className="font-tech ltr-technical"
                        key={chip}
                        variant="outline"
                      >
                        {chip}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("resultsTitle")}
                  </span>
                  <ResultRows onNavigate={onNavigate} result={result} />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock aria-hidden="true" className="size-3" />
                    <span className="font-tech ltr-technical">
                      {result.correlationId}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t("groundedInLabel")} {groundedParts.join(" · ")}
                  </span>
                </div>
              </section>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
