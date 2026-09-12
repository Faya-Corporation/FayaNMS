/**
 * Governed vendor glyph mapping (Phase B1).
 *
 * Vendor keys are the canonical `Device.vendor.key` codes (see the worker
 * adapter contract: cisco|fortinet|sophos|hpe|juniper|palo|generic). Unknown
 * or missing keys fall back to the generic vendor glyph — never a broken
 * image, never a layout shift.
 */
import type { FayanmsIconName } from "@/lib/icons/types";

export const VENDOR_ICON: Record<string, FayanmsIconName> = {
  cisco: "vendor-cisco",
  fortinet: "vendor-fortigate",
  sophos: "vendor-sophos",
  hpe: "vendor-hpe",
  juniper: "vendor-juniper",
  palo: "vendor-palo-alto",
  generic: "vendor-generic",
};

/** Human-readable vendor labels (used for standalone titles/tooltips). */
export const VENDOR_LABELS: Record<string, string> = {
  "vendor-cisco": "Cisco",
  "vendor-fortigate": "Fortinet",
  "vendor-sophos": "Sophos",
  "vendor-hpe": "HPE",
  "vendor-juniper": "Juniper Networks",
  "vendor-palo-alto": "Palo Alto Networks",
  "vendor-generic": "Generic",
};

/** Fallback for unknown/missing vendor keys — mirrors the generic adapter. */
export const GENERIC_VENDOR_ICON: FayanmsIconName = "vendor-generic";

/**
 * Resolve a vendor code to its governed glyph. Matching is case-insensitive
 * and trims whitespace so raw API/CSV values resolve the same as seeded keys.
 */
export function vendorIconFor(key: string | null | undefined): FayanmsIconName {
  if (!key) return GENERIC_VENDOR_ICON;
  const normalized = key.trim().toLowerCase();
  return VENDOR_ICON[normalized] ?? GENERIC_VENDOR_ICON;
}
