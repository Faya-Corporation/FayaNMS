/**
 * FayaNMS governed icon registry — lib barrel.
 *
 * Types: FayanmsIconName (all 228 glyphs) + NavIcon (lucide | fayanms union).
 * Mappings: navigation-icons (sidebar view keys), vendor-icons (Device.vendor.key),
 * device-icons (device role/type strings).
 */
export type { FayanmsIconName, NavIcon } from "@/lib/icons/types";

export {
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
} from "@/lib/icons/device-icons";
