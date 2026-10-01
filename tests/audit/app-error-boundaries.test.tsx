import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";

import AppError from "@/app/error";
import AppGlobalError from "@/app/global-error";
import { ViewErrorBoundary } from "@/components/domain/view-error-boundary";

/**
 * RT-004 / F-004 — App Router error boundaries + not-found + view-level
 * degradation. Source-contract tests in the repo convention (readFileSync +
 * assertions, style of tests/brand/shell-brand.test.tsx) plus SSR render
 * checks through react-dom/server (the only renderer available: the bun test
 * environment has no DOM by design — see the shell-brand HONESTY NOTE).
 *
 * Pins:
 *  1. src/app/{error,global-error,not-found}.tsx exist and are client
 *     components; global-error renders its own <html>/<body> (Next contract).
 *  2. error.tsx NEVER renders the raw error (message/digest may leak
 *     internals in production) — negative/security case policed on source.
 *  3. The ViewRouter switch in app-shell.tsx is wrapped by
 *     ViewErrorBoundary, keyed by activeView (reset-on-navigation).
 *  4. error.tsx renders the shared ErrorState with the localized copy,
 *     correlation ID and the reset wiring (retry escape hatch). Since
 *     RT-037 the ErrorState chrome itself is next-intl-driven, so its
 *     fallback renders run inside the locale provider.
 *  5. Both dictionaries carry common.appError.* / common.notFound.* with
 *     exact en/ar parity (totals now 3311 leaves per side after RT-037's
 *     common.errors keys; was 3309 after RT-022's devices.form/csv sweep,
 *     3214 after RT-021's common.highRisk keys, 3206 after RT-005's
 *     hook-toast/alerts sweep (+13 auth.signIn in RT-020), 2856 after
 *     RT-004, originally 2850).
 */

const REPO = join(import.meta.dir, "..", "..");

function read(...segments: string[]): string {
  return readFileSync(join(REPO, ...segments), "utf8");
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

const enMessages = readJson("messages/en.json") as unknown as AbstractIntlMessages;

function withLocale(ui: ReactElement): ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  );
}

