"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ArrowRight,
  CalendarClock,
  Clock,
  Loader2,
  ShieldCheck,
  Sparkles,
  Wand2,
} from "lucide-react";

import { aiErrorKey, useAiChangeDraft } from "@/hooks/api/use-ai";
import { useCurrentLocale } from "@/i18n/locale-provider";
import { ErrorState } from "@/components/domain/error-state";
import { StatusBadge } from "@/components/domain/status-badge";
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
  type AiChangeDraftPrefill,
  type AiChangeDraftResult,
} from "@/lib/api-client";
import { getStatusConfig, RISK_LEVEL } from "@/lib/domain/status";
import { lookupStatusConfig, CHANGE_TYPE_UI } from "@/components/views/status-extras";

/**
 * "Draft with AI" dialog (Phase 13-a): an operator describes the intended
 * change in plain language, the backend grounds the request in the real
 * device inventory and the LLM answers with a STRICT-JSON change draft.
 * The draft renders as a REVIEW panel inside this dialog — nothing is ever
 * created automatically; "Open in wizard" hands the reviewed draft to the
 * existing change wizard (starting at step 1) via the aiDraft prefill.
 */

const PROMPT_MIN = 10;
/** Max prompt length — mirrored by the API contract (600). */
const PROMPT_MAX = 600;

const EXAMPLE_KEYS = ["firmware", "uplink", "firewall"] as const;

/** Label list block inside the review panel. */
function DraftList({
  items,
  ordered = false,
}: {
  items: string[];
  ordered?: boolean;
}) {
  const ListTag = ordered ? "ol" : "ul";
  return (
    <ListTag
      className={
        ordered
          ? "ms-5 flex list-decimal flex-col gap-1 text-sm"
          : "ms-5 flex list-disc flex-col gap-1 text-sm"
      }
    >
      {items.map((item, index) => (
        <li className="ps-1" key={index}>
          {item}
        </li>
      ))}
    </ListTag>
  );
}

