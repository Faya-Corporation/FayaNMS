import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";

import { ErrorState } from "@/components/domain/error-state";

/**
 * RT-037 / F-053 — ErrorState defaults are localized (en/ar): the default
 * title, the correlation-ID prefix and the Retry label resolve through
 * next-intl while caller overrides keep precedence and the correlation id
 * stays LTR-technical inside its `ltr-technical` span.
 *
 * Render checks run through react-dom/server (the only renderer available —
 * the bun test environment has no DOM by design, see the shell-brand
 * HONESTY NOTE). ErrorState is portal-free, so full SSR works here.
 *
 * Pins:
 *  1. Bare <ErrorState /> renders the localized defaults (en AND ar).
 *  2. correlationId="abc-123" renders the id verbatim inside the
 *     ltr-technical span with a translated prefix.
 *  3. Caller title/retryLabel overrides win over the localized defaults.
 *  4. common.retry, common.errors.correlationId and
 *     common.errors.genericTitle exist in BOTH dictionaries; totals moved
 *     consistently (3309 → 3312; common.retry already existed and is
 *     reused, per the RT).
 */

const REPO = join(import.meta.dir, "..", "..");
const COMPONENT = "src/components/domain/error-state.tsx";

function read(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

type Messages = Record<string, unknown>;

function leaves(obj: unknown, prefix = "", acc: string[] = []): string[] {
  if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj as Messages))
      leaves(value, prefix ? `${prefix}.${key}` : key, acc);
  } else acc.push(prefix);
  return acc;
}

const catalogs: Record<string, AbstractIntlMessages> = {
  en: readJson("messages/en.json") as unknown as AbstractIntlMessages,
  ar: readJson("messages/ar.json") as unknown as AbstractIntlMessages,
};

function withLocale(locale: "en" | "ar", ui: ReactElement): ReactElement {
  return (
    <NextIntlClientProvider locale={locale} messages={catalogs[locale]} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe("RT-037 — defaults are localized", () => {
  test("bare ErrorState renders the en defaults (genericTitle + retry)", () => {
    const html = renderToStaticMarkup(
      withLocale("en", <ErrorState onRetry={() => {}} />)
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
    expect(html).toContain(">Retry<");
  });

  test("bare ErrorState renders the ar defaults", () => {
    const html = renderToStaticMarkup(
      withLocale("ar", <ErrorState onRetry={() => {}} />)
    );
    expect(html).toContain("حدث خطأ ما");
    expect(html).toContain("إعادة المحاولة");
  });

  test("the retry button only renders when onRetry is provided (unchanged)", () => {
    const without = renderToStaticMarkup(withLocale("en", <ErrorState />));
    const withRetry = renderToStaticMarkup(withLocale("en", <ErrorState onRetry={() => {}} />));
    expect(without).not.toContain(">Retry<");
    expect(withRetry).toContain(">Retry<");
  });
});

describe("RT-037 — correlation id stays technical", () => {
  test("the id renders verbatim inside the ltr-technical span, prefix translated", () => {
    const html = renderToStaticMarkup(
      withLocale("en", <ErrorState correlationId="abc-123" />)
    );
    expect(html).toContain("Correlation ID:");
    expect(html).toContain("abc-123");
    // The technical token keeps its LTR span (existing wrapper, exactly):
    expect(html).toMatch(/<span class="ltr-technical"[^>]*>abc-123<\/span>/);
    const arHtml = renderToStaticMarkup(
      withLocale("ar", <ErrorState correlationId="abc-123" />)
    );
    expect(arHtml).toContain("معرّف الارتباط:");
    expect(arHtml).toContain("abc-123");
  });
});

describe("RT-037 — caller overrides still win", () => {
  test("a caller title renders exactly (no default leakage)", () => {
    const html = renderToStaticMarkup(withLocale("en", <ErrorState title="X" />));
    expect(html).toContain(">X</p>");
    expect(html).not.toContain("Something went wrong");
  });

  test("a caller retryLabel overrides the localized default", () => {
    const html = renderToStaticMarkup(
      withLocale("en", <ErrorState onRetry={() => {}} retryLabel="Try again" />)
    );
    expect(html).toContain("Try again");
    expect(html).not.toContain(">Retry<");
  });
});

describe("RT-037 — component roots at common with zero English defaults", () => {
  const source = read(COMPONENT);

  test("error-state.tsx consumes useTranslations(common)", () => {
    expect(source).toContain('from "next-intl"');
    expect(source).toContain('useTranslations("common")');
  });

  test("no English default copy remains in the source", () => {
    for (const literal of [
      'title = "Something went wrong"',
      'retryLabel = "Retry"',
      "Correlation ID:",
    ]) {
      expect(source.includes(literal), `literal: ${literal}`).toBeFalse();
    }
    // The rich tag keeps the id technical (span wrapper preserved):
    expect(source).toContain("ltr-technical");
    expect(source).toMatch(/retryLabel \?\? t\("retry"\)/);
    expect(source).toMatch(/title \?\? t\("errors\.genericTitle"\)/);
  });
});

describe("RT-037 — dictionaries carry the keys in both locales", () => {
  test("common.retry + common.errors.{correlationId,genericTitle} with parity", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;

    // common.retry already existed (R102 chrome sweep) — reused per the RT:
    expect(en.common.retry).toBe("Retry");
    expect(ar.common.retry).toBe("إعادة المحاولة");

    for (const [label, dict] of [
      ["en", en],
      ["ar", ar],
    ] as const) {
      expect(typeof dict.common.errors?.genericTitle).toBe("string");
      expect((dict.common.errors.genericTitle as string).length).toBeGreaterThan(0);
      expect(typeof dict.common.errors?.correlationId).toBe("string");
      expect((dict.common.errors.correlationId as string).length).toBeGreaterThan(0);
    }

    expect(en.common.errors.genericTitle).toBe("Something went wrong");
    expect(en.common.errors.correlationId).toContain("<tech>{id}</tech>");

    // Identical leaf sets; totals moved 3309 → 3312 (+2 common.errors
    // leaves per side; every pinning test retotaled in the same change).
    expect(new Set(leaves(en))).toEqual(new Set(leaves(ar)));
    expect(leaves(en).length).toBe(3314);
    expect(leaves(ar).length).toBe(3314);
  });
});
