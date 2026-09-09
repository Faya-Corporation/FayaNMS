"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StatusBadgeConfig } from "@/lib/domain/status";
import { useStatusLabel } from "@/hooks/use-status-label";
import { StatusIcon } from "./status-icon";

interface StatusBadgeProps {
  config: StatusBadgeConfig;
  className?: string;
  /** Hide the icon when space is tight; label is always rendered. */
  withIcon?: boolean;
}

/**
 * Shared badge renderer for every domain status: subtle token background,
 * token-colored icon + label. Never color-only — icon and text are always
 * present by default.
 *
 * The label is resolved through useStatusLabel() so every surface rendering
 * through this badge (including the DeviceStatusBadge / BackupStatusBadge /
 * ChangeStatusBadge / DriftStatusBadge / JobStatusBadge / SeverityBadge /
 * ChangeRiskBadge wrappers, which all delegate here) localizes with zero
 * per-view changes; the English config.label is the fallback.
 */
export function StatusBadge({
  config,
  className,
  withIcon = true,
}: StatusBadgeProps) {
  const resolveLabel = useStatusLabel();
  const label = resolveLabel(config);
  return (
    <Badge
      className={cn(config.badgeClass, "gap-1", className)}
      title={label}
      variant="outline"
    >
      {withIcon && (
        <StatusIcon className={cn("size-3", config.iconClass)} icon={config.icon} />
      )}
      <span className="max-w-[24ch] truncate">{label}</span>
    </Badge>
  );
}
