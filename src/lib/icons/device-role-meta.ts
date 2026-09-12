/**
 * Canonical device-role metadata (re-audit B1-012 / §12 — Device Role Metadata
 * Refactor). ONE source binding every known `Device.role` code to:
 *  - `label`   — English human label for a11y naming and non-localized contexts
 *                (visible UI text may still come from next-intl, which stays
 *                authoritative for translated surfaces);
 *  - `icon`    — the governed FayaNMS glyph (an existing master — no invented
 *                semantics, no new SVG files);
 *  - `family`  — the governance family used by the substring fallback in
 *                `device-icons.ts` (router | switch | security | compute |
 *                wireless | virtual | generic).
 *
 * Real role codes (prisma/schema.prisma comment + seed + alert-rule options +
 * messages): CORE_ROUTER, EDGE_ROUTER, BRANCH_ROUTER, FIREWALL, CORE_SWITCH,
 * ACCESS_SWITCH, TOP_OF_RACK, WIRELESS_CONTROLLER, LOAD_BALANCER, WAN_GATEWAY.
 * The remaining entries cover the free-form type strings resolved by the
 * substring families (SERVER/APPLIANCE/CLOUD/VIRTUAL) plus the GENERIC
 * fallback. Future v3 glyph work (dedicated device-wireless-controller /
 * device-load-balancer / device-wan-gateway masters) is deliberately NOT
 * invented here — see re-audit B1-012 "Better v3 extension".
 */
import type { FayanmsIconName } from "@/lib/icons/types";

export const DEVICE_ROLE_META = {
  CORE_ROUTER:         { label: "Core router",         icon: "device-router",   family: "router" },
  EDGE_ROUTER:         { label: "Edge router",         icon: "device-router",   family: "router" },
  BRANCH_ROUTER:       { label: "Branch router",       icon: "device-router",   family: "router" },
  WAN_GATEWAY:         { label: "WAN gateway",         icon: "device-router",   family: "router" },
  FIREWALL:            { label: "Firewall",            icon: "device-firewall", family: "security" },
  CORE_SWITCH:         { label: "Core switch",         icon: "device-switch",   family: "switch" },
  ACCESS_SWITCH:       { label: "Access switch",       icon: "device-switch",   family: "switch" },
  TOP_OF_RACK:         { label: "Top of rack",         icon: "device-switch",   family: "switch" },
  LOAD_BALANCER:       { label: "Load balancer",       icon: "device-server",   family: "compute" },
  WIRELESS_CONTROLLER: { label: "Wireless controller", icon: "device-server",   family: "wireless" },
  SERVER:              { label: "Server",              icon: "device-server",   family: "compute" },
  APPLIANCE:           { label: "Appliance",           icon: "device-server",   family: "compute" },
  CLOUD:               { label: "Cloud node",          icon: "device-cloud",    family: "virtual" },
  VIRTUAL:             { label: "Virtual machine",     icon: "device-cloud",    family: "virtual" },
  GENERIC:             { label: "Device",              icon: "device-generic",  family: "generic" },
} as const;

export type DeviceRoleCode = keyof typeof DEVICE_ROLE_META;

/** Resolved metadata shape (widened from the literal table). */
export interface DeviceRoleMeta {
  label: string;
  icon: FayanmsIconName;
  family: string;
}

/**
 * Resolve a device role/type string to its canonical metadata. Lookup is an
 * exact match on the trimmed, upper-cased code (role codes are stored
 * upper-case); unknown/empty input falls back to the GENERIC entry.
 */
export function deviceRoleMetaFor(type: string | null | undefined): DeviceRoleMeta {
  const key = (type ?? "").trim().toUpperCase();
  const meta = (DEVICE_ROLE_META as Readonly<Record<string, DeviceRoleMeta>>)[key];
  return meta ?? DEVICE_ROLE_META.GENERIC;
}

/**
 * Human label for a device role/type (exact code match, else the GENERIC
 * label "Device"). Used for standalone a11y naming and non-localized contexts.
 */
export function deviceRoleLabelFor(type: string | null | undefined): string {
  return deviceRoleMetaFor(type).label;
}
