/**
 * Brand asset validation (re-audit B1-008/§9 — strengthened validator).
 * Run: `bun run brand:validate`
 *
 * This is the deterministic, comprehensive gate for Tier-1 brand assets and
 * Tier-2 icon geometry. It FAILS when any of the following holds:
 *
 *  1. Tier-1 governed inventory (public/brand/) is not EXACTLY the canonical
 *     set — missing governed master, unknown extra file, invalid extension,
 *     or two files mapping to the same semantic role.
 *  2. A generated SVG master (5 brand marks, public/logo.svg,
 *     src/app/icon.svg) is STALE — re-derived from src/lib/brand/mark-geometry.ts
 *     via renderFayaNMSMarkSvg() and byte-compared with disk.
 *  3. A brand SVG (public/brand/*.svg + public/logo.svg) parses with a valid
 *     root but contains script / external href / remote <image> / animation /
 *     filter / <style> / foreignObject (<text> is allowed — wordmark/lockup
 *     masters are text-based by policy).
 *  4. Any runtime icon (public/icons/fayanms/*.svg) violates the EXACT
 *     Tier-2 root contract — viewBox="0 0 24 24", fill="none",
 *     stroke="currentColor", stroke-width="2", round caps/joins — or contains
 *     gradients/filters/styles/scripts/animation/external refs/hardcoded
 *     palette colors, or a non-kebab-case filename.
 *  5. Colors in generated brand masters do not come from FAYANMS_BRAND
 *     (imported from src/lib/brand/identity.ts — no duplicated palette here).
 *  6. A raster derivative has wrong dimensions (sharp-verified) or is a STALE
 *     RASTER — the validator re-renders each PNG through the shared
 *     composition module (scripts/brand-raster-composition.ts, the exact code
 *     path `bun run brand:raster` uses) and compares raw pixels; favicon.ico
 *     is rebuilt via buildIco() and byte-compared.
 *  7. src/app/favicon.ico is not a valid PNG-in-ICO container with exactly
 *     16/32/48 entries decoding to those dimensions.
 *  8. layout.tsx references an external http(s) icon/logo URL (BRAND-001),
 *     a file-based metadata file is missing, or public/logo.svg is animated.
 *  9. OG/Twitter/social-card artwork contains a gradient (B1-007 guard).
 * 10. src/app/icon.svg contains <line> — it must be the MICRO mark (no
 *     connectors), proving the micro-favicon policy (B1-014).
 *
 * Exit code 1 on any failure, 0 otherwise.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

import {
  MARK_GEOMETRY,
  MARK_MICRO_GEOMETRY,
  renderFayaNMSMarkSvg,
} from "../src/lib/brand/mark-geometry";
import { FAYANMS_BRAND } from "../src/lib/brand/identity";
import {
  appIconSvg,
  maskableIconSvg,
  faviconTileSvg,
  socialPreviewSvg,
  buildIco,
} from "./brand-raster-composition";
import {
  checkBrandMasterSvg,
  checkTier2IconContract,
} from "./svg-contract";

const ROOT = join(import.meta.dir, "..");
const BRAND_DIR = join(ROOT, "public", "brand");
const ICONS_DIR = join(ROOT, "public", "icons", "fayanms");
const APP_DIR = join(ROOT, "src", "app");

let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.error(`✗ ${msg}`);
};
const ok = (msg: string) => console.log(`✓ ${msg}`);

const rel = (p: string) => p.slice(ROOT.length + 1);

/* ------------------------------------------------------------------ */
/* 1. Tier-1 governed inventory — exact expected set + role map.       */
/* ------------------------------------------------------------------ */

