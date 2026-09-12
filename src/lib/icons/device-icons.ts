/**
 * Governed device-type glyph mapping (Phase B1 + re-audit B1-012/B2-020).
 *
 * Resolution order:
 *  1. exact normalized role-code match against DEVICE_ROLE_META
 *     (src/lib/icons/device-role-meta.ts — the canonical role source), so
 *     known composite codes like TOP_OF_RACK, WAN_GATEWAY,
 *     WIRELESS_CONTROLLER and LOAD_BALANCER keep their product semantics;
 *  2. case-insensitive substring families for free-form type strings
 *     (firewall / router / switch / server+appliance / cloud+virtual);
 *  3. the generic device glyph — never an invented one.
 *
 * `deviceIconLabelFor` exposes the matching human label ("Core router",
 * "Top of rack", "Router", …) for standalone a11y naming (B2-020).
 */
import type { FayanmsIconName } from "@/lib/icons/types";
import { DEVICE_ROLE_META, deviceRoleMetaFor } from "@/lib/icons/device-role-meta";

/** Fallback for unknown/empty device types. */
export const GENERIC_DEVICE_ICON: FayanmsIconName = "device-generic";

/**
 * Resolve a device type/role string to its governed glyph. Exact role-code
 * metadata wins; free-form strings fall through to substring matching —
 * firewall is checked first so a hypothetical "firewall-router" composite
 * resolves to the security glyph.
 */
export function deviceIconFor(type: string | null | undefined): FayanmsIconName {
  const normalized = (type ?? "").trim();
  if (!normalized) return GENERIC_DEVICE_ICON;

  const meta = deviceRoleMetaFor(normalized);
  if (meta !== DEVICE_ROLE_META.GENERIC) return meta.icon;

  const lower = normalized.toLowerCase();
  if (lower.includes("firewall")) return "device-firewall";
  if (lower.includes("router")) return "device-router";
  if (lower.includes("switch")) return "device-switch";
  if (lower.includes("server") || lower.includes("appliance")) {
    return "device-server";
  }
  if (lower.includes("cloud") || lower.includes("virtual")) {
    return "device-cloud";
  }
  return GENERIC_DEVICE_ICON;
}

/**
 * Human label for a device type/role: the canonical role label for known
 * codes ("Core router", "Top of rack", …), else the substring family name,
 * else the generic "Device". Used for standalone accessible names.
 */
export function deviceIconLabelFor(type: string | null | undefined): string {
  const normalized = (type ?? "").trim();
  if (!normalized) return DEVICE_ROLE_META.GENERIC.label;

  const meta = deviceRoleMetaFor(normalized);
  if (meta !== DEVICE_ROLE_META.GENERIC) return meta.label;

  const lower = normalized.toLowerCase();
  if (lower.includes("firewall")) return "Firewall";
  if (lower.includes("router")) return "Router";
  if (lower.includes("switch")) return "Switch";
  if (lower.includes("server") || lower.includes("appliance")) return "Server";
  if (lower.includes("cloud") || lower.includes("virtual")) return "Cloud node";
  return DEVICE_ROLE_META.GENERIC.label;
}
