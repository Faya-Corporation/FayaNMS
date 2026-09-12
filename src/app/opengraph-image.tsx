import { ImageResponse } from "next/og";
import { BRAND_SOCIAL_ALT } from "@/lib/brand/identity";
import { SocialCard } from "@/components/brand/social-card";

/**
 * Open Graph social card (1200×630) — generated at request time from the
 * shared brand composition (re-audit B1-006/B2-024: one SocialCard, no
 * duplicated geometry/colors/layout) and the brand identity.
 */
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = BRAND_SOCIAL_ALT;

export default function OpengraphImage() {
  return new ImageResponse(<SocialCard />, { ...size });
}
