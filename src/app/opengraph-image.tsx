import { ImageResponse } from "next/og";
import { FAYANMS_BRAND } from "@/lib/brand/identity";

/**
 * Open Graph social card (1200×630) — Phase B0/§22. Generated at request
 * time from the brand identity; satori needs literal colors (no CSS masks /
 * currentColor), so the mark is inlined. Neutral enterprise surface, brand
 * blue emphasis, no fake vendor logos.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = `${FAYANMS_BRAND.name} — ${FAYANMS_BRAND.descriptor}`;

const BLUE = "#2563EB";
const ACCENT = "#0891B2";
const INK = "#0F172A";
const MUTED = "#475569";
const SURFACE = "#F8FAFC";

export default function OpengraphImage() {
  return new ImageResponse(
    (
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
        {/* subtle topology dot grid, corners */}
        <div
          style={{
            position: "absolute",
            top: 0, left: 0, right: 0, height: 6,
            background: `linear-gradient(90deg, ${BLUE}, ${ACCENT})`,
            display: "flex",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <svg
            width="150"
            height="150"
            viewBox="0 0 24 24"
            fill="none"
            stroke={BLUE}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <circle cx="12" cy="8" r="1.5" />
            <circle cx="8" cy="15" r="1.5" />
            <circle cx="16" cy="15" r="1.5" />
            <line x1="12" y1="9.5" x2="12" y2="12" />
            <line x1="12" y1="12" x2="8.8" y2="13.8" />
            <line x1="12" y1="12" x2="15.2" y2="13.8" />
          </svg>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 96, fontWeight: 700, color: INK, letterSpacing: -2 }}>
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
                  background: "#FFFFFF",
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
    ),
    { ...size }
  );
}
