import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RT-020 / F-019 — the sign-in gate is fully localized (en/ar).
 * Source police in the r56-i18n-chrome-sweep style + dictionary parity.
 *
 * Pins:
 *  1. sign-in-gate.tsx imports useTranslations and uses the auth.signIn
 *     namespace.
 *  2. Zero F-019 evidence literals remain in the source.
 *  3. The CredentialsSignin conditional still selects the translated
 *     errorCredentials key (and NOT the raw result.error); non-Credentials
 *     server errors render verbatim; the catch path uses errorServer.
 *  4. Both dictionaries carry auth.signIn.* with exact en/ar parity and the
 *     leaf-count total moved consistently (3193 → 3206).
 *  5. Show/hide password aria-labels go through t().
 */

const REPO = join(import.meta.dir, "..", "..");
const GATE = "src/components/auth/sign-in-gate.tsx";

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

describe("RT-020 — sign-in gate uses next-intl", () => {
  const source = read(GATE);

  test("imports useTranslations and roots at auth.signIn", () => {
    expect(source).toContain('from "next-intl"');
    expect(source).toContain('useTranslations("auth.signIn")');
  });

  test("zero hardcoded F-019 evidence copy remains", () => {
    for (const literal of [
      "Invalid email or password.",
      "Demo accounts",
      "Demo credentials",
      "Show password",
      "Hide password",
      "Sign in to your account",
      "Signing in",
      ">Sign in<",
      ">Email<",
      ">Password<",
      "could not be reached",
      "Auditors are read-only",
      "click a row to fill the form",
    ]) {
      expect(source.includes(literal), `literal: ${literal}`).toBeFalse();
    }
    // Demo persona DATA stays untranslated (seeded emails/names/roles).
    expect(source).toContain("admin@faya.local");
    expect(source).toContain("Amal Al-Sabri");
  });
});

describe("RT-020 — credentials error mapping preserved", () => {
  const source = read(GATE);

  test("CredentialsSignin selects the translated key, not the raw error", () => {
    expect(source).toContain('result.error === "CredentialsSignin"');
    expect(source).toContain('? t("errorCredentials")');
    // Non-CredentialsSignin errors keep the verbatim server string.
    expect(source).toMatch(/\?\s*t\("errorCredentials"\)\s*:\s*result\.error/);
  });

  test("the unreachable-server catch path uses errorServer", () => {
    expect(source).toContain('setError(t("errorServer"))');
  });
});

describe("RT-020 — aria labels are translated", () => {
  const source = read(GATE);

  test("show/hide password aria-label goes through t()", () => {
    expect(source).toContain(
      'aria-label={t(showPassword ? "hidePassword" : "showPassword")}'
    );
  });

  test("the demo aside aria-label is keyed", () => {
    expect(source).toContain('aria-label={t("demoAsideLabel")}');
  });

  test("the demo password hint interpolates the code as rich technical text", () => {
    expect(source).toContain('t.rich("demoPasswordHint"');
    expect(source).toContain("code: DEMO_PASSWORD");
    expect(source).toContain("ltr-technical");
  });
});

describe("RT-020 — dictionaries carry auth.signIn in both locales", () => {
  const KEYS = [
    "subtitle",
    "email",
    "password",
    "showPassword",
    "hidePassword",
    "submit",
    "submitting",
    "errorCredentials",
    "errorServer",
    "demoTitle",
    "demoAsideLabel",
    "demoPasswordHint",
    "privacyNote",
  ];

  test("all 13 keys exist with en/ar parity (+13 leaves per side)", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;

    for (const [label, dict] of [
      ["en", en],
      ["ar", ar],
    ] as const) {
      for (const key of KEYS) {
        const value = dict.auth?.signIn?.[key];
        expect(
          typeof value === "string" && (value as string).length > 0,
          `${label}:auth.signIn.${key}`
        ).toBe(true);
      }
    }

    // The errorCredentials copy keeps its exact meaning in both locales.
    expect(en.auth.signIn.errorCredentials).toBe("Invalid email or password.");

    // Identical leaf sets; totals moved 3193 → 3206 in the same change.
    expect(new Set(leaves(en))).toEqual(new Set(leaves(ar)));
    expect(leaves(en).length).toBe(3206);
    expect(leaves(ar).length).toBe(3206);
  });
});
