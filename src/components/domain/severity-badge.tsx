import { SEVERITY, getStatusConfig } from "@/lib/domain/status";
import { StatusBadge } from "./status-badge";

export function SeverityBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge className={className} config={getStatusConfig(SEVERITY, value)} />
  );
}
