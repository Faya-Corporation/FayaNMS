import { FAYANMS_BRAND } from "@/lib/brand/identity";
import { BRAND_SOCIAL_ALT } from "@/lib/brand/identity";
import { MARK_GEOMETRY } from "@/lib/brand/mark-geometry";

/**
 * Shared FayaNMS social artwork (re-audit B1-006/B2-024): ONE composition
 * consumed by opengraph-image and twitter-image (and mirrored by the raster
 * generator for the GitHub social preview). Output dimensions stay
 * surface-specific; the visual logic is not duplicated.
 *
 * Policy conformance (re-audit B1-007): the brand strip is a SOLID primary
 * rule with a separate accent segment — primary and accent are never blended
 * into gradients on brand surfaces (docs/brand/BRAND-GUIDELINES.md).
 *
 * Satori needs literal colors (no CSS masks / currentColor), so the mark is
 * painted with `FAYANMS_BRAND.colors.primary` — read from the identity, not
 * redeclared here.
 */

const BLUE = FAYANMS_BRAND.colors.primary;
const ACCENT = FAYANMS_BRAND.colors.accent;
const INK = FAYANMS_BRAND.colorsNeutral.ink;
const MUTED = FAYANMS_BRAND.colorsNeutral.muted;
const SURFACE = FAYANMS_BRAND.colorsNeutral.surface;

/** The mark as JSX for satori — geometry from the shared module. */
function SocialMark({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={BLUE}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {MARK_GEOMETRY.map((shape, index) => {
        if (shape.kind === "circle") {
          return (
            <circle key={index} cx={shape.cx} cy={shape.cy} r={shape.r} />
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
    </svg>
  );
}

/** Canonical alt text for both social surfaces. */
export const SOCIAL_CARD_ALT = BRAND_SOCIAL_ALT;

/**
 * The shared 1200×630 composition. `chipLeft` is the audience chip
 * ("Multi-vendor Network Management"); the right chip is the brand edition.
 */
export function SocialCard() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: SURFACE,
        position: "relative",
      }}
    >
      {/* Solid primary brand rule with a separate accent segment — NO
          gradient (brand do-not rule, re-audit B1-007). 90% / 10% split. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 6,
          display: "flex",
        }}
      >
        <div style={{ width: "90%", height: "100%", background: BLUE }} />
        <div style={{ width: "10%", height: "100%", background: ACCENT }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
        <SocialMark size={150} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 96,
              fontWeight: 700,
              color: INK,
              letterSpacing: -2,
            }}
          >
            {FAYANMS_BRAND.name}
          </div>
          <div style={{ fontSize: 34, color: MUTED, marginTop: 6 }}>
            {FAYANMS_BRAND.descriptor}
          </div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 18, marginTop: 56 }}>
        {["Multi-vendor Network Management", FAYANMS_BRAND.edition].map(
          (chip) => (
            <div
              key={chip}
              style={{
                display: "flex",
                padding: "10px 26px",
                borderRadius: 10,
                border: `1px solid #CBD5E1`,
                background: FAYANMS_BRAND.colorsNeutral.tile,
                fontSize: 24,
                color: INK,
              }}
            >
              {chip}
            </div>
          )
        )}
      </div>
      <div style={{ fontSize: 24, color: MUTED, marginTop: 30 }}>
        Configuration · Changes · NOC · Performance · Automation
      </div>
    </div>
  );
}
