import type { MetadataRoute } from "next";
import { FAYANMS_BRAND } from "@/lib/brand/identity";

/**
 * Web app manifest (Phase B0, plan §21). Brand/theme colors come from the
 * brand identity — semantic status colors are never used here.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${FAYANMS_BRAND.name} — ${FAYANMS_BRAND.descriptor}`,
    short_name: FAYANMS_BRAND.shortName,
    description: FAYANMS_BRAND.description,
    start_url: "/",
    display: "standalone",
    background_color: FAYANMS_BRAND.colorsNeutral.tile,
    theme_color: FAYANMS_BRAND.colors.primary,
    icons: [
      {
        src: "/brand/app-icon-192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/brand/app-icon-512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/brand/app-icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/brand/app-icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
