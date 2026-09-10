/**
 * Governed device-type glyph mapping (Phase B1).
 *
 * Matches against free-form device role/type strings (e.g. Device.role:
 * CORE_ROUTER, ACCESS_SWITCH, FIREWALL, …) with case-insensitive substring
 * matching, because the platform stores composite role codes. Per the icon
 * governance table the recognized families are router / switch / firewall /
 * server+appliance / cloud+virtual; everything else — including composite
 * roles like TOP_OF_RACK, WAN_GATEWAY and WIRELESS_CONTROLLER — deliberately
 * falls back to the generic device glyph (no invented semantics).
 */
import type { FayanmsIconName } from "@/lib/icons/types";

/** Fallback for unknown/empty device types. */
export const GENERIC_DEVICE_ICON: FayanmsIconName = "device-generic";

/**
 * Resolve a device type/role string to its governed glyph. Order matters:
 * firewall is checked first so a hypothetical "firewall-router" composite
 * resolves to the security glyph.
 */
export function deviceIconFor(type: string | null | undefined): FayanmsIconName {
  const normalized = (type ?? "").trim().toLowerCase();
  if (!normalized) return GENERIC_DEVICE_ICON;

  if (normalized.includes("firewall")) return "device-firewall";
  if (normalized.includes("router")) return "device-router";
  if (normalized.includes("switch")) return "device-switch";
  if (normalized.includes("server") || normalized.includes("appliance")) {
    return "device-server";
  }
  if (normalized.includes("cloud") || normalized.includes("virtual")) {
    return "device-cloud";
  }
  return GENERIC_DEVICE_ICON;
}
