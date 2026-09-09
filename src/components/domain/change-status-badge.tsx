import { CHANGE_STATUS, getStatusConfig } from "@/lib/domain/status";
import { StatusBadge } from "./status-badge";

export function ChangeStatusBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge
      className={className}
      config={getStatusConfig(CHANGE_STATUS, value)}
    />
  );
}
