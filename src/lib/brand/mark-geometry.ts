/**
 * FayaNMS mark geometry — THE single geometric source of truth (re-audit
 * B1-005/B1-006, plan BR-C1-001).
 *
 * Every rendering of the FayaNMS product mark derives from this module:
 *
 *  - `FayaNMSMark` (runtime React component, src/components/brand);
 *  - the file-based metadata artwork (apple-icon / opengraph-image /
 *    twitter-image via the shared social card);
 *  - `scripts/generate-brand-raster-assets.ts` (app icons, favicon.ico,
 *    github-social-preview and ALL static mark SVG masters);
 *  - `public/logo.svg` (legacy compat path, regenerated).
 *
 * No other file may inline the mark's circles/lines — the brand consumer
 * validator (`scripts/validate-brand-consumers.ts`) fails any duplicate
 * geometry signature, and `brand:validate` re-derives the static masters
 * from here and fails on drift (stale-asset detection).
 *
 * Two governed geometries live here:
 *  - MARK_GEOMETRY  — the full 24×24 outline mark (ring + outlined nodes +
 *    connectors). Used at ≥20px and in all generated artwork.
 *  - MARK_MICRO_GEOMETRY — the 16–20px favicon micro-mark (re-audit B1-014):
 *    same ring, SOLID nodes, simplified hub, no connectors. Not a scaled
 *    copy — a deliberate small-size derivative.
 */

export type MarkShape =
  | { kind: "circle"; cx: number; cy: number; r: number; filled?: boolean }
  | { kind: "line"; x1: number; y1: number; x2: number; y2: number };

/** Full mark — ring + three outlined nodes + three connectors (24×24). */
export const MARK_GEOMETRY: readonly MarkShape[] = [
  { kind: "circle", cx: 12, cy: 12, r: 9 },
  { kind: "circle", cx: 12, cy: 8, r: 1.5 },
  { kind: "circle", cx: 8, cy: 15, r: 1.5 },
  { kind: "circle", cx: 16, cy: 15, r: 1.5 },
  { kind: "line", x1: 12, y1: 9.5, x2: 12, y2: 12 },
  { kind: "line", x1: 12, y1: 12, x2: 8.8, y2: 13.8 },
  { kind: "line", x1: 12, y1: 12, x2: 15.2, y2: 13.8 },
] as const;

/**
 * Favicon micro-mark — ring + three SOLID nodes + a solid simplified hub.
 * Optimized for 16–20 px: filled points survive rasterization where 2px
 * outlined circles turn muddy (docs/brand/BRAND-GUIDELINES.md minimums).
 */
export const MARK_MICRO_GEOMETRY: readonly MarkShape[] = [
  { kind: "circle", cx: 12, cy: 12, r: 9 },
  { kind: "circle", cx: 12, cy: 8, r: 2, filled: true },
  { kind: "circle", cx: 8, cy: 15, r: 2, filled: true },
  { kind: "circle", cx: 16, cy: 15, r: 2, filled: true },
  { kind: "circle", cx: 12, cy: 12, r: 1.5, filled: true },
] as const;

export interface RenderMarkSvgOptions {
  /** Output pixel size (the viewBox is always 0 0 24 24). */
  size: number;
  /** Stroke/fill paint — a literal color for non-CSS artifacts. */
  color: string;
  /** Stroke width for outlined shapes (solid nodes ignore it). */
  strokeWidth?: number;
}

/** Serialize a geometry to the inner body of a 24×24 SVG (no <svg> wrapper). */
export function renderMarkBody(
  geometry: readonly MarkShape[],
  { color, strokeWidth = 2 }: Omit<RenderMarkSvgOptions, "size">
): string {
  return geometry
    .map((shape) => {
      const paint = `fill="${shape.kind === "circle" && shape.filled ? color : "none"}" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"`;
      if (shape.kind === "circle") {
        return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" ${paint}/>`;
      }
      return `<line x1="${shape.x1}" y1="${shape.y1}" x2="${shape.x2}" y2="${shape.y2}" ${paint}/>`;
    })
    .join("\n  ");
}

/** Full standalone SVG string for a mark geometry (scripts / masters). */
export function renderFayaNMSMarkSvg(
  geometry: readonly MarkShape[],
  { size, color, strokeWidth }: RenderMarkSvgOptions
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
  ${renderMarkBody(geometry, { color, strokeWidth })}
</svg>`;
}

/** Scale-and-translate wrapper used by raster tiles (app icons, favicons). */
export function renderMarkGroup(
  geometry: readonly MarkShape[],
  opts: RenderMarkSvgOptions & { translateX?: number; translateY?: number }
): string {
  const { size, translateX = 0, translateY = 0, ...rest } = opts;
  return `<g transform="translate(${translateX},${translateY}) scale(${(size / 24).toFixed(4)})">\n  ${renderMarkBody(geometry, rest)}\n</g>`;
}
