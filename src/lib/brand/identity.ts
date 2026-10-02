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
 * Canonical site URL: moved to `./site-url` (F-026, batch 9) — the origin is
 * a SERVER-RUNTIME concern (`SITE_URL`, evaluated per request by the root
 * layout's generateMetadata) and must NOT live in this module: identity.ts is
 * imported by client components, and a `NEXT_PUBLIC_*` read here caused
 * Next.js to inline the build-time value into every client bundle (the exact
 * mechanism that froze `https://fayanms.invalid` into the published GHCR
 * images). Client imports of identity are now origin-free by construction.
 */