/** Canonical role → filename map. Two files must never share a role. */
const GOVERNED_FILES: Record<string, string> = {
  // 12 governed SVG masters (docs/brand/ASSET-MANIFEST.md)
  "fayanms-mark.svg": "mark/currentColor",
  "fayanms-mark-brand.svg": "mark/brand",
  "fayanms-mark-micro.svg": "mark/micro",
  "fayanms-mark-mono.svg": "mark/mono",
  "fayanms-mark-white.svg": "mark/white",
  "fayanms-wordmark.svg": "wordmark",
  "fayanms-wordmark-white.svg": "wordmark/white",
  "fayanms-lockup-horizontal.svg": "lockup-horizontal",
  "fayanms-lockup-horizontal-white.svg": "lockup-horizontal/white",
  "fayanms-lockup-stacked.svg": "lockup-stacked",
  "fayanms-noc-mark.svg": "noc-mark",
  "fayanms-network-shield.svg": "network-shield",
  // Governance documentation
  "README.md": "documentation",
  // Generated raster derivatives (bun run brand:raster)
  "app-icon-192.png": "raster/app-icon-192",
  "app-icon-512.png": "raster/app-icon-512",
  "app-icon-maskable-192.png": "raster/app-icon-maskable-192",
  "app-icon-maskable-512.png": "raster/app-icon-maskable-512",
  "github-social-preview.png": "raster/github-social-preview",
};

for (const [file, role] of Object.entries(GOVERNED_FILES)) {
  if (existsSync(join(BRAND_DIR, file))) ok(`governed brand file ${file} (${role})`);
  else fail(`missing governed master public/brand/${file} (${role})`);
}

const brandDirFiles = readdirSync(BRAND_DIR);
const seenRoles = new Set<string>();
for (const f of brandDirFiles) {
  const role = GOVERNED_FILES[f];
  if (!role) {
    const ext = f.slice(f.lastIndexOf("."));
    fail(
      `unknown extra file public/brand/${f} (unrecognized name${/^\.(svg|png|md)$/.test(ext) ? "" : ` / invalid extension "${ext}"`}) — public/brand is governed, not a scratch area`
    );
    continue;
  }
  if (seenRoles.has(role)) {
    fail(`duplicate semantic role "${role}" — two files in public/brand map to it`);
  }
  seenRoles.add(role);
}
if (brandDirFiles.length === Object.keys(GOVERNED_FILES).length && failures === 0) {
  ok(`tier-1 inventory exact (${brandDirFiles.length}/${Object.keys(GOVERNED_FILES).length} files, roles unique)`);
}

/* ------------------------------------------------------------------ */
/* 2. Geometry-derivation staleness (B1-005 closure) — byte-compare    */
/*    every generated SVG with a fresh render from mark-geometry.      */
/* ------------------------------------------------------------------ */

const DERIVED_SVGS: Array<[string, string]> = [
  [
    join(BRAND_DIR, "fayanms-mark.svg"),
    renderFayaNMSMarkSvg(MARK_GEOMETRY, { size: 24, color: "currentColor" }) + "\n",
  ],
  [
    join(BRAND_DIR, "fayanms-mark-brand.svg"),
    renderFayaNMSMarkSvg(MARK_GEOMETRY, { size: 24, color: FAYANMS_BRAND.colors.primary }) + "\n",
  ],
  [
    join(BRAND_DIR, "fayanms-mark-mono.svg"),
    renderFayaNMSMarkSvg(MARK_GEOMETRY, { size: 24, color: "#000000" }) + "\n",
  ],
  [
    join(BRAND_DIR, "fayanms-mark-white.svg"),
    renderFayaNMSMarkSvg(MARK_GEOMETRY, { size: 24, color: "#FFFFFF" }) + "\n",
  ],
  [
    join(BRAND_DIR, "fayanms-mark-micro.svg"),
    renderFayaNMSMarkSvg(MARK_MICRO_GEOMETRY, { size: 24, color: "currentColor" }) + "\n",
  ],
  [
    join(ROOT, "public", "logo.svg"),
    renderFayaNMSMarkSvg(MARK_GEOMETRY, { size: 24, color: FAYANMS_BRAND.colors.primary }) + "\n",
  ],
  [
    join(APP_DIR, "icon.svg"),
    renderFayaNMSMarkSvg(MARK_MICRO_GEOMETRY, { size: 24, color: FAYANMS_BRAND.colors.primary }) + "\n",
  ],
];

for (const [path, expected] of DERIVED_SVGS) {
  if (!existsSync(path)) {
    fail(`${rel(path)}: missing — run: bun run brand:raster`);
    continue;
  }
  const disk = readFileSync(path, "utf8");
  if (disk === expected) ok(`${rel(path)}: derived from mark-geometry (byte-exact)`);
  else fail(`${rel(path)}: stale — run bun run brand:raster (does not match mark-geometry derivation)`);
}

