/**
 * Icon registry validation (Phase B3, plan §35). Run: `bun run brand:validate-icons`
 *
 * Guarantees:
 *  - every sidebar view key resolves in NAVIGATION_ICONS;
 *  - every registry icon name (nav/vendor/device) exists as an SVG master;
 *  - every vendor key maps to a glyph (or the documented generic fallback);
 *  - every device type resolves or falls back to device-generic;
 *  - the FayanmsIconName union in types.ts is EXACTLY the file set on disk;
 *  - no orphaned required icon keys.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ICONS_DIR = join(ROOT, "public", "icons", "fayanms");

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`✗ ${msg}`);
};
const ok = (msg: string) => console.log(`✓ ${msg}`);

// Disk truth.
const disk = new Set(readdirSync(ICONS_DIR).map((f) => f.replace(/\.svg$/, "")));
ok(`${disk.size} SVG masters on disk`);

// 1. FayanmsIconName union === exact file set.
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

// 2. Registries resolve (TS imported natively by bun).
const { NAVIGATION_ICONS } = await import(
  join(ROOT, "src", "lib", "icons", "navigation-icons.ts")
);
const { VENDOR_ICON, vendorIconFor } = await import(
  join(ROOT, "src", "lib", "icons", "vendor-icons.ts")
);
const { deviceIconFor } = await import(
  join(ROOT, "src", "lib", "icons", "device-icons.ts")
);

// 3. Every sidebar view key resolves in the navigation registry.
const sidebarSrc = readFileSync(
  join(ROOT, "src", "lib", "navigation", "sidebar-config.ts"),
  "utf8"
);
const viewKeys = [...sidebarSrc.matchAll(/view:\s*"([a-z0-9.-]+)"/g)].map(
  (m) => m[1]
);
const navRecord = NAVIGATION_ICONS as Record<string, { kind: string; name?: string }>;
for (const key of viewKeys) {
  const entry = navRecord[key];
  if (!entry) fail(`sidebar view "${key}" has no NAVIGATION_ICONS entry`);
  else if (entry.kind === "fayanms" && entry.name && !disk.has(entry.name))
    fail(`sidebar view "${key}" → missing master "${entry.name}.svg"`);
}
ok(`${viewKeys.length} sidebar view keys resolve`);

// 4. Every navigation icon name exists (catches orphans inside the registry).
for (const [key, entry] of Object.entries(navRecord)) {
  if (entry.kind === "fayanms" && entry.name && !disk.has(entry.name))
    fail(`NAVIGATION_ICONS["${key}"] → missing master "${entry.name}.svg"`);
}

// 5. Vendor keys resolve; fallback exists.
const VENDOR_KEYS = [
  "cisco",
  "fortinet",
  "sophos",
  "hpe",
  "juniper",
  "palo",
  "generic",
  "unknown-vendor-probe",
];
for (const v of VENDOR_KEYS) {
  const name = vendorIconFor(v);
  if (!disk.has(name)) fail(`vendor "${v}" → missing master "${name}.svg"`);
}
ok("vendor mapping resolves (incl. generic fallback)");

// Registry declared keys must cover the driver catalog's vendor set.
for (const [k, name] of Object.entries(VENDOR_ICON as Record<string, string>)) {
  if (!disk.has(name)) fail(`VENDOR_ICON["${k}"] → missing master "${name}.svg"`);
}

// 6. Device types resolve or fall back.
const DEVICE_TYPES = [
  "router",
  "switch",
  "firewall",
  "server",
  "appliance",
  "cloud",
  "virtual",
  "CORE_ROUTER",
  "TOP_OF_RACK",
  "WAN_GATEWAY",
  "WIRELESS_CONTROLLER",
  "unknown-thing",
];
for (const t of DEVICE_TYPES) {
  const name = deviceIconFor(t);
  if (!disk.has(name)) fail(`device type "${t}" → missing master "${name}.svg"`);
}
ok("device-type mapping resolves (incl. generic fallback)");

if (failures > 0) {
  console.error(`\nbrand:validate-icons FAILED — ${failures} issue(s)`);
  process.exit(1);
}
console.log("\nbrand:validate-icons passed.");
