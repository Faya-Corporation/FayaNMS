import { cn } from "@/lib/utils";
import type { BrandTone } from "@/lib/brand/types";
import { MARK_GEOMETRY, type MarkShape } from "@/lib/brand/mark-geometry";

/**
 * Named sizes (re-audit B2-019): the guide's container-vs-glyph minimums map
 * onto these named variants — xs 14 (footer), sm 20 (nav), md 24 (headers),
 * lg 32 (loading/report sub-header), xl 40 (sign-in glyph), 2xl 64 (docs and
 * report covers). Numeric sizes remain an explicit escape hatch.
 */
const MARK_SIZES = {
  xs: 14,
  sm: 20,
  md: 24,
  lg: 32,
  xl: 40,
  "2xl": 64,
} as const;

export type FayaNMSMarkSize = keyof typeof MARK_SIZES;

/**
 * Tone → CSS token class (re-audit B2-018): application rendering uses the
 * design tokens, never the raw brand hex. The hex values exist only in
 * `FAYANMS_BRAND` for non-CSS artifacts (metadata, SVG masters, satori
 * cards, raster scripts).
 */
const MARK_TONES: Record<BrandTone, string> = {
  brand: "text-primary",
  current: "",
  white: "text-white",
  mono: "text-foreground",
};

export interface FayaNMSMarkProps {
  size?: FayaNMSMarkSize;
  tone?: BrandTone;
  /**
   * When true (default) the mark is purely decorative and hidden from
   * assistive tech — pair it with visible "FayaNMS" text. Set false and pass
   * `title` only when the mark stands alone.
   */
  decorative?: boolean;
  /** Accessible name for a standalone, meaningful mark. */
  title?: string;
  className?: string;
}

/** Render the shared geometry as JSX (single geometry source, B1-005/006). */
function MarkShapes({ geometry }: { geometry: readonly MarkShape[] }) {
  return (
    <>
      {geometry.map((shape, index) => {
        if (shape.kind === "circle") {
          return (
            <circle
              key={index}
              cx={shape.cx}
              cy={shape.cy}
              r={shape.r}
              fill={shape.filled ? "currentColor" : "none"}
            />
          );
        }
        return (
          <line
            key={index}
            x1={shape.x1}
            y1={shape.y1}
            x2={shape.x2}
            y2={shape.y2}
          />
        );
      })}
    </>
  );
}

/**
 * FayaNMS primary product mark — network nodes inside a protected
 * operations ring (Phase B0, BRAND-002/004).
 *
 * Geometry is consumed from `src/lib/brand/mark-geometry.ts` — the single
 * geometric source shared with the metadata artwork, raster generator and
 * static masters. Inline SVG using `currentColor` so the mark adapts to app
 * theming without separate dark geometry. Never animated, never
 * keyboard-focusable, never recolored with status semantics.
 */
export function FayaNMSMark({
  size = "md",
  tone = "current",
  decorative = true,
  title,
  className,
}: FayaNMSMarkProps) {
  const px = MARK_SIZES[size];
  const accessible = !decorative && Boolean(title);

  return (
    <svg
      viewBox="0 0 24 24"
      width={px}
      height={px}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={accessible ? undefined : true}
      focusable="false"
      role={accessible ? "img" : undefined}
      aria-label={accessible ? title : undefined}
      className={cn("shrink-0", MARK_TONES[tone], className)}
    >
      {accessible ? <title>{title}</title> : null}
      <MarkShapes geometry={MARK_GEOMETRY} />
    </svg>
  );
}
