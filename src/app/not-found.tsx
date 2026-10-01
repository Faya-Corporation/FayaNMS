"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";

import { FayaNMSMark } from "@/components/brand";
import { Button } from "@/components/ui/button";

/**
 * Root not-found page (RT-004 / F-004, audit A4-01).
 *
 * Rendered inside the root layout for unmatched URLs, so LocaleProvider IS
 * mounted above this file and the copy is localized (en/ar). Static,
 * provider-safe card with a link back to the single user-visible route.
 */

export default function NotFound() {
  const t = useTranslations("common");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-background px-6 py-12 text-center text-foreground">
      <span className="mb-1 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <FayaNMSMark size="lg" tone="brand" />
      </span>
      <p className="text-sm font-medium">{t("notFound.title")}</p>
      <p className="max-w-md text-sm text-muted-foreground">
        {t("notFound.description")}
      </p>
      <Button asChild className="mt-2" size="sm" variant="outline">
        <Link href="/">{t("notFound.backHome")}</Link>
      </Button>
    </main>
  );
}