/* ------------------------------------------------------------------ */
/* 3. Brand SVG safety scan (public/brand/*.svg + public/logo.svg).    */
/* ------------------------------------------------------------------ */

const brandSvgs = brandDirFiles.filter((f) => f.endsWith(".svg"));
for (const f of brandSvgs) {
  const src = readFileSync(join(BRAND_DIR, f), "utf8");
  for (const v of checkBrandMasterSvg(f, src)) fail(`brand/${v.detail}`);
}
const logoSrc = existsSync(join(ROOT, "public", "logo.svg"))
  ? readFileSync(join(ROOT, "public", "logo.svg"), "utf8")
  : "";
for (const v of checkBrandMasterSvg("logo.svg", logoSrc)) fail(`public/${v.detail}`);
if (failures === 0) ok(`${brandSvgs.length + 1} brand SVGs: valid roots, no script/animation/external refs`);

/* ------------------------------------------------------------------ */
/* 4. Tier-2 geometry contract — ALL public/icons/fayanms/*.svg.       */
/* ------------------------------------------------------------------ */

const NAME_RE = /^[a-z0-9-]+\.svg$/;
const iconFiles = readdirSync(ICONS_DIR).filter((f) => f.endsWith(".svg"));
let tier2Bad = 0;
for (const f of readdirSync(ICONS_DIR)) {
  if (!f.endsWith(".svg")) {
    fail(`icons/${f}: non-SVG file in the governed runtime icon directory`);
    continue;
  }
  if (!NAME_RE.test(f)) {
    fail(`icons/${f}: invalid name (kebab-case [a-z0-9-] only, no traversal)`);
    tier2Bad++;
  }
  const src = readFileSync(join(ICONS_DIR, f), "utf8");
  const violations = checkTier2IconContract(f, src);
  if (violations.length > 0) {
    tier2Bad++;
    for (const v of violations) fail(`icons/${v.detail}`);
  }
}
if (tier2Bad === 0) {
  ok(`tier-2 geometry contract: ${iconFiles.length}/${iconFiles.length} masters exact (viewBox 0 0 24 24, fill none, stroke currentColor, stroke-width 2, round caps/joins, no gradients/filters/styles/scripts/animation/external refs/hardcoded colors)`);
}

/* ------------------------------------------------------------------ */
/* 5. Brand color validation against FAYANMS_BRAND (§9.4).             */
/* ------------------------------------------------------------------ */