export function ChangeAiDraftDialog({
  open,
  onOpenChange,
  onUseDraft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** User reviewed the draft → hand it to the change wizard (never auto-created). */
  onUseDraft: (prefill: AiChangeDraftPrefill) => void;
}) {
  const t = useTranslations("ai.changeDraft");
  const tAi = useTranslations("ai");
  const locale = useCurrentLocale();

  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState<string | null>(null);
  const [pendingSince, setPendingSince] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const draft = useAiChangeDraft();

  const result: AiChangeDraftResult | undefined = draft.data;
  const error = draft.error;

  // Informative spinner: the LLM round-trip can take up to ~60 s (45 s
  // timeout + one retry), so the wait state shows elapsed seconds. The
  // tick only runs while a request is in flight.
  useEffect(() => {
    if (!draft.isPending || pendingSince === null) return;
    const timer = setInterval(
      () => setElapsed(Math.round((Date.now() - pendingSince) / 1000)),
      1000
    );
    return () => clearInterval(timer);
  }, [draft.isPending, pendingSince]);

  // Fresh dialog content on every open (keep the typed prompt, drop any
  // stale result/error from a previous session).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) draft.reset();
  }

  const generate = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length < PROMPT_MIN || draft.isPending) return;
    setLastPrompt(trimmed);
    setPendingSince(Date.now());
    setElapsed(0);
    draft.mutate({ prompt: trimmed, locale });
  };

  const retry = () => {
    if (lastPrompt) generate(lastPrompt);
  };

  const errorReason = (() => {
    if (!error) return undefined;
    const key = aiErrorKey(error instanceof ApiError ? error.code : "");
    return key ? tAi(key) : error.message;
  })();

  const canGenerate = prompt.trim().length >= PROMPT_MIN && !draft.isPending;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="flex max-h-[92vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b p-4 pb-4 text-start">
          <DialogTitle className="flex items-center gap-2">
            <Wand2 aria-hidden="true" className="size-4 text-primary" />
            {t("title")}
          </DialogTitle>
          <DialogDescription>{t("intro")}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col gap-4 p-4">
            {/* ------------------------- ask ------------------------- */}
            <div className="flex flex-col gap-2">
              <Label htmlFor="ai-change-prompt">{t("promptLabel")}</Label>
              <Textarea
                id="ai-change-prompt"
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
                {draft.isPending && (
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
                    disabled={draft.isPending}
                    key={key}
                    onClick={() => setPrompt(t(`example_${key}`))}
                    type="button"
                  >
                    <Sparkles aria-hidden="true" className="size-3 text-muted-foreground" />
                    {t(`example_${key}`)}
                  </button>
                ))}
              </div>

              <div className="flex justify-end">
                <Button disabled={!canGenerate} onClick={() => generate(prompt)} size="sm">
                  {draft.isPending ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Wand2 aria-hidden="true" />
                  )}
                  {draft.isPending ? t("generating") : t("generate")}
                </Button>
              </div>
            </div>

            {/* ---------------------- error+retry --------------------- */}
            {draft.isError && error && (
              <ErrorState
                className="py-8"
                onRetry={lastPrompt ? retry : undefined}
                reason={errorReason}
                title={t("errorTitle")}
              />
            )}

            {/* ------------------- review panel ---------------------- */}
            {result && !draft.isError && (
              <section
                aria-label={t("reviewTitle")}
                className="flex flex-col gap-4 rounded-xl border bg-surface-subtle/60 p-4"
              >
                <header className="flex flex-col gap-1">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldCheck aria-hidden="true" className="size-4 text-success" />
                    {t("reviewTitle")}
                  </span>
                  <p className="text-xs text-muted-foreground">{t("reviewNote")}</p>
                </header>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("fieldTitle")}
                  </span>
                  <p className="text-sm font-medium">{result.draft.title}</p>
                </div>

                {result.draft.description && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("fieldDescription")}
                    </span>
                    <p className="whitespace-pre-wrap text-sm">{result.draft.description}</p>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge
                    config={lookupStatusConfig(CHANGE_TYPE_UI, result.draft.changeType)}
                  />
                  <StatusBadge
                    config={getStatusConfig(RISK_LEVEL, result.draft.riskHint)}
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("fieldDevices")}
                  </span>
                  {result.matchedDevices.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("devicesNone")}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {result.matchedDevices.map((device) => (
                        <Badge className="font-tech ltr-technical" key={device.id} variant="outline">
                          {device.hostname}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>

                {result.draft.implementationPlan.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("fieldImplementation")}
                    </span>
                    <DraftList items={result.draft.implementationPlan} ordered />
                  </div>
                )}

                {result.draft.validationPlan.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("fieldValidation")}
                    </span>
                    <DraftList items={result.draft.validationPlan} />
                  </div>
                )}

                {result.draft.rollbackPlan.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      {t("fieldRollback")}
                    </span>
                    <DraftList items={result.draft.rollbackPlan} />
                  </div>
                )}

                {result.draft.suggestedWindowHint && (
                  <p className="flex items-start gap-1.5 rounded-lg border bg-background p-2.5 text-xs text-muted-foreground">
                    <CalendarClock aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      <span className="font-medium text-foreground">{t("fieldWindow")}: </span>
                      {result.draft.suggestedWindowHint}
                    </span>
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock aria-hidden="true" className="size-3" />
                    <span className="font-tech ltr-technical">{result.correlationId}</span>
                  </span>
                  <Button
                    onClick={() =>
                      onUseDraft({
                        draft: result.draft,
                        matchedDevices: result.matchedDevices,
                        correlationId: result.correlationId,
                      })
                    }
                    size="sm"
                  >
                    {t("openInWizard")}
                    <ArrowRight aria-hidden="true" />
                  </Button>
                </div>
              </section>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
