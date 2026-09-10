import type { BrandIdentity } from "./types";

/**
 * FayaNMS brand identity — SINGLE SOURCE OF TRUTH (Phase B0, BRAND-008).
 *
 * Every surface (layout metadata, sidebar, sign-in, footer, reports, future
 * email templates, README tooling) must consume identity from here. No
 * component may construct brand strings by hand.
 *
 * Colors intentionally mirror the semantic design tokens in globals.css
 * (`--primary`, `--primary-hover`, `--brand-accent`) — the hex values live
 * here for non-CSS consumers (metadata, SVG masters, OG cards, scripts).
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
  assets: {
    mark: "/brand/fayanms-mark.svg",
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
    repository: "https://github.com/fayafatehi/FayaNMS",
  },
} as const;

/**
 * Canonical site URL for metadata (`metadataBase`, OG absolutes). Configure
 * via `NEXT_PUBLIC_SITE_URL` in real deployments; the localhost fallback is
 * for development and preview environments.
 */
export function siteUrl(): string {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}
