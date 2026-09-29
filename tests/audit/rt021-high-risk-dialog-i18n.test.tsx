import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RT-021 / F-020 — the high-risk action dialog's typed-confirmation gate is
 * localized (en/ar). Source police in the r56/rt020 style + dictionary parity.
 *
 * Pins:
 *  1. high-risk-action-dialog.tsx roots at common.highRisk and zero F-020
 *     evidence literals remain in the source.
 *  2. The confirm PHRASE stays untranslated technical text: the input
 *     placeholder still binds `confirmHint ?? confirmPhrase` verbatim (NOT
 *     through t()) and the phrase keeps its `ltr-technical` wrapping — only
 *     the surrounding instruction sentence is keyed (t.rich, RT-020 pattern).
 *  3. The mismatch hint keeps aria-live="polite" and resolves through
 *     t("mismatchHint").
 *  4. Phase flow (confirm → executing → success/error) is untouched and the
 *     success/error branches render t("done") / `error ?? t("failedFallback")`.
 *  5. Both dictionaries carry common.highRisk.* with exact en/ar parity and
 *     the leaf-count total moved consistently (3206 → 3214).
 *
 * HONESTY NOTE (repo convention, see tests/brand/shell-brand.test.tsx): the
 * bun test environment has no DOM and Radix Dialog portals render EMPTY under
 * react-dom/server (probe-verified — DialogContent goes through a Portal with
 * no document.body on the server), so the render-shaped cases above are pinned
 * as exact source contracts instead; every consumer-visible string is keyed.
 */

const REPO = join(import.meta.dir, "..", "..");
const DIALOG = "src/components/domain/high-risk-action-dialog.tsx";

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

describe("RT-021 — dialog chrome uses next-intl", () => {
  const source = read(DIALOG);

  test("imports useTranslations and roots at common.highRisk", () => {
    expect(source).toContain('from "next-intl"');
    expect(source).toContain('useTranslations("common.highRisk")');
  });

  test("zero hardcoded F-020 evidence copy remains", () => {
    for (const literal of [
      "Done — action completed",
      "The action failed",
      "exactly to confirm",
      "Text does not match yet",
      "Working…",
      ">Back<",
      ">Close<",
      ">Cancel<",
    ]) {
      expect(source.includes(literal), `literal: ${literal}`).toBeFalse();
    }
  });

  test("every fixed copy string resolves through t()", () => {
    expect(source).toContain('t("done")');
    expect(source).toContain("error ?? t(\"failedFallback\")");
    expect(source).toContain('t("back")');
    expect(source).toContain('t("close")');
    expect(source).toContain('t("cancel")');
    expect(source).toContain('t("working")');
  });
});

describe("RT-021 — confirm phrase stays untranslated technical text", () => {
  const source = read(DIALOG);

  test("placeholder binds the raw phrase byte-for-byte (never through t)", () => {
    expect(source).toContain("placeholder={confirmHint ?? confirmPhrase}");
    expect(source).not.toMatch(/placeholder=\{t\(/);
    expect(source).toContain("value={typed}");
    expect(source).toMatch(/e instanceof Error \? e\.message : t\("failedFallback"\)/);
  });

  test("the instruction sentence keys through t.rich with the phrase as rich text", () => {
    expect(source).toContain('t.rich("confirmInstruction"');
    expect(source).toContain("ltr-technical");
    // The phrase interpolates INTO the rich span (value + tag, RT-020 style):
    expect(source).toMatch(/text:\s*confirmHint \?\? confirmPhrase/);
  });
});

describe("RT-021 — mismatch hint is aria-live and localized", () => {
  const source = read(DIALOG);

  test("the hint node keeps aria-live=polite and renders t(mismatchHint)", () => {
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('id="high-risk-confirm-hint"');
    expect(source).toContain('{t("mismatchHint")}');
  });
});

describe("RT-021 — phase flow unchanged", () => {
  const source = read(DIALOG);

  test("confirm → executing → success/error transitions keep the same props", () => {
    expect(source).toContain('setPhase("executing")');
    expect(source).toContain("await onConfirm()");
    expect(source).toContain('setPhase("success")');
    expect(source).toContain('setPhase("error")');
    expect(source).toContain("phase === \"success\" ? (");
    expect(source).toContain("phase === \"error\" ? (");
    // Caller-provided content passes through unchanged:
    expect(source).toContain("{title}");
    expect(source).toContain("{description}");
    expect(source).toContain("{resultSummary}");
    expect(source).toContain("{confirmLabel}");
  });
});

describe("RT-021 — dictionaries carry common.highRisk in both locales", () => {
  const KEYS = [
    "done",
    "failedFallback",
    "back",
    "close",
    "cancel",
    "working",
    "confirmInstruction",
    "mismatchHint",
  ];

  test("all 8 keys exist with en/ar parity (+8 leaves per side)", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;

    for (const [label, dict] of [
      ["en", en],
      ["ar", ar],
    ] as const) {
      for (const key of KEYS) {
        const value = dict.common?.highRisk?.[key];
        expect(
          typeof value === "string" && (value as string).length > 0,
          `${label}:common.highRisk.${key}`
        ).toBe(true);
      }
    }

    // The en copy keeps its exact meaning (en values are the source strings):
    expect(en.common.highRisk.done).toBe("Done — action completed");
    expect(en.common.highRisk.failedFallback).toBe("The action failed");
    expect(en.common.highRisk.confirmInstruction).toContain("<phrase>{text}</phrase>");

    // Identical leaf sets; totals moved 3206 → 3214 in the same change.
    expect(new Set(leaves(en))).toEqual(new Set(leaves(ar)));
    expect(leaves(en).length).toBe(3214);
    expect(leaves(ar).length).toBe(3214);
  });
});
