import type { StatusBadgeConfig, StatusToken } from "@/lib/domain/status";

/**
 * ZTP claim status badges (Phase 14-b) as produced by
 * /api/v1/ztp/claims (persisted status + the running-job overlay).
 * Mirrors the token classes of status.ts without modifying it (same pattern
 * as firmware-band.ts / predictive-band.ts):
 *   pending → neutral | provisioning → info | provisioned → success |
 *   failed → danger.
 * Icons + text always render (never color-only). Labels resolve through
 * useStatusLabel() with the English config.label as fallback; labelKeys
 * point into the "ztp" namespace (ztp.status.*).
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
    labelKey: `ztp.status.${key}`,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/** Claim statuses as returned by the ZTP API (lowercase values). */
export const ZTP_CLAIM_STATUS_UI: Record<string, StatusBadgeConfig> = {
  pending: statusConfig("pending", "Pending", "neutral", "Clock"),
  provisioning: statusConfig("provisioning", "Provisioning", "info", "LoaderCircle"),
  provisioned: statusConfig("provisioned", "Provisioned", "success", "CircleCheck"),
  failed: statusConfig("failed", "Failed", "danger", "OctagonX"),
};

export function ztpClaimBadge(
  status: string | null | undefined
): StatusBadgeConfig {
  return (
    ZTP_CLAIM_STATUS_UI[(status ?? "").toLowerCase()] ??
    statusConfig("unknown", "Unknown", "neutral", "CircleHelp")
  );
}
