/**
 * Icon registry validation (re-audit B1-008/009/010/011/012, §10 — strengthened).
 * Run: `bun run brand:validate-icons`
 *
 * Compares FOUR data sets: disk masters, the FayanmsIconName union, the
 * ICON-CATALOG rows, and registry/runtime references. Guarantees:
 *
 *  HARD FAILURES
 *   - the FayanmsIconName union in src/lib/icons/types.ts is not EXACTLY the
 *     disk file set (missing union entry / phantom union entry);
 *   - a disk master violates the EXACT Tier-2 geometry contract (root
 *     viewBox="0 0 24 24", fill="none", stroke="currentColor",
 *     stroke-width="2", round caps/joins; no gradients/filters/styles/
 *     scripts/animation/external refs/hardcoded colors) — B1-008;
 *   - catalog parity (B1-009): disk master missing from
 *     docs/brand/ICON-CATALOG.md, catalog row with no disk file ("phantom"),
 *     duplicate catalog row, or catalog row count ≠ disk count;
 *   - a sidebar view key has no NAVIGATION_ICONS entry, or any registry
 *     target (nav/vendor/device) is missing on disk;
 *   - vendor validation derived from the REAL adapter registry
 *     (src/lib/vendors/drivers.ts driverCatalog, B1-011): an adapter vendor
 *     must NOT fall back to GENERIC_VENDOR_ICON unless it IS "generic", and
 *     a display label must exist (VENDOR_LABELS or the adapter's
 *     vendorLabel). The old hardcoded VENDOR_KEYS list is gone — a new
 *     adapter (arista, mikrotik, …) now de-fails the gate until a glyph
 *     exists;
 *   - device-role validation (B1-012): every DEVICE_ROLE_META role resolves
 *     via deviceIconFor() to the icon the metadata declares, exists on disk,
 *     and gets a real label via deviceIconLabelFor() (never the old generic
 *     "Device type glyph"); the previously-generic roles (TOP_OF_RACK,
 *     WAN_GATEWAY, WIRELESS_CONTROLLER, LOAD_BALANCER, …) must NOT resolve
 *     to device-generic. Unknown roles still fall back to device-generic.
 *     DEVICE_ROLE_META/deviceIconLabelFor are imported defensively (R2-b may
 *     be landing them in parallel) — absent module ⇒ hard FAIL with a clear
 *     message, never a fake pass.
 *
 *  WARNINGS (never affect exit code)
 *   - cataloged master not referenced by any runtime surface (B1-010 orphan
 *     policy: runtime-unused masters are allowed; registry-referenced but
 *     disk-missing masters still fail);
 *   - a "Total icons:" header line in the catalog that disagrees with the
 *     authoritative ROW count (known stale-header issue, fixed separately).
 *
 * Prints "N warnings, M failures"; exit 1 iff failures > 0.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ICONS_DIR = join(ROOT, "public", "icons", "fayanms");
const CATALOG = join(ROOT, "docs", "brand", "ICON-CATALOG.md");

let failures = 0;
let warnings = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`✗ ${msg}`);
};
const warn = (msg: string) => {
  warnings++;
  console.warn(`⚠ ${msg}`);
};
const ok = (msg: string) => console.log(`✓ ${msg}`);

/* ------------------------------------------------------------------ */
/* Disk truth + Tier-2 geometry contract (B1-008).                     */
/* ------------------------------------------------------------------ */

const diskNames = readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg"));
const disk = new Set(diskNames.map((f) => f.replace(/\.svg$/, "")));
ok(`${disk.size} SVG masters on disk`);

