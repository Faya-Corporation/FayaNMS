import type { StatusBadgeConfig, StatusToken } from "@/lib/domain/status";

/**
 * CMDB badges (Phase 15-a) as produced by /api/v1/cmdb. Mirrors the token
 * classes of status.ts without modifying it (same pattern as ha/band.ts,
 * predictive-band.ts and firmware-band.ts):
 *   status:       active → success | planned → info | maintenance → warning
 *                 | retired → neutral
 *   criticality:  critical → danger | high → danger-orange | medium →
 *                 warning | low → info   (severity mapping identical to the
 *                 platform-wide convention in status.ts)
 *   environment:  production → info | staging → warning | lab → neutral
 * Icons + text always render (never color-only). Labels resolve through
 * useStatusLabel() with the English config.label as fallback; labelKeys
 * point into the "cmdb" namespace (cmdb.status.* / cmdb.criticality.* /
 * cmdb.environment.*).
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

function cmdbConfig(
  key: string,
  label: string,
  token: StatusToken,
  icon: string,
  labelPrefix: string
): StatusBadgeConfig {
  const classes = TOKEN_CLASSES[token];
  return {
    key,
    label,
    labelKey: `cmdb.${labelPrefix}.${key}`,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/** CI lifecycle status as returned by the API (lowercase enum values). */
export const CMDB_STATUS_UI: Record<string, StatusBadgeConfig> = {
  ACTIVE: cmdbConfig("active", "Active", "success", "ShieldCheck", "status"),
  PLANNED: cmdbConfig("planned", "Planned", "info", "Clock", "status"),
  MAINTENANCE: cmdbConfig("maintenance", "Maintenance", "warning", "Wrench", "status"),
  RETIRED: cmdbConfig("retired", "Retired", "neutral", "Archive", "status"),
};

/**
 * CI criticality — the platform-wide severity mapping (status.ts):
 * Critical → danger, High → danger-orange, Medium → warning, Low → info.
 */
export const CMDB_CRITICALITY_UI: Record<string, StatusBadgeConfig> = {
  CRITICAL: cmdbConfig("critical", "Critical", "danger", "OctagonX", "criticality"),
  HIGH: cmdbConfig("high", "High", "danger-orange", "TriangleAlert", "criticality"),
  MEDIUM: cmdbConfig("medium", "Medium", "warning", "CircleAlert", "criticality"),
  LOW: cmdbConfig("low", "Low", "info", "CircleMinus", "criticality"),
};

/** CI environment (deployment scope). */
export const CMDB_ENVIRONMENT_UI: Record<string, StatusBadgeConfig> = {
  PRODUCTION: cmdbConfig("production", "Production", "info", "Info", "environment"),
  STAGING: cmdbConfig("staging", "Staging", "warning", "CircleDashed", "environment"),
  LAB: cmdbConfig("lab", "Lab", "neutral", "CircleSlash", "environment"),
};

function lookup(
  map: Record<string, StatusBadgeConfig>,
  value: string | null | undefined,
  fallback: StatusBadgeConfig
): StatusBadgeConfig {
  if (!value) return fallback;
  return map[value.toUpperCase()] ?? fallback;
}

export function cmdbStatusBadge(
  status: string | null | undefined
): StatusBadgeConfig {
  return lookup(CMDB_STATUS_UI, status, CMDB_STATUS_UI.ACTIVE);
}

export function cmdbCriticalityBadge(
  criticality: string | null | undefined
): StatusBadgeConfig {
  return lookup(CMDB_CRITICALITY_UI, criticality, CMDB_CRITICALITY_UI.MEDIUM);
}

export function cmdbEnvironmentBadge(
  environment: string | null | undefined
): StatusBadgeConfig {
  return lookup(CMDB_ENVIRONMENT_UI, environment, CMDB_ENVIRONMENT_UI.PRODUCTION);
}
