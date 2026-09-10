/**
 * FayaNMS brand raster/SVG composition builders — SHARED between the
 * generator (`scripts/generate-brand-raster-assets.ts`, `bun run brand:raster`)
 * and the validator (`scripts/validate-brand-assets.ts`, `bun run brand:validate`).
 *
 * Extracted so the validator can re-derive every generated raster derivative
 * EXACTLY as the generator built it (re-audit B1-005 closure, validator spec
 * §9.5 stale-raster detection) without duplicating composition code — the
 * validator imports these same functions, renders the same SVG, and compares
 * pixels/bytes with the files on disk.
 *
 * Everything here derives from the single geometry source
 * (`src/lib/brand/mark-geometry.ts`) and the brand identity
 * (`src/lib/brand/identity.ts`) — no geometry or palette is duplicated.
 */
import {
  MARK_GEOMETRY,
  MARK_MICRO_GEOMETRY,
  renderMarkBody,
} from "../src/lib/brand/mark-geometry";
import { FAYANMS_BRAND } from "../src/lib/brand/identity";

export const BLUE = FAYANMS_BRAND.colors.primary;
export const ACCENT = FAYANMS_BRAND.colors.accent;
export const INK = FAYANMS_BRAND.colorsNeutral.ink;
export const MUTED = FAYANMS_BRAND.colorsNeutral.muted;
export const SURFACE = FAYANMS_BRAND.colorsNeutral.surface;
export const TILE = FAYANMS_BRAND.colorsNeutral.tile;

export type Geometry = typeof MARK_GEOMETRY;

/** Standalone mark SVG master (the on-disk file form of one geometry). */
export function renderStaticMark(geometry: Geometry, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  ${renderMarkBody(geometry, { color, strokeWidth: 2 })}
</svg>`;
}

/** Nested SVG placing a mark (centered composition unit) at x/y. */
export function markSvgAt(
  geometry: Geometry,
  opts: { x: number; y: number; size: number; color: string; strokeWidth?: number }
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" x="${opts.x}" y="${opts.y}" width="${opts.size}" height="${opts.size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  ${renderMarkBody(geometry, { color: opts.color, strokeWidth: opts.strokeWidth })}
</svg>`;
}

export function appIconSvg(px: number): string {
  // Blue rounded tile + white full mark at ~62% — mirrors the sidebar tile.
  const mark = px * 0.62;
  const off = (px - mark) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect width="${px}" height="${px}" rx="${px * 0.22}" fill="${BLUE}"/>
  ${markSvgAt(MARK_GEOMETRY, { x: off, y: off, size: mark, color: "#FFFFFF", strokeWidth: 2.1 })}
</svg>`;
}

export function maskableIconSvg(px: number): string {
  // Full-bleed background; content confined to the 80% maskable safe zone.
  const mark = px * 0.5;
  const off = (px - mark) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect width="${px}" height="${px}" fill="${BLUE}"/>
  ${markSvgAt(MARK_GEOMETRY, { x: off, y: off, size: mark, color: "#FFFFFF", strokeWidth: 2.1 })}
</svg>`;
}

export function faviconTileSvg(px: number): string {
  // White tile + brand-blue MICRO mark — the 16-20px optimized derivative
  // (re-audit B1-014). The full mark is never rasterized below 32px.
  const mark = px * 0.8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${px} ${px}">
  <rect width="${px}" height="${px}" rx="${px * 0.2}" fill="${TILE}"/>
  ${markSvgAt(MARK_MICRO_GEOMETRY, { x: px * 0.1, y: px * 0.1, size: mark, color: BLUE, strokeWidth: 2.2 })}
</svg>`;
}

export function socialPreviewSvg(): string {
  const W = 1280;
  const H = 640;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${SURFACE}"/>
  <rect width="${W}" height="8" fill="${BLUE}"/>
  <rect x="${W * 0.9}" width="${W * 0.1}" height="8" fill="${ACCENT}"/>
  <rect y="${H - 8}" width="${W}" height="8" fill="${ACCENT}"/>
  ${markSvgAt(MARK_GEOMETRY, { x: 150, y: 205, size: 230, color: BLUE, strokeWidth: 1.9 })}
  <text x="440" y="315" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="104" font-weight="700" letter-spacing="-2" fill="${INK}">${FAYANMS_BRAND.name}</text>
  <text x="444" y="368" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="34" fill="${MUTED}">${FAYANMS_BRAND.descriptor}</text>
  <text x="440" y="452" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="26" fill="${INK}">Multi-vendor Network Management · ${FAYANMS_BRAND.edition}</text>
  <text x="440" y="496" font-family="Inter, 'DejaVu Sans', sans-serif" font-size="24" fill="${MUTED}">Configuration · Changes · NOC · Performance · Automation</text>
</svg>`;
}

/** PNG-in-ICO container (Vista+). 6-byte dir + N×16-byte entries + PNGs. */
export function buildIco(pngs: { size: number; data: Buffer }[]): Buffer {
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