const { checkTier2IconContract } = await import(
  join(ROOT, "scripts", "svg-contract.ts")
);
let geometryBad = 0;
for (const f of readdirSync(ICONS_DIR)) {
  if (!f.endsWith(".svg")) {
    fail(`icons/${f}: non-SVG file in the governed runtime icon directory`);
    geometryBad++;
    continue;
  }
  if (!/^[a-z0-9-]+\.svg$/.test(f)) {
    fail(`icons/${f}: invalid name (kebab-case [a-z0-9-] only)`);
    geometryBad++;
  }
  const violations = checkTier2IconContract(f, readFileSync(join(ICONS_DIR, f), "utf8"));
  if (violations.length > 0) {
    geometryBad++;
    for (const v of violations) fail(`icons/${v.detail}`);
  }
}
if (geometryBad === 0) {
  ok(`tier-2 geometry contract: ${disk.size}/${disk.size} masters exact (re-audit §9.3)`);
}

/* ------------------------------------------------------------------ */
/* 1. FayanmsIconName union === exact file set.                        */
/* ------------------------------------------------------------------ */

const typesSrc = readFileSync(join(ROOT, "src", "lib", "icons", "types.ts"), "utf8");
const unionBlock = typesSrc.match(/export type FayanmsIconName =([\s\S]*?);/)?.[1] ?? "";
const unionNames = new Set(
  [...unionBlock.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1])
);
for (const n of disk) if (!unionNames.has(n)) fail(`union missing icon: ${n}`);
for (const n of unionNames) if (!disk.has(n)) fail(`union has phantom icon: ${n}`);
if (unionNames.size === disk.size && unionNames.size > 0) {
  ok(`FayanmsIconName union exact (${unionNames.size}/${disk.size})`);
}

/* ------------------------------------------------------------------ */
/* 2. Catalog parity (B1-009) — parse ROWS, not the header total.      */
/* ------------------------------------------------------------------ */