describe("RT-004 — error files exist and are client components", () => {
  for (const file of [
    "src/app/error.tsx",
    "src/app/global-error.tsx",
    "src/app/not-found.tsx",
  ]) {
    test(`${file} exists and starts with "use client"`, () => {
      const source = read(...file.split("/"));
      expect(source.startsWith('"use client"')).toBe(true);
    });
  }

  test("global-error renders its own <html>/<body> (Next.js contract)", () => {
    const source = read("src", "app", "global-error.tsx");
    expect(source).toContain("<html");
    expect(source).toContain("<body");
  });

  test("global-error documents why it cannot use next-intl and renders bilingual-neutral copy", () => {
    const source = read("src", "app", "global-error.tsx");
    // Renders outside LocaleProvider (root layout replaced) → next-intl is
    // neither imported nor called; plain bilingual copy instead.
    expect(source).not.toContain('from "next-intl"');
    expect(source).not.toMatch(/useTranslations\(/);
    expect(source).toContain("Something went wrong");
    expect(source).toContain("حدث خطأ ما");
    expect(source).toContain("window.location.reload()");
    expect(source).toContain("document.documentElement.dir");
  });
});

describe("RT-004 — error.tsx never renders raw error internals", () => {
  const source = read("src", "app", "error.tsx");

  test("no error.message / error / digest interpolation reaches JSX output", () => {
    expect(source).not.toContain("error.message");
    expect(source).not.toMatch(/\{error\}/);
    expect(source).not.toContain("error.digest");
    // The error object is ONLY consumed by the support trace log:
    expect(source).toContain('console.error("[app-error]"');
  });
});

describe("RT-004 — view boundary wraps the view switch and is keyed by activeView", () => {
  const shell = read("src", "components", "shell", "app-shell.tsx");
  const boundary = read("src", "components", "domain", "view-error-boundary.tsx");

  test("app-shell wraps <ViewRouter /> in ViewErrorBoundary keyed by activeView", () => {
    expect(shell).toContain('from "@/components/domain/view-error-boundary"');
    expect(shell).toContain("<ViewErrorBoundary key={activeView}>");
    // The router switch is the boundary's child:
    expect(
      /<ViewErrorBoundary key=\{activeView\}>\s*<ViewRouter \/>/.test(shell)
    ).toBe(true);
  });

  test("boundary is a real React error boundary degrading to ErrorState", () => {
    expect(boundary).toContain("getDerivedStateFromError");
    expect(boundary).toContain("componentDidCatch");
    expect(boundary).toContain("ErrorState");
    expect(boundary).toContain("onRetry={() => this.setState({ failed: false })}");
  });
});

describe("RT-004 — error.tsx renders ErrorState with retry", () => {
  const source = read("src", "app", "error.tsx");

  test("mounted boundary shows the localized ErrorState card with correlation ID", () => {
    const html = renderToStaticMarkup(
      withLocale(
        <AppError error={new Error("boom-internal-detail")} reset={() => {}} />
      )
    );
    expect(html).toContain('role="alert"'); // ErrorState card visible
    expect(html).toContain("Something went wrong"); // appError.title (en)
    expect(html).toContain("correlation ID below"); // appError.description
    expect(html).toContain("Correlation ID:"); // support-traceable ID
    expect(html).toContain("Try again"); // appError.retry
    // The raw thrown message never reaches the DOM:
    expect(html).not.toContain("boom-internal-detail");
  });

  test("clicking Retry calls reset (wired via onRetry={reset})", () => {
    // The bun test environment has no DOM renderer (repo convention, see
    // tests/brand/shell-brand.test.tsx HONESTY NOTE), so the click itself is
    // pinned as the source contract; the button markup is covered above.
    expect(source).toContain("onRetry={reset}");
    // …and the handler really is the boundary's reset escape hatch:
    expect(source).toMatch(/reset: \(\) => void/);
  });
});

describe("RT-004 — dictionaries carry the new keys in both locales", () => {
  const NEW_KEYS = [
    "appError.title",
    "appError.description",
    "appError.retry",
    "notFound.title",
    "notFound.description",
    "notFound.backHome",
  ];

  test("common.appError.* and common.notFound.* exist with en/ar parity (+6 leaves)", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;

    for (const [label, dict] of [
      ["en", en],
      ["ar", ar],
    ] as const) {
      for (const key of NEW_KEYS) {
        const value = key.split(".").reduce<unknown>(
          (node, part) =>
            node !== null && typeof node === "object"
              ? (node as Messages)[part]
              : undefined,
          dict.common
        );
        expect(typeof value === "string" && (value as string).length > 0, `${label}:common.${key}`).toBe(true);
      }
    }

    // Identical leaf sets inside the common namespace:
    expect(new Set(leaves(en.common))).toEqual(new Set(leaves(ar.common)));
    // Totals: 2850 (R102) → 2856 (RT-004) → 3193 → 3206 → 3214 → 3309 → 3312
    // (RT-037, +2 common.errors leaves per side; every pinning test updated
    // in the same change).
    expect(leaves(en).length).toBe(3312);
    expect(leaves(ar).length).toBe(3312);
  });
});

describe("RT-004 — global-error fallback is a real branded document", () => {
  test("renders its own html/body with the brand mark, alert role and Reload", () => {
    const html = renderToStaticMarkup(
      <AppGlobalError error={new Error("boom")} reset={() => {}} />
    );
    expect(html).toContain("<html");
    expect(html).toContain("<body");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
    expect(html).toContain("حدث خطأ ما");
    expect(html).toContain("Reload");
    expect(html).not.toContain("boom"); // internals never rendered
  });
});

describe("RT-004 — ViewErrorBoundary view-level degradation", () => {
  test("getDerivedStateFromError flips the boundary into the failed state", () => {
    expect(
      ViewErrorBoundary.getDerivedStateFromError(new Error("any"))
    ).toEqual({ failed: true });
  });

  test("the failed state renders the ErrorState fallback (shell stays alive)", () => {
    // ErrorState resolves its chrome through next-intl (RT-037), so the
    // fallback render needs the locale provider (en) like the error.tsx case:
    const boundary = new ViewErrorBoundary({ children: null });
    boundary.state = { failed: true };
    const html = renderToStaticMarkup(
      withLocale(boundary.render() as ReactElement)
    );
    expect(html).toContain('role="alert"'); // ErrorState fallback visible
    expect(html).toContain("Something went wrong"); // errors.genericTitle default
    expect(html).toContain("Retry"); // common.retry default label
  });

  test("a healthy child renders through untouched", () => {
    const html = renderToStaticMarkup(
      <ViewErrorBoundary>
        <p>healthy-view</p>
      </ViewErrorBoundary>
    );
    expect(html).toContain("healthy-view");
    expect(html).not.toContain('role="alert"');
  });

  test("retry is wired to clear the failure in place (source contract)", () => {
    const boundary = read(
      "src",
      "components",
      "domain",
      "view-error-boundary.tsx"
    );
    expect(boundary).toContain(
      "onRetry={() => this.setState({ failed: false })}"
    );
  });
});
