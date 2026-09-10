import { ImageResponse } from "next/og";
import { FAYANMS_BRAND } from "@/lib/brand/identity";
import { MARK_GEOMETRY } from "@/lib/brand/mark-geometry";

/**
 * Apple touch icon (180×180) — file-based metadata generated at request
 * time (no hand-maintained binaries). Geometry comes from the shared mark
 * module (re-audit B1-006: no per-file inlined mark); the paint is the
 * literal brand primary because satori cannot use currentColor.
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const BLUE = FAYANMS_BRAND.colors.primary;

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: FAYANMS_BRAND.colorsNeutral.tile,
        }}
      >
        <svg
          width="132"
          height="132"
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
      </div>
    ),
    { ...size }
  );
}
