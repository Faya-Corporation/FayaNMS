import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { detectionHintKey } from "@/hooks/api/use-devices";

/**
 * RT-005 / F-005 + F-006 — i18n extraction of hook toasts and the alert
 * surfaces. Source-policed test in the repo's tranche style plus a unit
 * case for the detection-hint fallback contract.
 *
 * Pins:
 *  1. src/hooks/api/*.ts carry zero hardcoded toast literals and every
 *     toast-firing hook file imports next-intl's useTranslations.
 *  2. The detection/resolution operator hints resolve through detect.hints.*
 *     dictionary keys (no English hint strings in the hook); every mapped
 *     code exists in BOTH dictionaries; unmapped codes fall back to the raw
 *     message (detectionHintKey returns null).
 *  3. alert-stream-item / alert-action-dialogs / alert-rules-panel use
 *     next-intl and none of the F-006 evidence literals remain.
 *  4. en/ar parity holds with the new toast.* / detect.* / alerts.*
 *     namespaces (totals 3206 leaves per side after the sweep).
 *  5. aria labels on the alert stream go through t().
 */

const REPO = join(import.meta.dir, "..", "..");
const HOOKS_DIR = join(REPO, "src", "hooks", "api");

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

describe("RT-005 — hooks carry zero hardcoded toast literals", () => {
  const hookFiles = readdirSync(HOOKS_DIR).filter((name) => name.endsWith(".ts"));

  test("no `title: \"…\"` / `title: \\`…\\`` English literals remain in any hook", () => {
    const offenders: string[] = [];
    for (const name of hookFiles) {
      const src = readFileSync(join(HOOKS_DIR, name), "utf8");
      // Double-quoted or template-literal title with a leading Latin letter
      // (t()-derived titles are `t("…")` and never match).
      if (/\btitle:\s*("|`)[A-Z]/.test(src)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  test("every hook file that fires toasts imports useTranslations", () => {
    const offenders: string[] = [];
    for (const name of hookFiles) {
      const src = readFileSync(join(HOOKS_DIR, name), "utf8");
      if (src.includes("toast(") && !src.includes("useTranslations")) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("toast copy lives in toast.* namespaces (per hook family)", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    for (const family of [
      "devices",
      "alerts",
      "alertRules",
      "changes",
      "approvals",
      "incidents",
      "admin",
      "users",
      "credentials",
      "discovery",
      "backupPolicies",
      "jobs",
      "maintenance",
      "baselines",
      "drift",
      "retention",
      "notifications",
    ]) {
      expect(
        typeof en.toast?.[family] === "object" && en.toast[family] !== null,
        `toast.${family}`
      ).toBe(true);
    }
    expect(leaves(en.toast).length).toBeGreaterThanOrEqual(200);
  });
});

describe("RT-005 — detection/resolution hints resolve through t()", () => {
  const hookSource = read("src/hooks/api/use-devices.ts");

  test("the English hint maps no longer exist in use-devices.ts", () => {
    expect(hookSource).not.toContain("DETECTION_CODE_OPERATOR_HINTS");
    expect(hookSource).not.toContain("RESOLUTION_CODE_OPERATOR_HINTS");
    expect(hookSource).not.toContain("does not match the enrolled key");
    expect(hookSource).not.toContain("the DNS resolver timed out");
  });

  test("every mapped code has a detect.hints.<CODE> key in BOTH dictionaries", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    // Extract the identity map (code -> key) from the hook source.
    const mapMatch = hookSource.match(
      /const DETECTION_CODE_HINT_KEYS: Record<string, string> = \{([\s\S]*?)\};/
    );
    expect(mapMatch).not.toBeNull();
    const codes = [...mapMatch![1].matchAll(/([A-Z0-9_]+):\s*"[A-Z0-9_]+"/g)].map(
      (m) => m[1]
    );
    expect(codes.length).toBe(19);
    for (const code of codes) {
      expect(typeof en.detect.hints[code] === "string", `en:${code}`).toBe(true);
      expect(typeof ar.detect.hints[code] === "string", `ar:${code}`).toBe(true);
    }
  });

  test("unknown detection code still falls back to the raw message", () => {
    // The hook's hint resolution helper returns null for unmapped/missing
    // codes → the mutation falls back to `result.error` verbatim
    // (`hint ? `${hint} (${result.error})` : result.error` stays in source).
    expect(detectionHintKey("TOTALLY_UNMAPPED_CODE")).toBeNull();
    expect(detectionHintKey("")).toBeNull();
    expect(detectionHintKey(null)).toBeNull();
    expect(detectionHintKey(undefined)).toBeNull();
    expect(detectionHintKey("HOST_KEY_MISMATCH")).toBe("HOST_KEY_MISMATCH");
    expect(hookSource).toContain(': result.error');
    expect(
      hookSource.includes(
        "result.addressResolution.message ?? result.addressResolution.code"
      )
    ).toBe(true);
  });
});

describe("RT-005 — alert components use next-intl", () => {
  const COMPONENTS = [
    "src/components/alerts/alert-stream-item.tsx",
    "src/components/alerts/alert-action-dialogs.tsx",
    "src/components/alerts/alert-rules-panel.tsx",
  ];

  for (const file of COMPONENTS) {
    test(`${file} imports useTranslations`, () => {
      expect(read(file)).toContain("useTranslations(");
      expect(read(file)).toContain('from "next-intl"');
    });
  }

  test("zero F-006 evidence literals remain", () => {
    const joined = COMPONENTS.map((file) => read(file)).join("\n");
    for (const literal of [
      "first seen ",
      "last seen ",
      "Actions for alert on ",
      "Alert actions",
      ">Acknowledge<",
      ">Assign alert<",
      ">Suppress alert<",
      "Assign to",
      "Select a user",
      "Reason (optional)",
      ">New alert rule<",
      "Rules could not be loaded",
      "No alert rules yet",
      "Alert Rules",
      "Fired ",
    ]) {
      expect(joined.includes(literal), `literal: ${literal}`).toBeFalse();
    }
  });

  test("aria labels are translated (aria-label goes through t())", () => {
    const stream = read(COMPONENTS[0]);
    expect(stream).toContain('aria-label={t("actionsFor"');
    expect(stream).toContain('aria-label={t("firedTimesAria"');
    expect(stream).toContain('aria-label={t(expanded ? "childHideAria" : "childShowAria"');
    expect(stream).toContain('aria-label={t("childrenAria"');
  });
});

describe("RT-005 — en/ar parity holds with the new namespaces", () => {
  test("leaf sets are identical and totals pin at 3395 per side", () => {
    const en = readJson("messages/en.json");
    const ar = readJson("messages/ar.json");
    const enLeaves = leaves(en);
    const arLeaves = leaves(ar);
    expect(new Set(enLeaves)).toEqual(new Set(arLeaves));
    // 2850 (R102) → 2856 (RT-004) → 3193 (RT-005: +337 toast/detect/alerts)
    // → 3206 (RT-020: +13 auth.signIn) → 3214 (RT-021: +8 common.highRisk)
    // → 3309 (RT-022: +95 devices.form/devices.csv) → 3311 (RT-037: +2
    // common.errors) → 3392 (GA-3, +7 apiClients keys per side; was 3385
    // after F-034: +2 auth.signIn totpCode/totpHint) → 3394 (GA-5: +2 runs
    // downloadPdf/downloadXlsx per side) → 3395 (GA-4b: +1
    // collectors.distribution realPlaneNote per side). This
    // pin tracks the CURRENT total and is retotaled by every later
    // dictionary-touching RT (repo rule).
    expect(enLeaves.length).toBe(3395);
    expect(arLeaves.length).toBe(3395);
  });

  test("alerts.stream/dialogs/rules and detect.hints exist in both locales", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;
    expect(leaves(en.alerts).length).toBe(leaves(ar.alerts).length);
    expect(leaves(en.alerts.stream).length).toBe(19);
    expect(leaves(en.alerts.dialogs).length).toBe(10);
    expect(leaves(en.alerts.rules).length).toBe(70);
    expect(leaves(en.detect.hints).length).toBe(19);
    for (const key of leaves(en.alerts)) {
      expect(typeof ar.alerts === "object").toBe(true);
    }
  });
});
