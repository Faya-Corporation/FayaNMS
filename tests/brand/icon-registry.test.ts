import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { NAVIGATION_ICONS } from "../../src/lib/icons/navigation-icons";
import type { NavIcon } from "../../src/lib/icons/types";
import { VENDOR_ICON, VENDOR_LABELS, GENERIC_VENDOR_ICON, vendorIconFor } from "../../src/lib/icons/vendor-icons";
import { deviceIconFor } from "../../src/lib/icons/device-icons";
import { DEVICE_ROLE_META, deviceRoleMetaFor, deviceRoleLabelFor } from "../../src/lib/icons/device-role-meta";
import { driverCatalog } from "../../src/lib/vendors/drivers";

/**
 * Icon registry parity + governance contracts (task R3-a).
 *
 * Covers re-audit findings:
 *  - B1-009 — the icon catalog (docs/brand/ICON-CATALOG.md ROWS — the stale
 *    "Total icons: 216" header is being fixed in parallel and is deliberately
 *    NOT asserted) must exactly mirror the disk master set;
 *  - B1-011 — vendor glyph validation must be DERIVED from the real adapter
 *    registry (driverCatalog via mini-services/worker/adapters), not a
 *    hardcoded vendor list, and unknown/missing vendors fall back to generic;
 *  - B1-012 — every device role code resolves through DEVICE_ROLE_META to a
 *    governed glyph (the 10 formerly-generic roles are now specific) with a
 *    meaningful label;
 *  - B2-025 — NAVIGATION_ICONS stays exhaustive over the sidebar view keys;
 *  - B2-027 — dedicated automated brand/icon tests exist in-repo.
 *
 * The Tier-2 SVG root contract below mirrors scripts/svg-contract.ts:
 * every master's ROOT <svg…> open tag carries exactly
 * viewBox="0 0 24 24", fill="none", stroke="currentColor",
 * stroke-width="2", round caps/joins — no scripts/gradients/filters/
 * animations/foreign objects anywhere, and no paint other than
 * none/currentColor in the whole file.
 */

const ROOT = join(import.meta.dir, "..", "..");
const ICONS_DIR = join(ROOT, "public", "icons", "fayanms");
const DISK_PATTERN = /^[a-z0-9-]+\.svg$/;

/** Root open-tag attribute contract (exact values, attribute-order agnostic). */
const ROOT_ATTRS: ReadonlyArray<[string, RegExp]> = [
  ["viewBox", /viewBox="0 0 24 24"/],
  ["fill", /\bfill="none"/],
  ["stroke", /\bstroke="currentColor"/],
  ["stroke-width", /\bstroke-width="2"/],
  ["stroke-linecap", /\bstroke-linecap="round"/],
  ["stroke-linejoin", /\bstroke-linejoin="round"/],
];

/** Whole-file prohibitions (case-insensitive: catches animateTransform etc.). */
const PROHIBITED: ReadonlyArray<[string, RegExp]> = [
  ["<script", /<script/i],
  ["<style", /<style/i],
  ["<filter", /<filter/i],
  ["<animate", /<animate/i],
  ["linearGradient", /lineargradient/i],
  ["radialGradient", /radialgradient/i],
  ["foreignObject", /foreignobject/i],
];

const diskFiles = readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg"));
const diskNames = new Set(diskFiles.map((f) => f.replace(/\.svg$/, "")));
const masters = new Map<string, string>(diskFiles.map((f) => [f, readFileSync(join(ICONS_DIR, f), "utf8")]));

/** FayanmsIconName union parsed from src/lib/icons/types.ts. */
function parseUnion(): string[] {
  const source = readFileSync(join(ROOT, "src", "lib", "icons", "types.ts"), "utf8");
  const names: string[] = [];
  const pattern = /(?:^|\n)\s*\|\s*"([a-z0-9-]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) names.push(match[1]);
  return names;
}

/** Catalog rows parsed exactly like scripts/validate-icon-registry.ts (first backticked cell per table row). */
function parseCatalogRows(): string[] {
  const source = readFileSync(join(ROOT, "docs", "brand", "ICON-CATALOG.md"), "utf8");
  const rows: string[] = [];
  for (const line of source.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const m = line.match(/\|\s*`([a-z0-9-]+)`\s*\|/);
    if (m) rows.push(m[1]);
  }
  return rows;
}

