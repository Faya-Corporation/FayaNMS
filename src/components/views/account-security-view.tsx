"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  KeyRound,
  LoaderCircle,
  RefreshCcw,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import {
  mfaErrorKey,
  useConfirmMfa,
  useDisableMfa,
  useEnrollMfa,
} from "@/hooks/api/use-mfa";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/domain/page-header";
import { SectionCard } from "@/components/domain/section-card";
import { ErrorState } from "@/components/domain/error-state";
import { cn } from "@/lib/utils";

/**
 * Self-service Account Security view (F-034 follow-up — the settings-UI
 * wave that owns the MFA form the backend deliberately left API-first).
 *
 * Backend contract (batch-24, intentionally stable): /api/v1/me/mfa exposes
 * enroll (POST) → confirm (POST) → disable (DELETE) and NO GET status
 * surface. The view therefore derives its status by probing enroll:
 *   200                     → pending enrollment (setup panel, provision)
 *   409 MFA_ALREADY_ENABLED → the second factor is active
 *   400 MFA_DISABLED        → the FAYANMS_MFA_MODE knob is off
 *   403 RBAC_FORBIDDEN      → role not eligible (non-privileged plane)
 * Probing honestly creates/rotates a DISABLED pending row when nothing is
 * enabled — a pending row never challenges at sign-in until confirm
 * succeeds; the copy below says so.
 *
 * Honest limitation (keyed, rendered in the setup panel): no QR image is
 * rendered — no QR-capable dependency exists in the dependency set and the
 * governance forbids adding one for a nicety; the URI + manual secret are
 * copy-first instead.
 *
 * Disable mirrors the fail-tight handler: password re-entry AND a current
 * TOTP code or an unused recovery code, confirmed through a dialog.
 */

type MfaStatus =
  | { kind: "checking" }
  | { kind: "pending"; secret: string; otpauth: string }
  | { kind: "active" }
  | { kind: "single" }
  | { kind: "modeOff" }
  | { kind: "roleDenied" }
  | { kind: "error"; reasonKey: string };

/** Display form: the raw Base32 secret grouped in readable 4-char chunks. */
function groupedSecret(secret: string): string {
  return secret.replace(/(.{4})/g, "$1 ").trim();
}