// The only palette values generated masters may contain: the brand primary
// (imported — never duplicated) and the policy black/white master colors.
const ALLOWED_MASTER_COLORS = new Set([
  FAYANMS_BRAND.colors.primary,
  "#FFFFFF",
  "#000000",
]);
const BRAND_COLORED_MASTERS = [
  join(BRAND_DIR, "fayanms-mark-brand.svg"),
  join(ROOT, "public", "logo.svg"),
  join(APP_DIR, "icon.svg"),
];
for (const path of BRAND_COLORED_MASTERS) {
  if (!existsSync(path)) continue; // already reported missing above
  const src = readFileSync(path, "utf8");
  if (!src.includes(`stroke="${FAYANMS_BRAND.colors.primary}"`)) {
    fail(`${rel(path)}: does not paint with FAYANMS_BRAND.colors.primary (${FAYANMS_BRAND.colors.primary})`);
  }
  for (const m of src.matchAll(/#[0-9A-Fa-f]{6}\b/g)) {
    const upper = m[0].toUpperCase();
    if (!ALLOWED_MASTER_COLORS.has(upper)) {
      fail(`${rel(path)}: hardcoded color ${m[0]} is not a FAYANMS_BRAND value`);
    }
  }
}
if (failures === 0) ok(`brand-colored masters use FAYANMS_BRAND.colors.primary (${FAYANMS_BRAND.colors.primary}) only`);

/* ------------------------------------------------------------------ */
/* 6. Raster dimension validation (§9.5, sharp).                       */
/* ------------------------------------------------------------------ */

const RASTER_DIMS: Array<[string, number, number]> = [
  ["app-icon-192.png", 192, 192],
  ["app-icon-512.png", 512, 512],
  ["app-icon-maskable-192.png", 192, 192],
  ["app-icon-maskable-512.png", 512, 512],
  ["github-social-preview.png", 1280, 640],
];
for (const [file, w, h] of RASTER_DIMS) {
  const p = join(BRAND_DIR, file);
  if (!existsSync(p)) {
    fail(`missing ${file} — run: bun run brand:raster`);
    continue;
  }
  const meta = await sharp(p).metadata();
  if (meta.width !== w || meta.height !== h) {
    fail(`${file}: wrong dimensions ${meta.width}×${meta.height}, expected ${w}×${h}`);
  } else {
    ok(`raster ${file}: ${w}×${h}`);
  }
}

/* ------------------------------------------------------------------ */
/* 7. favicon.ico structural validation (PNG-in-ICO, 16/32/48).        */
/* ------------------------------------------------------------------ */

const ICO_PATH = join(APP_DIR, "favicon.ico");
const ICO_SIZES = [16, 32, 48];
let icoBuf: Buffer | null = null;
if (!existsSync(ICO_PATH)) {
  fail(`missing src/app/favicon.ico — run: bun run brand:raster`);
} else {
  icoBuf = readFileSync(ICO_PATH);
  const reserved = icoBuf.readUInt16LE(0);
  const type = icoBuf.readUInt16LE(2);
  const count = icoBuf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) {
    fail(`src/app/favicon.ico: invalid ICO header (reserved=${reserved}, type=${type})`);
  } else if (count !== ICO_SIZES.length) {
    fail(`src/app/favicon.ico: expected ${ICO_SIZES.length} entries, found ${count}`);
  } else {
    for (let i = 0; i < count; i++) {
      const e = 6 + i * 16;
      const size = ICO_SIZES[i];
      const wByte = icoBuf.readUInt8(e); // 0 means 256
      const hByte = icoBuf.readUInt8(e + 1);
      const len = icoBuf.readUInt32LE(e + 8);
      const off = icoBuf.readUInt32LE(e + 12);
      if (wByte !== size || hByte !== size) {
        fail(`src/app/favicon.ico: entry ${i} declares ${wByte}×${hByte}, expected ${size}×${size}`);
        continue;
      }
      if (off + len > icoBuf.length) {
        fail(`src/app/favicon.ico: entry ${i} data out of bounds`);
        continue;
      }
      const png = icoBuf.subarray(off, off + len);
      if (png.length < 8 || png[0] !== 0x89 || png[1] !== 0x50) {
        fail(`src/app/favicon.ico: entry ${i} is not an embedded PNG`);
        continue;
      }
      const meta = await sharp(png).metadata();
      if (meta.width !== size || meta.height !== size) {
        fail(`src/app/favicon.ico: entry ${i} decodes to ${meta.width}×${meta.height}, expected ${size}×${size}`);
      }
    }
    if (failures === 0) ok(`src/app/favicon.ico: valid PNG-in-ICO container (${ICO_SIZES.join("/")})`);
  }
}

/* ------------------------------------------------------------------ */
/* 8. Stale raster derivative detection (§9.5 made executable).        */
/*    Re-render every PNG through the SAME shared composition the      */
/*    generator uses, then compare decoded raw pixels; rebuild the     */
/*    ICO bytes and byte-compare.                                      */
/* ------------------------------------------------------------------ */

async function rawPixels(input: string | Buffer) {
  const { data, info } = await sharp(input)
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, info };
}

const RASTER_JOBS: Array<[string, string]> = [
  ["app-icon-192.png", appIconSvg(192)],
  ["app-icon-512.png", appIconSvg(512)],
  ["app-icon-maskable-192.png", maskableIconSvg(192)],
  ["app-icon-maskable-512.png", maskableIconSvg(512)],
  ["github-social-preview.png", socialPreviewSvg()],
];
for (const [file, svg] of RASTER_JOBS) {
  const p = join(BRAND_DIR, file);
  if (!existsSync(p)) continue; // missing already reported
  const expected = await rawPixels(Buffer.from(svg));
  const disk = await rawPixels(p);
  const sameShape =
    disk.info.width === expected.info.width &&
    disk.info.height === expected.info.height &&
    disk.info.channels === expected.info.channels;
  if (!sameShape || !disk.data.equals(expected.data)) {
    fail(`${file}: stale raster derivative — run bun run brand:raster`);
  } else {
    ok(`raster ${file}: pixels match composition module (not stale)`);
  }
}

