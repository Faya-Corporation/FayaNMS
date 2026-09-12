/**
 * Brand architecture types (Phase B0 — BRAND-008).
 *
 * The brand layer is deliberately tiny and dependency-free: every surface
 * (metadata, sidebar, sign-in, footer, reports, README tooling) must read
 * identity from `src/lib/brand/identity.ts` instead of hardcoding strings.
 */

export type BrandTone = "brand" | "current" | "white" | "mono";

export interface BrandColors {
  /** Primary brand blue — marks, CTAs, active navigation. */
  primary: string;
  /** Primary hover state. */
  primaryHover: string;
  /** Accent cyan — focus, links, chart secondary emphasis. Used sparingly. */
  accent: string;
}

export interface BrandAssetPaths {
  mark: string;
  /** Static brand-primary mark for external contexts (README, email, docs) —
   * `<img>`-loaded SVGs cannot inherit page currentColor (re-audit B1-013). */
  markBrand: string;
  /** 16–20px optimized favicon micro-mark (re-audit B1-014). */
  markMicro: string;
  markMono: string;
  markWhite: string;
  wordmark: string;
  wordmarkWhite: string;
  lockup: string;
  lockupWhite: string;
  lockupStacked: string;
  nocMark: string;
  networkShield: string;
}

export interface BrandIdentity {
  /** Official product name. */
  name: string;
  /** Compact name for tight surfaces (manifest short_name, badges). */
  shortName: string;
  /** Product descriptor shown beside the wordmark. */
  descriptor: string;
  /** Edition context — a badge/subtitle, never part of the geometric mark. */
  edition: string;
  /** Long-form description for metadata / OG cards. */
  description: string;
  /** Optional marketing tagline (unused in app chrome by default). */
  tagline: string;
  colors: BrandColors;
  /** Neutral artboard/background color for generated artwork (OG cards,
   * favicon tiles, social preview). Not a status color. */
  colorsNeutral: {
    /** Ink (headline text on light artwork). */
    ink: string;
    /** Muted (supporting text on light artwork). */
    muted: string;
    /** Light artboard surface. */
    surface: string;
    /** White tile background (favicon/app icon tiles). */
    tile: string;
  };
  assets: BrandAssetPaths;
  urls: {
    repository: string;
    /** Documentation URL — intentionally empty until a real docs site exists. */
    documentation?: string;
    /** Support URL — intentionally empty until a real support channel exists. */
    support?: string;
  };
}
