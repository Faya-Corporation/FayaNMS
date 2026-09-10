import { FayanmsIcon } from "@/components/icons/fayanms-icon";
import { VENDOR_LABELS, vendorIconFor } from "@/lib/icons/vendor-icons";
import { cn } from "@/lib/utils";

export interface DeviceVendorIconProps {
  /** Canonical vendor code (Device.vendor.key) — unknown/missing → generic. */
  vendor: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | number;
  className?: string;
  /**
   * Standalone mode: the glyph names itself ("«VendorLabel» adapter glyph")
   * for contexts where no adjacent text labels it. Default is decorative
   * (aria-hidden) since vendor text labels the icon in tables/cards.
   */
  standalone?: boolean;
}

/**
 * Vendor adapter glyph for a device/driver row. Decorative by default —
 * vendor and model text always sits adjacent (a11y rule: don't duplicate).
 */
export function DeviceVendorIcon({
  vendor,
  size = "sm",
  className,
  standalone = false,
}: DeviceVendorIconProps) {
  const name = vendorIconFor(vendor);
  return (
    <FayanmsIcon
      className={className}
      name={name}
      size={size}
      title={standalone ? `${VENDOR_LABELS[name] ?? "Unknown vendor"} adapter glyph` : undefined}
    />
  );
}
