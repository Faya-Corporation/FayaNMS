import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { StatusBadgeConfig } from "@/lib/domain/status";
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
 */
export function StatusBadge({
  config,
  className,
  withIcon = true,
}: StatusBadgeProps) {
  return (
    <Badge
      className={cn(config.badgeClass, "gap-1", className)}
      title={config.label}
      variant="outline"
    >
      {withIcon && (
        <StatusIcon className={cn("size-3", config.iconClass)} icon={config.icon} />
      )}
      <span className="max-w-[24ch] truncate">{config.label}</span>
    </Badge>
  );
}
