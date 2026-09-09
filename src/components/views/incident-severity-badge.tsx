import { StatusBadge } from "@/components/domain/status-badge";
import { INCIDENT_SEVERITY, getStatusConfig } from "@/lib/domain/status";

/**
 * Incident severity badge (SEV1–SEV4) via the INCIDENT_SEVERITY map —
 * the shared SeverityBadge covers the generic Critical..Info scale, while
 * incidents carry SEV labels.
 */
export function IncidentSeverityBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge
      className={className}
      config={getStatusConfig(INCIDENT_SEVERITY, value)}
    />
  );
}