export function AccountSecurityView() {
  const t = useTranslations("accountSecurity");
  const tToast = useTranslations("toast.mfa");
  const { toast } = useToast();

  const enroll = useEnrollMfa();
  const confirm = useConfirmMfa();
  const disable = useDisableMfa();

  const [status, setStatus] = useState<MfaStatus>({ kind: "checking" });
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [confirmErrorKey, setConfirmErrorKey] = useState<string | null>(null);

  const copyValue = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        toast({ title: tToast("copied") });
      } catch {
        toast({ title: tToast("copyFailed"), variant: "destructive" });
      }
    },
    [toast, tToast]
  );

  const runProbe = useCallback(() => {
    setStatus({ kind: "checking" });
    enroll.mutate(undefined, {
      onSuccess: (data) => {
        setCode("");
        setConfirmErrorKey(null);
        setStatus({ kind: "pending", secret: data.secret, otpauth: data.otpauth });
      },
      onError: (error) => {
        if (error instanceof Error && "code" in error) {
          const apiCode = (error as { code: string }).code;
          if (apiCode === "MFA_ALREADY_ENABLED") {
            setStatus({ kind: "active" });
            return;
          }
          if (apiCode === "MFA_DISABLED") {
            setStatus({ kind: "modeOff" });
            return;
          }
          if (apiCode === "RBAC_FORBIDDEN") {
            setStatus({ kind: "roleDenied" });
            return;
          }
        }
        setStatus({ kind: "error", reasonKey: mfaErrorKey(error) });
      },
    });
  }, [enroll]);

  // One probe per mount (ref-guarded so React strict-mode double effects
  // cannot fire two rotations). Enabled accounts answer 409 with zero side
  // effects; a fresh probe for un-enrolled accounts creates the pending row.
  const probedRef = useRef(false);
  useEffect(() => {
    if (probedRef.current) return;
    probedRef.current = true;
    runProbe();
  }, [runProbe]);

  const onConfirm = () => {
    setConfirmErrorKey(null);
    confirm.mutate(code, {
      onSuccess: (data) => {
        setRecoveryCodes(data.recoveryCodes);
        setStatus({ kind: "active" });
        setCode("");
        toast({
          title: tToast("activatedTitle"),
          description: tToast("activatedDescription"),
        });
      },
      onError: (error) => setConfirmErrorKey(mfaErrorKey(error)),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumbs={[
          { label: t("page.breadcrumbAdministration") },
          { label: t("page.title") },
        ]}
        description={t("page.description")}
        title={t("page.title")}
      />

      <StatusCard
        error={enroll.isError && status.kind === "error" ? enroll.error : null}
        onCheckAgain={runProbe}
        onSetup={runProbe}
        status={status}
      />

      {status.kind === "pending" && (
        <SetupCard
          code={code}
          confirming={confirm.isPending}
          errorKey={confirmErrorKey}
          otpauth={status.otpauth}
          secret={status.secret}
          onCodeChange={(value) => {
            setCode(value);
            setConfirmErrorKey(null);
          }}
          onConfirm={onConfirm}
          onCopy={copyValue}
          onDiscard={() => {
            setCode("");
            setConfirmErrorKey(null);
            setStatus({ kind: "single" });
          }}
        />
      )}

      {recoveryCodes && (
        <RecoveryCodesCard codes={recoveryCodes} onCopy={copyValue} onDone={() => setRecoveryCodes(null)} />
      )}

      {status.kind === "active" && !recoveryCodes && (
        <DisableCard />
      )}
    </div>
  );
}

/* ───────────────────────────── status card ──────────────────────────── */

interface StatusCardProps {
  status: MfaStatus;
  onCheckAgain: () => void;
  onSetup: () => void;
  error: unknown;
}

function StatusCard({ status, onCheckAgain, onSetup, error }: StatusCardProps) {
  const t = useTranslations("accountSecurity");

  const badge = (() => {
    switch (status.kind) {
      case "checking":
        return null;
      case "pending":
        return <Badge className="bg-warning/10 text-warning">{t("status.badgePending")}</Badge>;
      case "active":
        return <Badge className="bg-success/10 text-success">{t("status.badgeActive")}</Badge>;
      case "single":
        return <Badge variant="secondary">{t("status.badgeSingle")}</Badge>;
      case "modeOff":
        return <Badge variant="outline">{t("status.badgeOff")}</Badge>;
      case "roleDenied":
        return <Badge variant="outline">{t("status.badgeOff")}</Badge>;
      case "error":
        return <Badge variant="destructive">{t("status.badgeError")}</Badge>;
    }
  })();

  const description = (() => {
    switch (status.kind) {
      case "checking":
        return t("status.checkingLabel");
      case "pending":
        return t("status.pendingDescription");
      case "active":
        return t("status.activeDescription");
      case "single":
        return t("status.singleDescription");
      case "modeOff":
        return t("status.offDescription");
      case "roleDenied":
        return t("status.roleDescription");
      case "error":
        return t(status.reasonKey);
    }
  })();

  const Icon =
    status.kind === "active"
      ? ShieldCheck
      : status.kind === "single" || status.kind === "pending"
        ? KeyRound
        : ShieldOff;

  return (
    <SectionCard
      actions={
        <Button
          className="h-11 px-4 sm:h-9"
          disabled={status.kind === "checking"}
          onClick={onCheckAgain}
          variant="outline"
        >
          {status.kind === "checking" ? (
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <RefreshCcw aria-hidden="true" className="size-4" />
          )}
          {t("status.checkAgain")}
        </Button>
      }
      description={undefined}
      title={t("status.cardTitle")}
    >
      <div aria-live="polite" className="flex flex-col gap-3">
        {status.kind === "checking" ? (
          <div className="flex items-center gap-3">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-72 max-w-full" />
            </div>
          </div>
        ) : status.kind === "error" ? (
          <ErrorState
            className="border-none bg-transparent px-0 py-4"
            reason={description}
            title={t("status.errorTitle")}
          />
        ) : (
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Icon aria-hidden="true" className="size-5" />
            </span>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                {badge}
                <span className="text-sm font-medium text-foreground">
                  {t("status.cardDescription")}
                </span>
              </div>
              <p className="max-w-2xl text-xs text-muted-foreground">{description}</p>
              {status.kind === "single" && (
                <div>
                  <Button className="h-11 px-5" onClick={onSetup}>
                    <KeyRound aria-hidden="true" className="size-4" />
                    {t("status.setupAction")}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

/* ───────────────────────────── setup card ───────────────────────────── */

interface SetupCardProps {
  otpauth: string;
  secret: string;
  code: string;
  confirming: boolean;
  errorKey: string | null;
  onCodeChange: (value: string) => void;
  onConfirm: () => void;
  onDiscard: () => void;
  onCopy: (value: string) => void;
}

function SetupCard({
  otpauth,
  secret,
  code,
  confirming,
  errorKey,
  onCodeChange,
  onConfirm,
  onDiscard,
  onCopy,
}: SetupCardProps) {
  const t = useTranslations("accountSecurity");

  const normalized = code.replace(/[\s-]/g, "");
  const sixDigits = /^\d{6}$/.test(normalized);

  return (
    <SectionCard title={t("setup.cardTitle")} description={t("setup.cardDescription")}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="mfa-otpauth">{t("setup.otpauthLabel")}</Label>
          <div className="flex items-stretch gap-2">
            <code
              aria-label={t("setup.otpauthLabel")}
              className="min-h-11 flex-1 overflow-x-auto rounded-md border bg-muted/50 px-3 py-2.5 font-mono text-xs break-all text-foreground"
              dir="ltr"
              id="mfa-otpauth"
            >
              {otpauth}
            </code>
            <Button
              aria-label={t("setup.copyOtpauthAria")}
              className="h-11 w-11 shrink-0 p-0"
              onClick={() => onCopy(otpauth)}
              size="icon"
              variant="outline"
            >
              <RefreshCcw aria-hidden="true" className="hidden" />
              <CopyGlyph />
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="mfa-secret">{t("setup.secretLabel")}</Label>
          <div className="flex items-stretch gap-2">
            <code
              aria-label={t("setup.secretLabel")}
              className="flex h-11 flex-1 items-center overflow-x-auto rounded-md border bg-muted/50 px-3 font-mono text-sm tracking-widest text-foreground"
              dir="ltr"
              id="mfa-secret"
            >
              {groupedSecret(secret)}
            </code>
            <Button
              aria-label={t("setup.copySecretAria")}
              className="h-11 w-11 shrink-0 p-0"
              onClick={() => onCopy(secret)}
              size="icon"
              variant="outline"
            >
              <CopyGlyph />
            </Button>
          </div>
        </div>

        <Alert className="border-border bg-muted/40">
          <AlertDescription className="text-xs text-muted-foreground">
            {t("setup.qrNote")}
            <br />
            {t("setup.rotateNote")}
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-2">
          <Label htmlFor="mfa-confirm-code">{t("setup.codeLabel")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <Input
              aria-describedby={errorKey ? "mfa-confirm-error" : undefined}
              aria-label={t("setup.codeLabel")}
              autoComplete="one-time-code"
              className={cn("h-11 sm:w-44", errorKey && "border-destructive")}
              dir="ltr"
              id="mfa-confirm-code"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => onCodeChange(event.target.value)}
              placeholder={t("setup.codePlaceholder")}
              value={code}
            />
            <Button
              className="h-11 px-5"
              disabled={confirming || !sixDigits}
              onClick={onConfirm}
            >
              {confirming && (
                <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
              )}
              {confirming ? t("setup.confirming") : t("setup.confirmButton")}
            </Button>
            <Button
              className="h-11 sm:h-9"
              disabled={confirming}
              onClick={onDiscard}
              variant="ghost"
            >
              {t("setup.discard")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground" id="mfa-confirm-hint">
            {t("setup.codeHint")}
          </p>
          {errorKey && (
            <p aria-live="polite" className="text-xs text-danger" id="mfa-confirm-error" role="alert">
              {t(errorKey)}
            </p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

/* ───────────────────────── recovery codes card ──────────────────────── */

interface RecoveryCodesCardProps {
  codes: string[];
  onCopy: (value: string) => void;
  onDone: () => void;
}

function RecoveryCodesCard({ codes, onCopy, onDone }: RecoveryCodesCardProps) {
  const t = useTranslations("accountSecurity");

  return (
    <SectionCard
      title={t("recovery.cardTitle")}
      description={t("recovery.cardDescription")}
    >
      <div className="flex flex-col gap-4">
        <Alert className="border-warning/40 bg-warning/5 [&>svg]:text-warning">
          <AlertDescription className="text-xs font-medium text-foreground">
            {t("recovery.storeWarning")}
          </AlertDescription>
        </Alert>
        <ul
          aria-label={t("recovery.listAria")}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {codes.map((recoveryCode) => (
            <li key={recoveryCode}>
              <code
                className="flex h-11 items-center rounded-md border bg-muted/50 px-3 font-mono text-sm tracking-wider text-foreground"
                dir="ltr"
              >
                {recoveryCode}
              </code>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-11 px-5"
            onClick={() => onCopy(codes.join("\n"))}
            variant="outline"
          >
            <CopyGlyph />
            {t("recovery.copyAll")}
          </Button>
          <Button className="h-11 px-5" onClick={onDone}>
            <ShieldCheck aria-hidden="true" className="size-4" />
            {t("recovery.done")}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

/* ───────────────────────────── disable card ─────────────────────────── */

function DisableCard() {
  const t = useTranslations("accountSecurity");
  const tToast = useTranslations("toast.mfa");
  const { toast } = useToast();

  const disable = useDisableMfa();

  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const closeAndReset = () => {
    setOpen(false);
    setPassword("");
    setCode("");
    setErrorKey(null);
  };

  const onSubmit = () => {
    setErrorKey(null);
    disable.mutate(
      { password, code },
      {
        onSuccess: () => {
          closeAndReset();
          toast({
            title: tToast("disabledTitle"),
            description: tToast("disabledDescription"),
          });
        },
        onError: (error) => setErrorKey(mfaErrorKey(error)),
      }
    );
  };

  return (
    <SectionCard
      title={t("disable.cardTitle")}
      description={t("disable.cardDescription")}
    >
      <div>
        <Button
          className="h-11 px-5"
          onClick={() => setOpen(true)}
          variant="outline"
        >
          <ShieldOff aria-hidden="true" className="size-4" />
          {t("disable.openButton")}
        </Button>
      </div>

      <AlertDialog
        onOpenChange={(next) => {
          if (!next) closeAndReset();
          else setOpen(true);
        }}
        open={open}
      >
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("disable.dialogTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("disable.dialogDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSubmit();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="mfa-disable-password">{t("disable.passwordLabel")}</Label>
              <Input
                autoComplete="current-password"
                className="h-11"
                id="mfa-disable-password"
                onChange={(event) => setPassword(event.target.value)}
                placeholder={t("disable.passwordPlaceholder")}
                type="password"
                value={password}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="mfa-disable-code">{t("disable.codeLabel")}</Label>
              <Input
                aria-describedby={errorKey ? "mfa-disable-error" : undefined}
                autoComplete="one-time-code"
                className="h-11"
                dir="ltr"
                id="mfa-disable-code"
                onChange={(event) => setCode(event.target.value)}
                placeholder={t("disable.codePlaceholder")}
                value={code}
              />
              <p className="text-xs text-muted-foreground">{t("disable.codeHint")}</p>
            </div>
            {errorKey && (
              <p
                aria-live="polite"
                className="text-xs text-danger"
                id="mfa-disable-error"
                role="alert"
              >
                {t(errorKey)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button disabled={disable.isPending} type="button" variant="outline">
                  {t("disable.cancel")}
                </Button>
              </AlertDialogCancel>
              <Button
                disabled={disable.isPending || password.length === 0 || code.trim().length === 0}
                type="submit"
                variant="destructive"
              >
                {disable.isPending && (
                  <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                )}
                {disable.isPending ? t("disable.disabling") : t("disable.confirmButton")}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

/* ─────────────────────────── shared glyph ───────────────────────────── */

/** Clipboard glyph (a plain SVG-free lucide import kept local for reuse). */
function CopyGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <rect height="14" rx="2" ry="2" width="8" x="8" y="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10" />
    </svg>
  );
}
