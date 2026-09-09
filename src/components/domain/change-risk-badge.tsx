import { getStatusConfig, RISK_LEVEL } from "@/lib/domain/status";
import { StatusBadge } from "./status-badge";

export function ChangeRiskBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge
      className={className}
      config={getStatusConfig(RISK_LEVEL, value)}
    />
  );
}