beforeAll(() => {
  expect(diskFiles.length).toBeGreaterThan(0);
});

describe("registry parity — disk set ≡ FayanmsIconName union (B1-009)", () => {
  test("exact set equality (no missing, no phantom) and same count", () => {
    const union = parseUnion();
    const unionSet = new Set(union);
    expect(union.length).toBe(unionSet.size); // no duplicate union members
    expect(unionSet.size).toBe(diskNames.size);
    expect([...unionSet].sort()).toEqual([...diskNames].sort());
  });

  test("every master filename is kebab-case", () => {
    const bad = diskFiles.filter((f) => !DISK_PATTERN.test(f));
    expect(bad).toEqual([]);
  });
});

describe("Tier-2 geometry contract — every master root <svg> tag", () => {
  test("root open tag carries the exact stroke/viewBox contract", () => {
    const violations: string[] = [];
    for (const [file, source] of masters) {
      const openTag = source.match(/<svg\b[^>]*>/)?.[0];
      if (!openTag) {
        violations.push(`${file}: no root <svg> open tag found`);
        continue;
      }
      for (const [attr, pattern] of ROOT_ATTRS) {
        if (!pattern.test(openTag)) violations.push(`${file}: root tag missing ${attr}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("no script/style/filter/animate/gradient/foreignObject anywhere", () => {
    const violations: string[] = [];
    for (const [file, source] of masters) {
      for (const [label, pattern] of PROHIBITED) {
        if (pattern.test(source)) violations.push(`${file}: contains ${label}`);
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(violations).toEqual([]);
  });

  test("no fill/stroke attribute anywhere paints anything but none/currentColor", () => {
    const violations: string[] = [];
    const paint = /\b(fill|stroke)="([^"]*)"/g;
    for (const [file, source] of masters) {
      paint.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = paint.exec(source)) !== null) {
        if (match[2] !== "none" && match[2] !== "currentColor") {
          violations.push(`${file}: ${match[1]}="${match[2]}"`);
        }
      }
    }
    expect(violations.slice(0, 10)).toEqual([]);
    expect(violations).toEqual([]);
  });
});

describe("catalog parity — ICON-CATALOG.md rows ≡ disk (B1-009)", () => {
  test("row set equals the disk set, no duplicate rows, count matches", () => {
    const rows = parseCatalogRows();
    const rowSet = new Set(rows);
    const missingInCatalog = [...diskNames].filter((n) => !rowSet.has(n));
    const phantomInCatalog = [...rowSet].filter((n) => !diskNames.has(n));

    const duplicates = [...rowSet].filter((n) => rows.filter((r) => r === n).length > 1);

    expect(missingInCatalog).toEqual([]);
    expect(phantomInCatalog).toEqual([]);
    expect(duplicates).toEqual([]);
    expect(rows.length).toBe(diskNames.size);
  });
});

describe("navigation registry (B2-025)", () => {
  const navKeys = Object.keys(NAVIGATION_ICONS);
  const navNames = Object.values(NAVIGATION_ICONS)
    .filter((icon): icon is Extract<NavIcon, { kind: "fayanms" }> => icon.kind === "fayanms")
    .map((icon) => icon.name);

  test("entry count ≥ 43 (the governed sidebar taxonomy)", () => {
    expect(navKeys.length).toBeGreaterThanOrEqual(43);
  });

  test("every registry glyph exists on disk", () => {
    const missing = [...new Set(navNames)].filter((n) => !diskNames.has(n));
    expect(missing).toEqual([]);
  });

  test("every sidebar view key in sidebar-config.ts is a NAVIGATION_ICONS key", () => {
    const source = readFileSync(join(ROOT, "src", "lib", "navigation", "sidebar-config.ts"), "utf8");
    const viewKeys = new Set<string>();
    const pattern = /view:\s*"([a-z0-9.-]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) viewKeys.add(match[1]);
    expect(viewKeys.size).toBeGreaterThan(0);
    const unregistered = [...viewKeys].filter((k) => !navKeys.includes(k));
    expect(unregistered).toEqual([]);
  });
});

describe("vendor glyph mapping derived from the driver registry (B1-011)", () => {
  test("every adapter vendor resolves past GENERIC (except the generic adapter)", () => {
    expect(driverCatalog.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const driver of driverCatalog) {
      const resolved = vendorIconFor(driver.vendor);
      if (driver.vendor === "generic") {
        if (resolved !== GENERIC_VENDOR_ICON) wrong.push(`${driver.vendor} → ${resolved}`);
      } else if (resolved === GENERIC_VENDOR_ICON) {
        wrong.push(`${driver.vendor} → ${resolved} (generic fallback)`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("every resolved vendor glyph has a non-empty VENDOR_LABELS entry", () => {
    const unlabeled: string[] = [];
    for (const driver of driverCatalog) {
      const resolved = vendorIconFor(driver.vendor);
      if (typeof VENDOR_LABELS[resolved] !== "string" || VENDOR_LABELS[resolved].length === 0) {
        unlabeled.push(`${driver.vendor} → ${resolved}`);
      }
    }
    expect(unlabeled).toEqual([]);
  });

  test("null / empty / whitespace / unknown vendor keys all fall back to vendor-generic", () => {
    expect(vendorIconFor(null)).toBe("vendor-generic");
    expect(vendorIconFor(undefined)).toBe("vendor-generic");
    expect(vendorIconFor("")).toBe("vendor-generic");
    expect(vendorIconFor("  ")).toBe("vendor-generic");
    expect(vendorIconFor("nope")).toBe("vendor-generic");
  });

  test("every VENDOR_ICON value exists on disk", () => {
    const missing = Object.values(VENDOR_ICON).filter((n) => !diskNames.has(n));
    expect(missing).toEqual([]);
  });
});

describe("device role mapping (B1-012)", () => {
  const roleKeys = Object.keys(DEVICE_ROLE_META) as Array<keyof typeof DEVICE_ROLE_META>;
  const formerlyGenericRoles = [
    "TOP_OF_RACK",
    "WAN_GATEWAY",
    "WIRELESS_CONTROLLER",
    "LOAD_BALANCER",
    "CORE_ROUTER",
    "EDGE_ROUTER",
    "BRANCH_ROUTER",
    "CORE_SWITCH",
    "ACCESS_SWITCH",
    "FIREWALL",
  ] as const;

  test("every role resolves to exactly its DEVICE_ROLE_META glyph, which exists on disk", () => {
    const wrong: string[] = [];
    for (const key of roleKeys) {
      const meta = DEVICE_ROLE_META[key];
      if (deviceIconFor(key) !== meta.icon) wrong.push(`${key}: deviceIconFor → ${deviceIconFor(key)}, meta.icon → ${meta.icon}`);
      if (!diskNames.has(meta.icon)) wrong.push(`${key}: glyph ${meta.icon} not on disk`);
    }
    expect(wrong).toEqual([]);
  });

  test("the 10 formerly-generic roles now resolve to specific glyphs", () => {
    const stillGeneric = formerlyGenericRoles.filter(
      (role) => deviceIconFor(role) === "device-generic"
    );
    expect(stillGeneric).toEqual([]);
  });

  test("every role has a non-empty label that is not the old generic placeholder", () => {
    const bad: string[] = [];
    for (const key of roleKeys) {
      const label = deviceRoleLabelFor(key);
      if (label.length === 0) bad.push(`${key}: empty label`);
      if (label === "Device type glyph") bad.push(`${key}: stale placeholder label`);
      if (label !== DEVICE_ROLE_META[key].label) bad.push(`${key}: label drift`);
      if (deviceRoleMetaFor(key).label !== label) bad.push(`${key}: meta/label mismatch`);
    }
    expect(bad).toEqual([]);
  });

  test("unknown / null device types fall back to device-generic", () => {
    expect(deviceIconFor("totally-unknown-thing")).toBe("device-generic");
    expect(deviceIconFor(null)).toBe("device-generic");
    expect(deviceIconFor(undefined)).toBe("device-generic");
    expect(deviceIconFor("")).toBe("device-generic");
  });

  test("free-form substring families still resolve", () => {
    expect(deviceIconFor("linux server")).toBe("device-server");
    expect(deviceIconFor("my router")).toBe("device-router");
    expect(deviceIconFor("firewall-router")).toBe("device-firewall");
  });
});
