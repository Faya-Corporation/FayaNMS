import {
  BACKUP_COMPLIANCE,
  BACKUP_STATUS,
  getStatusConfig,
} from "@/lib/domain/status";
import { StatusBadge } from "./status-badge";

/** Outcome of an individual backup run. */
export function BackupStatusBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge
      className={className}
      config={getStatusConfig(BACKUP_STATUS, value)}
    />
  );
}

/** Per-device backup compliance rollup. */
export function BackupComplianceBadge({
  value,
  className,
}: {
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <StatusBadge
      className={className}
      config={getStatusConfig(BACKUP_COMPLIANCE, value)}
    />
  );
}
