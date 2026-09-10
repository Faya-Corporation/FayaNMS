import { ImageResponse } from "next/og";

/**
 * Apple touch icon (180×180) — Phase B0/§20: file-based metadata generated
 * at request time (no hand-maintained binaries). Satori cannot use CSS
 * masks or currentColor, so the mark geometry + brand blue are inlined
 * literally here (kept in sync with docs/brand/ASSET-MANIFEST.md).
 */
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const BLUE = "#2563EB";

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
          background: "#FFFFFF",
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
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="8" r="1.5" />
          <circle cx="8" cy="15" r="1.5" />
          <circle cx="16" cy="15" r="1.5" />
          <line x1="12" y1="9.5" x2="12" y2="12" />
          <line x1="12" y1="12" x2="8.8" y2="13.8" />
          <line x1="12" y1="12" x2="15.2" y2="13.8" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
