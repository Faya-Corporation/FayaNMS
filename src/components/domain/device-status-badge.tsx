import { DEVICE_STATUS, getStatusConfig } from "@/lib/domain/status";
import { StatusBadge } from "./status-badge";

export function DeviceStatusBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge
      className={className}
      config={getStatusConfig(DEVICE_STATUS, value)}
    />
  );
}
