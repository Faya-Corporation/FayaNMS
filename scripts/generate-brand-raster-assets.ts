/**
 * FayaNMS brand asset generation (re-audit B1-005/006/013/014, plan BR-C1).
 *
 * Single geometry source: `src/lib/brand/mark-geometry.ts` — this script
 * imports it (no duplicated circle/line geometry here) and the brand
 * constants from `src/lib/brand/identity.ts`. No raster or SVG derivative
 * is hand-maintained. `bun run brand:validate` re-derives every generated
 * SVG byte-for-byte and every PNG pixel-for-pixel, so a stale committed
 * derivative fails validation.
 *
 * All composition builders (appIconSvg / maskableIconSvg / faviconTileSvg /
 * socialPreviewSvg / buildIco / renderStaticMark) live in the shared module
 * `scripts/brand-raster-composition.ts` so the validator re-derives assets
 * through the EXACT same code path as this generator — composition exists
 * once (re-audit B1-005: no duplicated geometry/composition in tooling).
 *
 *   bun run brand:raster
 *
 * Generates (all paths are canonical, documented in ASSET-MANIFEST.md):
 *   public/brand/fayanms-mark.svg            (currentColor runtime master)
 *   public/brand/fayanms-mark-brand.svg      (static brand blue — README/docs/img)
 *   public/brand/fayanms-mark-mono.svg       (pure black print master)
 *   public/brand/fayanms-mark-white.svg      (white master)
 *   public/brand/fayanms-mark-micro.svg      (currentColor MICRO master)
 *   public/logo.svg                          (legacy compat path — static brand blue)
 *   src/app/icon.svg                         (micro-mark favicon, brand blue)
 *   src/app/favicon.ico                      (16/32/48 micro-mark, PNG-in-ICO)
 *   public/brand/app-icon-192.png / -512.png            (blue tile + white mark)
 *   public/brand/app-icon-maskable-192.png / -512.png   (full-bleed, 80% safe zone)
 *   public/brand/github-social-preview.png   (1280×640 master)
 *
 * Note: GitHub/social text is rendered by librsvg with the fonts available
 * in the generating environment (DejaVu Sans fallback). Regenerate on a
 * machine with Inter for pixel-exact brand typography — geometry is
 * unaffected (documented flexible-typography policy, re-audit B2-023).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

import {
  MARK_GEOMETRY,
  MARK_MICRO_GEOMETRY,
} from "../src/lib/brand/mark-geometry";
import {
  renderStaticMark,
  appIconSvg,
  maskableIconSvg,
  faviconTileSvg,
  socialPreviewSvg,
  buildIco,
  BLUE,
} from "./brand-raster-composition";

const ROOT = join(import.meta.dir, "..");
const BRAND_DIR = join(ROOT, "public", "brand");
const APP_DIR = join(ROOT, "src", "app");

async function main() {
  mkdirSync(BRAND_DIR, { recursive: true });

  // Static SVG masters derived from the shared geometry (byte-deterministic —
  // brand:validate re-derives and compares these, catching stale assets).
  const svgMasters: Array<[string, string]> = [
    ["fayanms-mark.svg", renderStaticMark(MARK_GEOMETRY, "currentColor")],
    ["fayanms-mark-brand.svg", renderStaticMark(MARK_GEOMETRY, BLUE)],
    ["fayanms-mark-mono.svg", renderStaticMark(MARK_GEOMETRY, "#000000")],
    ["fayanms-mark-white.svg", renderStaticMark(MARK_GEOMETRY, "#FFFFFF")],
    ["fayanms-mark-micro.svg", renderStaticMark(MARK_MICRO_GEOMETRY, "currentColor")],
  ];
  for (const [file, svg] of svgMasters) {
    writeFileSync(join(BRAND_DIR, file), `${svg}\n`);
    console.log(`✓ public/brand/${file}`);
  }
  // Legacy compat path + file-based favicon, regenerated from geometry.
  writeFileSync(
    join(ROOT, "public", "logo.svg"),
    `${renderStaticMark(MARK_GEOMETRY, BLUE)}\n`
  );
  console.log("✓ public/logo.svg");
  writeFileSync(
    join(APP_DIR, "icon.svg"),
    `${renderStaticMark(MARK_MICRO_GEOMETRY, BLUE)}\n`
  );
  console.log("✓ src/app/icon.svg (micro-mark)");

  // Raster app icons + social preview (dimensions asserted by brand:validate).
  const jobs: Array<[string, string, number, number?]> = [
    ["app-icon-192.png", appIconSvg(192), 192, 192],
    ["app-icon-512.png", appIconSvg(512), 512, 512],
    ["app-icon-maskable-192.png", maskableIconSvg(192), 192, 192],
    ["app-icon-maskable-512.png", maskableIconSvg(512), 512, 512],
    ["github-social-preview.png", socialPreviewSvg(), 1280, 640],
  ];
  for (const [file, svg] of jobs) {
    const out = join(BRAND_DIR, file);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log(`✓ ${file}`);
  }

  // favicon.ico — 16/32/48 MICRO-mark tiles next to file-based icon.svg.
  const pngs: { size: number; data: Buffer }[] = [];
  for (const px of [16, 32, 48]) {
    const data = await sharp(Buffer.from(faviconTileSvg(px))).png().toBuffer();
    pngs.push({ size: px, data });
  }
  writeFileSync(join(APP_DIR, "favicon.ico"), buildIco(pngs));
  console.log("✓ src/app/favicon.ico (16/32/48 micro-mark)");

  console.log("\nBrand assets regenerated from src/lib/brand/mark-geometry.ts.");
}

await main();
