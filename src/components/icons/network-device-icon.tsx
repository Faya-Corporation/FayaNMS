import { FayanmsIcon } from "@/components/icons/fayanms-icon";
import { deviceIconFor } from "@/lib/icons/device-icons";
import { cn } from "@/lib/utils";

export interface NetworkDeviceIconProps {
  /** Device role/type string (e.g. Device.role "CORE_ROUTER") — generic fallback. */
  deviceType: string | null | undefined;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | number;
  className?: string;
  /** Standalone mode gives the glyph an accessible name; default decorative. */
  standalone?: boolean;
}

/**
 * Device-type glyph rendered before hostnames / device titles. Decorative by
 * default — the hostname or role label adjacent to it carries the semantics.
 */
export function NetworkDeviceIcon({
  deviceType,
  size = "md",
  className,
  standalone = false,
}: NetworkDeviceIconProps) {
  return (
    <FayanmsIcon
      className={cn(className)}
      name={deviceIconFor(deviceType)}
      size={size}
      title={standalone ? "Device type glyph" : undefined}
    />
  );
}
