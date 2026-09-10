/**
 * FayaNMS brand raster asset generation (Phase B2/B3, plan §36).
 *
 * Single source: the SVG mark master. No raster derivative is hand-maintained.
 *
 *   bun run brand:raster
 *
 * Generates:
 *   public/brand/app-icon-192.png / app-icon-512.png           (blue tile + white mark)
 *   public/brand/app-icon-maskable-192.png / -512.png          (full-bleed, 80% safe zone)
 *   src/app/favicon.ico                                        (16/32/48, PNG-in-ICO)
 *   public/brand/github-social-preview.png                     (1280×640 master)
 *
 * Note: GitHub/social text is rendered by librsvg with the fonts available
 * in this environment (DejaVu Sans). Regenerate on a machine with Inter for
 * pixel-exact brand typography — geometry is unaffected.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(import.meta.dir, "..");
const BRAND_DIR = join(ROOT, "public", "brand");

const BLUE = "#2563EB";
const ACCENT = "#0891B2";
const INK = "#0F172A";
const MUTED = "#475569";
const SURFACE = "#F8FAFC";

/** The mark, parameterizable so stroke scaling stays optically consistent. */
function markSvg(size: number, stroke: string, strokeWidth = 2): string {
  return `
    <g transform="scale(${size / 24})" fill="none" stroke="${stroke}"
       stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <circle cx="12" cy="8" r="1.5"/>
      <circle cx="8" cy="15" r="1.5"/>
      <circle cx="16" cy="15" r="1.5"/>
      <line x1="12" y1="9.5" x2="12" y2="12"/>
      <line x1="12" y1="12" x2="8.8" y2="13.8"/>
      <line x1="12" y1="12" x2="15.2" y2="13.8"/>
    </g>`;
}

function appIconSvg(px: number): string {
  // Blue rounded tile + white mark at ~62% — mirrors the sidebar brand tile.
  const mark = px * 0.62;
  const off = (px - mark) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect width="${px}" height="${px}" rx="${px * 0.22}" fill="${BLUE}"/>
  <g transform="translate(${off},${off})">${markSvg(mark, "#FFFFFF", 2.1)}</g>
</svg>`;
}

function maskableIconSvg(px: number): string {
  // Full-bleed background; content confined to the 80% maskable safe zone.
  const mark = px * 0.5;
  const off = (px - mark) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect width="${px}" height="${px}" fill="${BLUE}"/>
  <g transform="translate(${off},${off})">${markSvg(mark, "#FFFFFF", 2.1)}</g>
</svg>`;
}

function faviconSvg(px: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect width="${px}" height="${px}" rx="${px * 0.2}" fill="#FFFFFF"/>
  <g transform="translate(${px * 0.1},${px * 0.1})">${markSvg(px * 0.8, BLUE, 2.2)}</g>
</svg>`;
}

function socialPreviewSvg(): string {
  const W = 1280;
  const H = 640;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${SURFACE}"/>
  <rect width="${W}" height="8" fill="${BLUE}"/>
  <rect y="${H - 8}" width="${W}" height="8" fill="${ACCENT}"/>
  <g transform="translate(150,205)">${markSvg(230, BLUE, 1.9)}</g>
  <text x="440" y="315" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="104" font-weight="700" letter-spacing="-2" fill="${INK}">FayaNMS</text>
  <text x="444" y="368" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="34" fill="${MUTED}">Network Operations Management</text>
  <text x="440" y="452" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="26" fill="${INK}">Multi-vendor Network Management · Enterprise</text>
  <text x="440" y="496" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="24" fill="${MUTED}">Configuration · Changes · NOC · Performance · Automation</text>
</svg>`;
}

/** PNG-in-ICO container (Vista+). 6-byte dir + N×16-byte entries + PNGs. */
function buildIco(pngs: { size: number; data: Buffer }[]): Buffer {
  const count = pngs.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const entries: Buffer[] = [];
  let offset = 6 + count * 16;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

async function main() {
  mkdirSync(BRAND_DIR, { recursive: true });

  const jobs: Array<[string, string, number?]> = [
    ["app-icon-192.png", appIconSvg(192)],
    ["app-icon-512.png", appIconSvg(512)],
    ["app-icon-maskable-192.png", maskableIconSvg(192)],
    ["app-icon-maskable-512.png", maskableIconSvg(512)],
    ["github-social-preview.png", socialPreviewSvg()],
  ];

  for (const [file, svg] of jobs) {
    const out = join(BRAND_DIR, file);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log(`✓ ${file}`);
  }

  // favicon.ico — 16/32/48 in one container next to file-based icon.svg.
  const pngs: { size: number; data: Buffer }[] = [];
  for (const px of [16, 32, 48]) {
    const data = await sharp(Buffer.from(faviconSvg(px))).png().toBuffer();
    pngs.push({ size: px, data });
  }
  const icoPath = join(ROOT, "src", "app", "favicon.ico");
  writeFileSync(icoPath, buildIco(pngs));
  console.log("✓ src/app/favicon.ico (16/32/48)");

  console.log("\nBrand raster assets regenerated from SVG masters.");
}

await main();
