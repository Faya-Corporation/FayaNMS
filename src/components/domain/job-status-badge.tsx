import { getStatusConfig, JOB_STATUS } from "@/lib/domain/status";
import { StatusBadge } from "./status-badge";

export function JobStatusBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge
      className={className}
      config={getStatusConfig(JOB_STATUS, value)}
    />
  );
}
