import type { StatusBadgeConfig, StatusToken } from "@/lib/domain/status";

/**
 * Predictive-health risk bands (Phase 12-c) as produced by
 * /api/v1/predictive (formula "v1"): critical ≥ 70 · high ≥ 45 ·
 * moderate ≥ 25 · else low. Mirrors the token classes of status.ts without
 * modifying it (same pattern as status-extras.ts); the band→token mapping
 * intentionally deviates from the SEVERITY family so the four risk bands
 * read as a clean green→red escalation:
 *   critical → danger | high → warning | moderate → info | low → success.
 * Icons + text always render (never color-only). Labels resolve through
 * useStatusLabel() with the English config.label as fallback; labelKeys
 * point into the "predictive" namespace (predictive.band.*).
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

function bandConfig(
  key: string,
  label: string,
  token: StatusToken,
  icon: string
): StatusBadgeConfig {
  const classes = TOKEN_CLASSES[token];
  return {
    key,
    label,
    labelKey: `predictive.band.${key}`,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/** Risk bands as returned by the predictive API (lowercase enum values). */
export const RISK_BAND_UI: Record<string, StatusBadgeConfig> = {
  CRITICAL: bandConfig("CRITICAL", "Critical", "danger", "OctagonX"),
  HIGH: bandConfig("HIGH", "High", "warning", "TriangleAlert"),
  MODERATE: bandConfig("MODERATE", "Moderate", "info", "CircleAlert"),
  LOW: bandConfig("LOW", "Low", "success", "CircleCheck"),
};
