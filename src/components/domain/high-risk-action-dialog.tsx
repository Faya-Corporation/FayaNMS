"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, ArrowRight, CheckCircle2, LoaderCircle, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * HighRiskActionDialog (Task 3-c) — generic confirmation gate for dangerous
 * actions (guarded restore, …). Three steps inside one dialog:
 *   1. impact summary — a labeled list of what will happen;
 *   2. typed confirmation — the confirm button stays disabled until the
 *      user types `confirmPhrase` EXACTLY (case-sensitive);
 *   3. in-flight spinner → success state with a caller-provided result
 *      summary (typically change number + CTA link).
 *
 * Danger styling is used sparingly (header icon + confirm strip). The Radix
 * Dialog primitives own focus trapping and keyboard dismissal.
 */

export interface HighRiskImpactRow {
  label: string;
  /** Pre-formatted value (may be a ReactNode for badges/tech text). */
  value: React.ReactNode;
}

interface HighRiskActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  impact: HighRiskImpactRow[];
  /** The exact phrase the user must type to enable the confirm button. */
  confirmPhrase: string;
  /** Hint telling the user what to type (defaults to the phrase itself). */
  confirmHint?: string;
  confirmLabel: string;
  /** Runs when confirmed. Returns the success summary (rendered as-is). */
  onConfirm: () => Promise<React.ReactNode>;
  danger?: boolean;
  /** Optional extra controls shown between impact list and typed confirm. */
  children?: React.ReactNode;
}

type Phase = "confirm" | "executing" | "success" | "error";

export function HighRiskActionDialog({
  open,
  onOpenChange,
  title,
  description,
  impact,
  confirmPhrase,
  confirmHint,
  confirmLabel,
  onConfirm,
  danger = true,
  children,
}: HighRiskActionDialogProps) {
  // Dialog chrome (RT-021/F-020): the fixed gate copy is keyed; the
  // caller-provided title/description/impact rows, resultSummary, confirm
  // label and the confirm PHRASE itself stay untranslated technical text.
  const t = useTranslations("common.highRisk");

  const [phase, setPhase] = useState<Phase>("confirm");
  const [typed, setTyped] = useState("");
  const [resultSummary, setResultSummary] = useState<React.ReactNode>(null);
  const [error, setError] = useState<string | null>(null);

  // Fresh state on every open (render-time adjustment — the documented
  // alternative to effect-based resets).
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setPhase("confirm");
      setTyped("");
      setResultSummary(null);
      setError(null);
    }
  }

  const confirmed = typed === confirmPhrase && confirmPhrase.length > 0;

  const handleConfirm = async () => {
    if (!confirmed || phase !== "confirm") return;
    setPhase("executing");
    setError(null);
    try {
      const summary = await onConfirm();
      setResultSummary(summary);
      setPhase("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("failedFallback"));
      setPhase("error");
    }
  };

  return (
    <Dialog
      onOpenChange={(next) => {
        if (phase === "executing") return; // never close mid-flight
        onOpenChange(next);
      }}
      open={open}
    >
      <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden sm:max-w-[560px]">
        <DialogHeader className="border-b pb-4">
          <DialogTitle className="flex items-center gap-2">
            {danger && (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-danger-subtle text-danger">
                <AlertTriangle aria-hidden="true" className="size-4" />
              </span>
            )}
            <span className="min-w-0">{title}</span>
          </DialogTitle>
          <DialogDescription className="pt-1">{description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {phase === "success" ? (
            <div className="flex flex-col gap-3 p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-success">
                <CheckCircle2 aria-hidden="true" className="size-4" />
                {t("done")}
              </div>
              {resultSummary}
            </div>
          ) : phase === "error" ? (
            <div className="flex flex-col gap-3 p-4">
              <div
                className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-subtle p-3 text-sm text-danger"
                role="alert"
              >
                <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{error ?? t("failedFallback")}</span>
              </div>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setPhase("confirm")} size="sm" variant="outline">
                  {t("back")}
                </Button>
                <Button onClick={() => onOpenChange(false)} size="sm" variant="ghost">
                  {t("close")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              {/* Step 1 — impact summary */}
              <div className="overflow-hidden rounded-lg border">
                <dl className="divide-y">
                  {impact.map((row) => (
                    <div
                      className="flex items-start justify-between gap-3 px-3 py-2 text-sm odd:bg-surface-subtle/60"
                      key={row.label}
                    >
                      <dt className="shrink-0 text-xs font-medium text-muted-foreground">
                        {row.label}
                      </dt>
                      <dd className="min-w-0 truncate text-end">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              {/* Optional caller controls (e.g. auto-approve toggle) */}
              {children}

              {/* Step 2 — typed confirmation */}
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="high-risk-confirm-input">
                  {t.rich("confirmInstruction", {
                    phrase: (chunks) => (
                      <span className={cn("font-tech ltr-technical", danger && "text-danger")}>
                        {chunks}
                      </span>
                    ),
                    text: confirmHint ?? confirmPhrase,
                  })}
                </label>
                <Input
                  aria-describedby="high-risk-confirm-hint"
                  autoComplete="off"
                  className="font-tech ltr-technical"
                  disabled={phase !== "confirm"}
                  id="high-risk-confirm-input"
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder={confirmHint ?? confirmPhrase}
                  spellCheck={false}
                  value={typed}
                />
                {typed.length > 0 && !confirmed && (
                  <p
                    aria-live="polite"
                    className="flex items-center gap-1.5 text-xs text-warning"
                    id="high-risk-confirm-hint"
                  >
                    <AlertTriangle aria-hidden="true" className="size-3" />
                    {t("mismatchHint")}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button
                  disabled={phase !== "confirm"}
                  onClick={() => onOpenChange(false)}
                  size="sm"
                  variant="outline"
                >
                  {t("cancel")}
                </Button>
                <Button
                  className={danger ? "bg-danger text-white hover:bg-danger/90" : undefined}
                  disabled={!confirmed || phase !== "confirm"}
                  onClick={() => void handleConfirm()}
                  size="sm"
                >
                  {phase === "executing" ? (
                    <>
                      <LoaderCircle aria-hidden="true" className="animate-spin" />
                      {t("working")}
                    </>
                  ) : (
                    <>
                      {confirmLabel}
                      <ArrowRight aria-hidden="true" />
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
