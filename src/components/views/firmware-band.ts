import type { StatusBadgeConfig, StatusToken } from "@/lib/domain/status";
import type { FirmwareLifecycleStatus } from "@/lib/api-client";

/**
 * Firmware lifecycle badges (Phase 13-b) as produced by
 * /api/v1/firmware (static vendor matrix — documented simulated vendor
 * data). Mirrors the token classes of status.ts without modifying it
 * (same pattern as predictive-band.ts); the status→token mapping follows
 * the task's badge contract:
 *   current → success | aging → info | eos → warning | eol → danger.
 * Icons + text always render (never color-only). Labels resolve through
 * useStatusLabel() with the English config.label as fallback; labelKeys
 * point into the "firmware" namespace (firmware.status.*).
 */

const TOKEN_CLASSES: Record<
  StatusToken,
  { dot: string; badge: string; icon: string }
> = {
  success: {
    dot: "bg-success",
    badge: "bg-success-subtle text-success border-success/25",
    icon: "text-success",
  },
  warning: {
    dot: "bg-warning",
    badge: "bg-warning-subtle text-warning border-warning/25",
    icon: "text-warning",
  },
  danger: {
    dot: "bg-danger",
    badge: "bg-danger-subtle text-danger border-danger/25",
    icon: "text-danger",
  },
  "danger-orange": {
    dot: "bg-danger-orange",
    badge: "bg-danger-orange-subtle text-danger-orange border-danger-orange/25",
    icon: "text-danger-orange",
  },
  info: {
    dot: "bg-info",
    badge: "bg-info-subtle text-info border-info/25",
    icon: "text-info",
  },
  neutral: {
    dot: "bg-neutral",
    badge: "bg-neutral-subtle text-neutral border-neutral/25",
    icon: "text-neutral",
  },
};

function statusConfig(
  key: string,
  label: string,
  token: StatusToken,
  icon: string
): StatusBadgeConfig {
  const classes = TOKEN_CLASSES[token];
  return {
    key,
    label,
    labelKey: `firmware.status.${key}`,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/** Lifecycle statuses as returned by the firmware API (lowercase values). */
export const LIFECYCLE_STATUS_UI: Record<string, StatusBadgeConfig> = {
  CURRENT: statusConfig("current", "Current", "success", "CircleCheck"),
  AGING: statusConfig("aging", "Aging", "info", "Clock"),
  EOS: statusConfig("eos", "End of sale", "warning", "TriangleAlert"),
  EOL: statusConfig("eol", "End of life", "danger", "OctagonX"),
};

/** Neutral config for devices with no lifecycle data (unknown vendor). */
export const LIFECYCLE_UNKNOWN_UI: StatusBadgeConfig = {
  key: "unknown",
  label: "No data",
  labelKey: "firmware.status.unknown",
  token: "neutral",
  icon: "CircleHelp",
  dotClass: TOKEN_CLASSES.neutral.dot,
  badgeClass: TOKEN_CLASSES.neutral.badge,
  iconClass: TOKEN_CLASSES.neutral.icon,
};

export function lifecycleBadge(
  status: FirmwareLifecycleStatus | null | undefined
): StatusBadgeConfig {
  if (!status) return LIFECYCLE_UNKNOWN_UI;
  return LIFECYCLE_STATUS_UI[status.toUpperCase()] ?? LIFECYCLE_UNKNOWN_UI;
}
