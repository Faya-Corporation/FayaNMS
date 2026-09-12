/**
 * FayaNMS governed icon registry — lib barrel.
 *
 * Types: FayanmsIconName (all 228 glyphs) + NavIcon (lucide | fayanms union).
 * Mappings: navigation-icons (sidebar view keys), vendor-icons (Device.vendor.key),
 * device-icons (device role/type strings) + device-role-meta (canonical role
 * labels/icons/families).
 */
export type { FayanmsIconName, NavIcon } from "@/lib/icons/types";

export {
  type SidebarViewKey,
  type SidebarNavViewKey,
  NAVIGATION_ICONS,
  navIconFor,
} from "@/lib/icons/navigation-icons";

export {
  GENERIC_VENDOR_ICON,
  VENDOR_ICON,
  VENDOR_LABELS,
  vendorIconFor,
} from "@/lib/icons/vendor-icons";

export {
  GENERIC_DEVICE_ICON,
  deviceIconFor,
  deviceIconLabelFor,
} from "@/lib/icons/device-icons";

export {
  type DeviceRoleCode,
  type DeviceRoleMeta,
  DEVICE_ROLE_META,
  deviceRoleMetaFor,
  deviceRoleLabelFor,
} from "@/lib/icons/device-role-meta";