if (icoBuf) {
  const pngs: { size: number; data: Buffer }[] = [];
  for (const px of ICO_SIZES) {
    pngs.push({
      size: px,
      data: await sharp(Buffer.from(faviconTileSvg(px))).png().toBuffer(),
    });
  }
  const expectedIco = buildIco(pngs);
  if (!icoBuf.equals(expectedIco)) {
    fail(`src/app/favicon.ico: stale raster derivative — run bun run brand:raster (bytes differ from buildIco/faviconTileSvg rebuild)`);
  } else {
    ok(`src/app/favicon.ico: bytes match buildIco/faviconTileSvg rebuild (MICRO mark, B1-014)`);
  }
}

/* ------------------------------------------------------------------ */
/* 9. Metadata regression guards (kept from the B3 validator).         */
/* ------------------------------------------------------------------ */

const layoutPath = join(APP_DIR, "layout.tsx");
const layout = readFileSync(layoutPath, "utf8");
if (/icons:\s*\{[^}]*https?:\/\//.test(layout)) {
  fail("layout.tsx references an external http(s) icon URL (BRAND-001)");
} else if (/https?:\/\/[^\s"'`)]*\.(svg|png|ico)/i.test(layout)) {
  fail("layout.tsx references an external http(s) icon/logo URL (BRAND-001)");
} else {
  ok("layout metadata uses local file-based icons only");
}

for (const f of [
  "icon.svg",
  "favicon.ico",
  "apple-icon.tsx",
  "opengraph-image.tsx",
  "twitter-image.tsx",
  "manifest.ts",
]) {
  if (existsSync(join(APP_DIR, f))) ok(`metadata file ${f}`);
  else fail(`missing src/app/${f}`);
}

if (/<animate|@keyframes|z-breathe/.test(logoSrc)) {
  fail("public/logo.svg is animated — replace with the canonical static mark (BRAND-004)");
} else if (logoSrc) {
  ok("public/logo.svg static (canonical mark)");
}

/* ------------------------------------------------------------------ */
/* 10. OG/Twitter no-gradient guard (B1-007 regression guard).         */
/* ------------------------------------------------------------------ */

for (const f of [
  join(APP_DIR, "opengraph-image.tsx"),
  join(APP_DIR, "twitter-image.tsx"),
  join(ROOT, "src", "components", "brand", "social-card.tsx"),
]) {
  if (!existsSync(f)) {
    fail(`missing ${rel(f)} (metadata/social artwork)`);
    continue;
  }
  const src = readFileSync(f, "utf8");
  if (/linear-gradient|radial-gradient/.test(src)) {
    fail(`${rel(f)}: contains a gradient — brand artwork must use the solid primary/accent composition (B1-007)`);
  } else {
    ok(`${rel(f)}: no gradient (B1-007 guard)`);
  }
}

/* ------------------------------------------------------------------ */
/* 11. Micro-mark favicon policy (B1-014).                             */
/* ------------------------------------------------------------------ */

const iconSvgPath = join(APP_DIR, "icon.svg");
if (existsSync(iconSvgPath)) {
  const iconSvg = readFileSync(iconSvgPath, "utf8");
  if (/<line\b/.test(iconSvg)) {
    fail("src/app/icon.svg contains <line> — the favicon must derive from MARK_MICRO_GEOMETRY (no connectors), not the full mark (B1-014)");
  } else {
    ok("src/app/icon.svg is the MICRO mark (no connectors — B1-014)");
  }
}

/* ------------------------------------------------------------------ */

if (failures > 0) {
  console.error(`\nbrand:validate FAILED — ${failures} issue(s)`);
  process.exit(1);
}
console.log("\nbrand:validate passed.");
