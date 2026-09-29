"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { ErrorState } from "@/components/domain/error-state";

/**
 * Route-level error boundary (RT-004 / F-004, audit A4-01).
 *
 * Catches any uncaught render exception inside the root layout tree (the
 * whole app shell) and degrades to the shared `ErrorState` card instead of
 * Next's default production crash screen. LocaleProvider IS mounted in the
 * layout above this file, so the copy is localized (en/ar) via next-intl.
 *
 * SECURITY/UX: the thrown `error` (and its production `digest`) is logged
 * for support tracing but NEVER rendered — production messages may leak
 * internals. The operator only sees the localized copy plus a correlation
 * ID that matches the `[app-error]` console record.
 */

interface AppErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function AppError({ error, reset }: AppErrorProps) {
  const t = useTranslations("common");
  // Stable correlation ID: generated once per boundary mount so the ID
  // rendered on screen always matches the logged record below.
  const [correlationId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    console.error("[app-error]", correlationId, error);
  }, [correlationId, error]);

  return (
    <ErrorState
      className="mx-auto my-8 max-w-xl"
      correlationId={correlationId}
      onRetry={reset}
      reason={t("appError.description")}
      retryLabel={t("appError.retry")}
      title={t("appError.title")}
    />
  );
}
