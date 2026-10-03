import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * RT-022 / F-021 — the Add/Edit-device sheet and the CSV import dialog are
 * localized (en/ar): sheet chrome, field labels, and ALL client zod
 * validation copy. Source police in the r56/rt020/rt021 style + dictionary
 * parity. The zod→key mapping follows the RT-005 alert-rules-panel pattern:
 * schema messages ARE dictionary keys, resolved at render time via a
 * `t.has(message) ? t(message) : message` resolver.
 *
 * Pins:
 *  1. Both files import useTranslations (devices.form / devices.csv) and
 *     their zod schemas carry KEY-shaped messages — no English prose.
 *  2. Every referenced key exists in BOTH dictionaries (walk of the two
 *     namespaces) with exact en/ar parity.
 *  3. The server-reason fallback contract holds: unknown messages render
 *     verbatim (t.has gate), never crash on a non-key string.
 *  4. The LIVE_SSH credential rule is unchanged (same superRefine path +
 *     key) and renders through the same resolver.
 *  5. Totals moved consistently (3214 → 3309): +70 devices.form and +25
 *     devices.csv leaves per side.
 *
 * HONESTY NOTE (repo convention, see rt021 / app-error-boundaries): the bun
 * test environment has no DOM and Radix Sheet/Dialog portals render EMPTY
 * under react-dom/server (probe-verified in RT-021), so the RT's "submit
 * empty → localized error visible" render case is pinned as the exact
 * source contract (errors.*.message flows through tForm/tRowError) instead
 * of a live DOM submission.
 */

const REPO = join(import.meta.dir, "..", "..");
const SHEET = "src/components/device/device-form-sheet.tsx";
const CSV = "src/components/device/csv-import-dialog.tsx";

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

const FORM_KEYS = [
  // zod validation (the F-021 evidence copy)
  "hostnameRequired",
  "hostnameMax",
  "hostnamePattern",
  "vendorRequired",
  "mgmtIpPattern",
  "liveRequiresCredential",
  // sheet chrome
  "addTitle",
  "editTitle",
  "addDescription",
  "editDescription",
  // labels + options
  "hostnameLabel",
  "displayNameLabel",
  "vendorLabel",
  "vendorAria",
  "vendorPlaceholder",
  "modelLabel",
  "mgmtIpLabel",
  "siteLabel",
  "siteAria",
  "unassigned",
  "criticalityLabel",
  "criticalityAria",
  "criticalityLow",
  "criticalityMedium",
  "criticalityHigh",
  "criticalityCritical",
  "dataPlaneLabel",
  "dataPlaneAria",
  "dataPlaneSimulator",
  "dataPlaneLive",
  "liveDataPlaneHint",
  "simulatorDataPlaneHint",
  "credentialLabel",
  "credentialLabelRequired",
  "credentialAria",
  "credentialPlaceholder",
  "credentialNoneOption",
  "credentialHintLiveApiToken",
  "credentialHintLivePassword",
  "credentialHintManaged",
  "tagsLabel",
  "tagsHint",
  "notesLabel",
  "notesPlaceholder",
  "cancel",
  "saveChanges",
  "createDevice",
  // detection section
  "detectButton",
  "detectButtonAria",
  "detectHintWithProfile",
  "detectHintNoProfile",
  "detectionHeading",
  "detectionTitle",
  "hostKeyCaptured",
  "hostKeyVerified",
  "hostKeyTarget",
  "hostKeyDialed",
  "hostKeyAlgorithm",
  "hostKeyFingerprint",
  "hostKeyDisclaimer",
  "detectedPick",
  "pickHasInput",
  "pickFieldVendor",
  "pickFieldModel",
  "pickFieldMgmtIp",
  "pickUse",
  "pickKeepMine",
  "stageRetry",
  "stageRetryVendorAria",
  "stageRetryAddressAria",
];

const CSV_KEYS = [
  // zod row validation (the F-021 evidence copy)
  "hostnameRequired",
  "hostnamePattern",
  "vendorRequired",
  "mgmtIpPattern",
  "rowInvalid",
  // dialog chrome
  "importTitle",
  "importDescription",
  "chooseFile",
  "csvFileAria",
  "downloadTemplate",
  "pasteLabel",
  "rowsParsed",
  "rowsWithIssues",
  "showingFirst",
  "hostnameCol",
  "vendorCol",
  "mgmtIpCol",
  "siteCol",
  "critCol",
  "issueCol",
  "okLabel",
  "cancel",
  "importRows",
  "nothingToImport",
  "nothingToImportDescription",
];

