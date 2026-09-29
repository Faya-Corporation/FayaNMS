import type { BrandIdentity } from "./types";

/**
 * FayaNMS brand identity — SINGLE SOURCE OF TRUTH (Phase B0, BRAND-008;
 * completed in the re-audit remediation BR-C1-007).
 *
 * Every surface (layout metadata, sidebar, sign-in, footer, reports, social
 * cards, raster generation, README tooling) must consume identity from here.
 * No component may construct brand strings by hand — the brand consumer
 * validator (`scripts/validate-brand-consumers.ts`) fails raw literals in
 * identity-composition contexts.
 *
 * Colors intentionally mirror the semantic design tokens in globals.css
 * (`--primary`, `--primary-hover`, `--brand-accent`) — the hex values live
 * here for non-CSS consumers (metadata, SVG masters, OG cards, scripts).
 * In-app components must use the token classes (`text-primary`) instead of
 * these hex values (re-audit B2-018).
 */
export const FAYANMS_BRAND: BrandIdentity = {
  name: "FayaNMS",
  shortName: "FayaNMS",
  descriptor: "Network Operations Management",
  edition: "Enterprise",
  description:
    "Enterprise multi-vendor network operations, configuration, change, incident and performance management.",
  tagline: "One calm pane of glass for your whole network.",
  colors: {
    primary: "#2563EB",
    primaryHover: "#1D4ED8",
    accent: "#0891B2",
  },
  colorsNeutral: {
    ink: "#0F172A",
    muted: "#475569",
    surface: "#F8FAFC",
    tile: "#FFFFFF",
  },
  assets: {
    mark: "/brand/fayanms-mark.svg",
    markBrand: "/brand/fayanms-mark-brand.svg",
    markMicro: "/brand/fayanms-mark-micro.svg",
    markMono: "/brand/fayanms-mark-mono.svg",
    markWhite: "/brand/fayanms-mark-white.svg",
    wordmark: "/brand/fayanms-wordmark.svg",
    wordmarkWhite: "/brand/fayanms-wordmark-white.svg",
    lockup: "/brand/fayanms-lockup-horizontal.svg",
    lockupWhite: "/brand/fayanms-lockup-horizontal-white.svg",
    lockupStacked: "/brand/fayanms-lockup-stacked.svg",
    nocMark: "/brand/fayanms-noc-mark.svg",
    networkShield: "/brand/fayanms-network-shield.svg",
  },
  urls: {
    repository: "https://github.com/Faya-Corporation/FayaNMS",
  },
} as const;

/** Canonical document title ("FayaNMS — Network Operations Management"). */
export const BRAND_TITLE = `${FAYANMS_BRAND.name} — ${FAYANMS_BRAND.descriptor}`;

/** Canonical page-title template ("«page» · FayaNMS"). */
export const BRAND_TITLE_TEMPLATE = `%s · ${FAYANMS_BRAND.name}`;

/** Brand theme color for browser chrome / metadata (hex — non-CSS artifact). */
export const BRAND_THEME_COLOR = FAYANMS_BRAND.colors.primary;

/** Canonical alt text for the product mark on social cards. */
export const BRAND_SOCIAL_ALT = `${FAYANMS_BRAND.name} — ${FAYANMS_BRAND.descriptor}`;

/**
 * Canonical site URL for metadata (`metadataBase`, OG absolutes). Configure
 * via `NEXT_PUBLIC_SITE_URL` in real deployments; the localhost fallback is
 * for development and preview environments only.
 *
 * Re-audit B3-029: silently emitting localhost metadata in production is a
 * branding/SEO defect, so a production build without the variable now fails
 * fast at module load. Localhost is rejected outside development/test.
 */
export function siteUrl(): string {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;

  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL is required in production — set it to the canonical https:// origin so metadataBase/OG URLs are absolute and correct."
      );
    }
    return "http://localhost:3000";
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`NEXT_PUBLIC_SITE_URL is not a valid URL: "${raw}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must be an http(s) URL, got: "${raw}"`
    );
  }
  const isLocal =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "0.0.0.0" ||
    parsed.hostname.endsWith(".local");
  if (isLocal && process.env.NODE_ENV === "production") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must not point at localhost in production (got "${raw}") — deploy with the canonical public origin.`
    );
  }
  return parsed.toString().replace(/\/$/, "");
}