const catalogSrc = existsSync(CATALOG) ? readFileSync(CATALOG, "utf8") : "";
if (!catalogSrc) {
  fail(`missing docs/brand/ICON-CATALOG.md`);
} else {
  const catalogRows: string[] = [];
  const rowCount = new Map<string, number>();
  for (const line of catalogSrc.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue; // table rows only
    const m = line.match(/\|\s*`([a-z0-9-]+)`\s*\|/);
    if (!m) continue;
    catalogRows.push(m[1]);
    rowCount.set(m[1], (rowCount.get(m[1]) ?? 0) + 1);
  }
  const catalogSet = new Set(rowCount.keys());

  const missingInCatalog = [...disk].filter((n) => !catalogSet.has(n));
  const phantomInCatalog = [...catalogSet].filter((n) => !disk.has(n));
  const duplicates = [...rowCount.entries()].filter(([, c]) => c > 1);

  if (missingInCatalog.length > 0) {
    fail(
      `catalog parity: ${missingInCatalog.length} disk master(s) missing in catalog: ${missingInCatalog.slice(0, 10).join(", ")}${missingInCatalog.length > 10 ? " …" : ""}`
    );
  }
  if (phantomInCatalog.length > 0) {
    fail(
      `catalog parity: ${phantomInCatalog.length} catalog row(s) with no disk file (phantom): ${phantomInCatalog.slice(0, 10).join(", ")}${phantomInCatalog.length > 10 ? " …" : ""}`
    );
  }
  if (duplicates.length > 0) {
    fail(
      `catalog parity: duplicate catalog rows: ${duplicates.map(([n, c]) => `${n}×${c}`).join(", ")}`
    );
  }
  if (catalogRows.length !== disk.size) {
    fail(`catalog parity: count mismatch — catalog has ${catalogRows.length} icon rows, disk has ${disk.size} masters`);
  }
  if (missingInCatalog.length + phantomInCatalog.length + duplicates.length === 0 && catalogRows.length === disk.size) {
    ok(`catalog parity exact (${catalogRows.length} rows ↔ ${disk.size} masters, no dupes)`);
  }

  // Stale "Total icons:" header — KNOWN issue, warning only (rows are
  // authoritative; another task reconciles the header).
  const totals = new Set(
    [...catalogSrc.matchAll(/Total icons:\**\s*`?(\d+)`?/gi)].map((m) => m[1])
  );
  for (const t of totals) {
    if (Number(t) !== disk.size) {
      warn(`catalog header says "Total icons: ${t}" but there are ${catalogRows.length} icon rows — header is stale (rows are authoritative)`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. Registries resolve (TS imported natively by bun).                */
/* ------------------------------------------------------------------ */

const { NAVIGATION_ICONS } = await import(
  join(ROOT, "src", "lib", "icons", "navigation-icons.ts")
);
const { VENDOR_ICON, VENDOR_LABELS, GENERIC_VENDOR_ICON, vendorIconFor } = await import(
  join(ROOT, "src", "lib", "icons", "vendor-icons.ts")
);
const { deviceIconFor, GENERIC_DEVICE_ICON } = await import(
  join(ROOT, "src", "lib", "icons", "device-icons.ts")
);

const navRecord = NAVIGATION_ICONS as Record<string, { kind: string; name?: string }>;
const vendorIconRecord = VENDOR_ICON as Record<string, string>;

/* 3a. Sidebar view keys resolve in the navigation registry. */
const sidebarSrc = readFileSync(
  join(ROOT, "src", "lib", "navigation", "sidebar-config.ts"),
  "utf8"
);
const viewKeys = [...sidebarSrc.matchAll(/view:\s*"([a-z0-9.-]+)"/g)].map(
  (m) => m[1]
);
for (const key of viewKeys) {
  const entry = navRecord[key];
  if (!entry) fail(`sidebar view "${key}" has no NAVIGATION_ICONS entry`);
  else if (entry.kind === "fayanms" && entry.name && !disk.has(entry.name))
    fail(`sidebar view "${key}" → missing master "${entry.name}.svg"`);
}
ok(`${viewKeys.length} sidebar view keys resolve`);

/* 3b. Every registry-declared icon target exists on disk. */
for (const [key, entry] of Object.entries(navRecord)) {
  if (entry.kind === "fayanms" && entry.name && !disk.has(entry.name))
    fail(`NAVIGATION_ICONS["${key}"] → missing master "${entry.name}.svg"`);
}
for (const [k, name] of Object.entries(vendorIconRecord)) {
  if (!disk.has(name)) fail(`VENDOR_ICON["${k}"] → missing master "${name}.svg"`);
}

/* ------------------------------------------------------------------ */
/* 4. Vendor validation derived from the REAL adapter registry         */
/*    (B1-011) — no hardcoded vendor key list.                         */
/* ------------------------------------------------------------------ */

const driversMod = (await import(
  join(ROOT, "src", "lib", "vendors", "drivers.ts")
)) as {
  driverCatalog: Array<{ adapter: string; vendor: string; vendorLabel: string }>;
};
const driverCatalog = driversMod.driverCatalog;
if (!Array.isArray(driverCatalog) || driverCatalog.length === 0) {
  fail("driverCatalog is empty or unreadable — cannot derive vendor validation");
}
for (const driver of driverCatalog) {
  const resolved = vendorIconFor(driver.vendor);
  if (driver.vendor !== "generic" && resolved === GENERIC_VENDOR_ICON) {
    fail(
      `adapter "${driver.adapter}" (vendor "${driver.vendor}") falls back to GENERIC_VENDOR_ICON — add a governed glyph + VENDOR_ICON entry (B1-011)`
    );
  }
  const label = VENDOR_LABELS[resolved] ?? driver.vendorLabel;
  if (!label || label.trim() === "") {
    fail(
      `adapter "${driver.adapter}" (vendor "${driver.vendor}") has no display label (VENDOR_LABELS["${resolved}"] / vendorLabel)`
    );
  }
  if (!disk.has(resolved)) {
    fail(`vendor "${driver.vendor}" → missing master "${resolved}.svg"`);
  }
}
if (driverCatalog.length > 0) {
  ok(
    `vendor mapping derived from driverCatalog: ${driverCatalog.length} adapters, ${new Set(driverCatalog.map((d) => d.vendor)).size} distinct vendors (incl. generic fallback)`
  );
}

// Negative probes: unknown/missing vendor keys must resolve to the generic
// glyph, and that glyph must exist on disk.
for (const probe of [null, "", "unknown-vendor-probe"]) {
  if (vendorIconFor(probe) !== GENERIC_VENDOR_ICON) {
    fail(`unknown vendor probe "${String(probe)}" did not fall back to GENERIC_VENDOR_ICON`);
  }
}
if (!disk.has(GENERIC_VENDOR_ICON)) {
  fail(`GENERIC_VENDOR_ICON "${GENERIC_VENDOR_ICON}" is missing on disk`);
}

/* ------------------------------------------------------------------ */
/* 5. Device-role checks (B1-012) — defensive import: R2-b may still   */
/*    be landing src/lib/icons/device-role-meta.ts in parallel.        */
/* ------------------------------------------------------------------ */

interface DeviceRoleMetaEntry {
  label: string;
  icon: string;
  family?: string;
}
let deviceRoleMeta: Record<string, DeviceRoleMetaEntry> | null = null;
let deviceIconLabelFor: ((role: string) => string) | null = null;

const META_PATH = join(ROOT, "src", "lib", "icons", "device-role-meta.ts");
for (let attempt = 1; attempt <= 3 && !deviceRoleMeta; attempt++) {
  if (existsSync(META_PATH)) {
    try {
      const mod = (await import(META_PATH)) as {
        DEVICE_ROLE_META?: Record<string, DeviceRoleMetaEntry>;
        deviceIconLabelFor?: (role: string) => string;
      };
      if (mod.DEVICE_ROLE_META) {
        deviceRoleMeta = mod.DEVICE_ROLE_META;
        // deviceIconLabelFor may live in device-role-meta.ts or be re-exported
        // by device-icons.ts (R2-b final shape) — accept either.
        const iconsMod = (await import(
          join(ROOT, "src", "lib", "icons", "device-icons.ts")
        )) as { deviceIconLabelFor?: (role: string) => string };
        deviceIconLabelFor =
          mod.deviceIconLabelFor ?? iconsMod.deviceIconLabelFor ?? null;
      }
    } catch {
      // mid-refactor partial write — retry below
    }
  }
  if (!deviceRoleMeta && attempt < 3) {
    console.warn(
      `⚠ DEVICE_ROLE_META not resolvable (attempt ${attempt}/3) — R2-b may be mid-refactor; retrying in 40s…`
    );
    await new Promise((r) => setTimeout(r, 40_000));
  }
}

/** Roles that previously fell to device-generic and MUST now be specific. */
const MUST_NOT_BE_GENERIC = [
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

if (!deviceRoleMeta) {
  fail(
    `DEVICE_ROLE_META not found (src/lib/icons/device-role-meta.ts) — device-role semantic checks cannot run; run after R2-b lands (B1-012)`
  );
} else {
  let roleBad = 0;
  for (const [role, meta] of Object.entries(deviceRoleMeta)) {
    const resolved = deviceIconFor(role);
    if (resolved !== meta.icon) {
      fail(
        `device role "${role}": deviceIconFor → "${resolved}" but DEVICE_ROLE_META declares "${meta.icon}" (B1-012)`
      );
      roleBad++;
    }
    if (!disk.has(meta.icon)) {
      fail(`device role "${role}" → missing master "${meta.icon}.svg"`);
      roleBad++;
    }
    if (deviceIconLabelFor) {
      const label = deviceIconLabelFor(role);
      if (!label || label.trim() === "" || label === "Device type glyph") {
        fail(
          `device role "${role}": deviceIconLabelFor returns ${label ? `"${label}"` : "empty"} — known roles need a real label (B1-012)`
        );
        roleBad++;
      }
    } else {
      fail(
        `deviceIconLabelFor not found (device-role-meta.ts / device-icons.ts) — known device roles need real labels (B1-012)`
      );
      roleBad++;
      break; // one clear message is enough
    }
  }
  for (const role of MUST_NOT_BE_GENERIC) {
    if (!(role in deviceRoleMeta)) {
      fail(`DEVICE_ROLE_META is missing required role "${role}" (B1-012)`);
      roleBad++;
    }
    if (deviceIconFor(role) === GENERIC_DEVICE_ICON) {
      fail(
        `device role "${role}" resolves to GENERIC_DEVICE_ICON — it must map to its governed glyph now (B1-012)`
      );
      roleBad++;
    }
  }
  if (roleBad === 0) {
    ok(
      `device-role metadata: ${Object.keys(deviceRoleMeta).length} roles resolve to their declared glyphs + labels; previously-generic roles are specific`
    );
  }
}

// Family probes (substring matcher paths) + fallback probe: unknown roles
// must still resolve to the generic device glyph, which must exist.
for (const t of [
  "router",
  "switch",
  "firewall",
  "server",
  "appliance",
  "cloud",
  "virtual",
]) {
  const name = deviceIconFor(t);
  if (!disk.has(name)) fail(`device type "${t}" → missing master "${name}.svg"`);
}
for (const probe of [null, "", "unknown-thing"]) {
  if (deviceIconFor(probe) !== GENERIC_DEVICE_ICON) {
    fail(`unknown device probe "${String(probe)}" did not fall back to GENERIC_DEVICE_ICON`);
  }
}
if (!disk.has(GENERIC_DEVICE_ICON)) {
  fail(`GENERIC_DEVICE_ICON "${GENERIC_DEVICE_ICON}" is missing on disk`);
}
ok("device-type fallback probes resolve (unknown ⇒ device-generic)");

/* ------------------------------------------------------------------ */
/* 6. Runtime-referenced scan / orphan policy (B1-010).                */
/*    referenced = NAVIGATION_ICONS + VENDOR_ICON + DEVICE_ROLE_META   */
/*    icons + any quoted literal matching an icon name in src source.  */
/* ------------------------------------------------------------------ */

const runtimeReferenced = new Set<string>();
for (const entry of Object.values(navRecord)) {
  if (entry.kind === "fayanms" && entry.name) runtimeReferenced.add(entry.name);
}
for (const name of Object.values(vendorIconRecord)) runtimeReferenced.add(name);
if (deviceRoleMeta) {
  for (const meta of Object.values(deviceRoleMeta)) runtimeReferenced.add(meta.icon);
}

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...collectTsFiles(p));
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}
const SRC_DIR = join(ROOT, "src");
for (const p of collectTsFiles(SRC_DIR)) {
  // src/lib/icons/types.ts IS the generated catalog definition (the union
  // lists all 228 names as quoted literals) — counting it would make every
  // master trivially "referenced" and the B1-010 orphan warning dead. It is
  // the cataloged/registered set, not a runtime consumer; every other src
  // file counts.
  if (p === join(ROOT, "src", "lib", "icons", "types.ts")) continue;
  const src = readFileSync(p, "utf8");
  for (const m of src.matchAll(/["'`]([a-z0-9-]+)["'`]/g)) {
    if (disk.has(m[1])) runtimeReferenced.add(m[1]);
  }
}

// Registry-referenced but disk-missing is already a hard failure above;
// disk masters nobody references are the B1-010 warning class.
const orphans = [...disk].filter((n) => !runtimeReferenced.has(n));
if (orphans.length > 0) {
  warn(
    `${orphans.length} cataloged icon(s) currently unused by runtime: ${orphans.slice(0, 12).join(", ")}${orphans.length > 12 ? " …" : ""} (allowed — reusable catalog, B1-010)`
  );
} else {
  ok(`all ${disk.size} masters are runtime-referenced`);
}

/* ------------------------------------------------------------------ */

console.log(`\n${warnings} warnings, ${failures} failures`);
if (failures > 0) {
  console.error(`brand:validate-icons FAILED — ${failures} issue(s)`);
  process.exit(1);
}
console.log("brand:validate-icons passed.");