describe("RT-022 — form/CSV schemas carry dictionary keys, not prose", () => {
  test("device-form-sheet.tsx has zero F-021 evidence copy", () => {
    const source = read(SHEET);
    for (const literal of [
      "Hostname is required",
      "Hostname is limited to 63 characters",
      "Letters, digits and hyphens only",
      "Vendor is required",
      "Enter a valid IPv4 management address",
      "LIVE devices require a linked SSH credential profile",
      ">Add device<",
      ">Edit device<",
      ">Hostname *<",
      ">Management IP *<",
      ">Credential profile<",
      ">Save changes<",
      ">Create device<",
      ">Detect vendor",
      "Read-only SSH fingerprint via the worker",
    ]) {
      expect(source.includes(literal), `literal: ${literal}`).toBeFalse();
    }
  });

  test("csv-import-dialog.tsx has zero F-021 evidence copy", () => {
    const source = read(CSV);
    for (const literal of [
      "hostname is required",
      "hostname may contain letters, digits and hyphens",
      "vendor is required",
      "mgmtIp must be a valid IPv4 address",
      "Import devices from CSV",
      "Nothing to import",
      "Fix the highlighted rows",
      "Choose file",
      "Download template",
      "or paste CSV content",
    ]) {
      expect(source.includes(literal), `literal: ${literal}`).toBeFalse();
    }
  });

  test("schemas use key-shaped messages (the six rules + row rules)", () => {
    const sheet = read(SHEET);
    for (const key of [
      "hostnameRequired",
      "hostnameMax",
      "hostnamePattern",
      "vendorRequired",
      "mgmtIpPattern",
      "liveRequiresCredential",
    ]) {
      expect(sheet.includes(`"${key}"`), `schema key: ${key}`).toBeTrue();
    }
    const csv = read(CSV);
    for (const key of ["hostnameRequired", "hostnamePattern", "vendorRequired", "mgmtIpPattern", "rowInvalid"]) {
      expect(csv.includes(`"${key}"`), `schema key: ${key}`).toBeTrue();
    }
  });

  test("the server-copy duplication is deliberately documented (per the RT)", () => {
    expect(read(SHEET)).toMatch(/DELIBERATE DUPLICATION[\s\S]{0,400}?fallback/i);
    expect(read(CSV)).toMatch(/DELIBERATE DUPLICATION[\s\S]{0,400}?fallback/i);
  });
});

describe("RT-022 — namespaces and render-time resolvers", () => {
  test("sheet roots at devices.form and resolves messages via t.has", () => {
    const source = read(SHEET);
    expect(source).toContain('from "next-intl"');
    expect(source).toContain('useTranslations("devices.form")');
    // Key-based resolver (RT-005 alert-rules-panel pattern): known keys
    // translate, UNKNOWN messages (server reasons) render verbatim.
    expect(source).toMatch(/message && t\.has\(message\) \? t\(message\) : \(message \?\? ""\)/);
    // Every errors.<field>.message render goes through the resolver:
    const bare = source.match(/\{form\.formState\.errors\.\w+\.message\}/g) ?? [];
    expect(bare).toEqual([]);
    expect((source.match(/tForm\(form\.formState\.errors\.\w+\.message\)/g) ?? []).length).toBe(4);
  });

  test("LIVE_SSH credential rule unchanged and localized", () => {
    const source = read(SHEET);
    expect(source).toContain('values.dataSource === "LIVE_SSH"');
    expect(source).toContain('path: ["credentialProfileId"]');
    expect(source).toContain('message: "liveRequiresCredential"');
    expect(source).toContain("tForm(form.formState.errors.credentialProfileId.message)");
  });

  test("CSV dialog roots at devices.csv and resolves prefixed row errors", () => {
    const source = read(CSV);
    expect(source).toContain('useTranslations("devices.csv")');
    // Row errors are stored as "<field>: <key>" (existing format); the
    // resolver translates the suffix and keeps the technical field prefix.
    expect(source).toContain("tRowError");
    expect(source).toMatch(/entry\.error \?[\s\S]*?tRowError\(entry\.error\)/);
    // The empty-import guard keys through the dialog namespace:
    expect(source).toContain('t("nothingToImport")');
    expect(source).toContain('t("nothingToImportDescription")');
    // The parse fallback is a key, not prose:
    expect(source).toContain('?? "rowInvalid"');
  });

  test("technical CSV data stays untranslated (header template + mgmtIp column)", () => {
    const source = read(CSV);
    expect(source).toContain("hostname,vendor,model,mgmtIp,siteCode,criticality,tags");
  });

  test("example-format placeholders stay (RT-020 precedent: data, not copy)", () => {
    const source = read(SHEET);
    expect(source).toContain("HQ-Core-RTR-01");
    expect(source).toContain("10.20.255.1");
    expect(source).toContain("ISR4451-X");
  });
});

describe("RT-022 — dictionaries carry devices.form + devices.csv in both locales", () => {
  test("all 70 form keys and 25 csv keys exist with en/ar parity", () => {
    const en = readJson("messages/en.json") as Record<string, any>;
    const ar = readJson("messages/ar.json") as Record<string, any>;

    for (const [label, dict] of [
      ["en", en],
      ["ar", ar],
    ] as const) {
      for (const key of FORM_KEYS) {
        const value = dict.devices?.form?.[key];
        expect(
          typeof value === "string" && (value as string).length > 0,
          `${label}:devices.form.${key}`
        ).toBe(true);
      }
      for (const key of CSV_KEYS) {
        const value = dict.devices?.csv?.[key];
        expect(
          typeof value === "string" && (value as string).length > 0,
          `${label}:devices.csv.${key}`
        ).toBe(true);
      }
    }

    // The en validation copy keeps its exact F-021 meaning:
    expect(en.devices.form.hostnameRequired).toBe("Hostname is required");
    expect(en.devices.form.liveRequiresCredential).toBe(
      "LIVE devices require a linked SSH credential profile"
    );
    expect(en.devices.csv.nothingToImport).toBe("Nothing to import");

    // Exact namespace sizes (+70 form / +25 csv per side):
    expect(leaves(en.devices.form).length).toBe(70);
    expect(leaves(ar.devices.form).length).toBe(70);
    expect(leaves(en.devices.csv).length).toBe(25);
    expect(leaves(ar.devices.csv).length).toBe(25);
    expect(new Set(leaves(en.devices))).toEqual(new Set(leaves(ar.devices)));
  });

  test("totals moved consistently (3214 → 3309 per side; later retotaled to 3311 by RT-037)", () => {
    const en = leaves(readJson("messages/en.json"));
    const ar = leaves(readJson("messages/ar.json"));
    expect(new Set(en)).toEqual(new Set(ar));
    expect(en.length).toBe(3314);
    expect(ar.length).toBe(3314);
  });
});
