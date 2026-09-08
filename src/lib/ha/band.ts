import type { StatusBadgeConfig, StatusToken } from "@/lib/domain/status";

/**
 * HA/DR badges (Phase 14-c) as produced by /api/v1/ha. Mirrors the token
 * classes of status.ts without modifying it (same pattern as
 * predictive-band.ts / firmware-band.ts); the mappings read as a clean
 * green→red escalation:
 *   readiness band: healthy → success | degraded → warning | at-risk → danger
 *   test result:    passed → success   | degraded → warning | never-tested → neutral
 *   pair mode:      active-active → success | active-standby → info
 * Icons + text always render (never color-only). Labels resolve through
 * useStatusLabel() with the English config.label as fallback; labelKeys
 * point into the "ha" namespace (ha.band.* / ha.lastTest.* / ha.mode.*).
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

function haConfig(
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
    labelKey: `ha.${labelPrefix}.${key}`,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/** DR readiness bands as returned by the HA API (lowercase enum values). */
export const HA_READINESS_BAND_UI: Record<string, StatusBadgeConfig> = {
  HEALTHY: haConfig("healthy", "Healthy", "success", "ShieldCheck", "band"),
  DEGRADED: haConfig("degraded", "Degraded", "warning", "TriangleAlert", "band"),
  "AT-RISK": haConfig("at-risk", "At risk", "danger", "OctagonX", "band"),
};

/** Failover-test results as returned by the HA API (lowercase enum values). */
export const HA_TEST_RESULT_UI: Record<string, StatusBadgeConfig> = {
  PASSED: haConfig("passed", "Passed", "success", "CircleCheck", "lastTest"),
  DEGRADED: haConfig("degraded", "Degraded", "warning", "TriangleAlert", "lastTest"),
  "NEVER-TESTED": haConfig("never", "Never tested", "neutral", "CircleHelp", "lastTest"),
};

/** Pair modes as returned by the HA API (lowercase enum values). */
export const HA_MODE_UI: Record<string, StatusBadgeConfig> = {
  "ACTIVE-STANDBY": haConfig(
    "activeStandby",
    "Active / standby",
    "info",
    "ShieldCheck",
    "mode"
  ),
  "ACTIVE-ACTIVE": haConfig(
    "activeActive",
    "Active / active",
    "success",
    "Scale",
    "mode"
  ),
};

function lookup(
  map: Record<string, StatusBadgeConfig>,
  value: string | null | undefined,
  fallback: StatusBadgeConfig
): StatusBadgeConfig {
  if (!value) return fallback;
  return map[value.toUpperCase()] ?? fallback;
}

export function readinessBandBadge(
  band: string | null | undefined
): StatusBadgeConfig {
  return lookup(HA_READINESS_BAND_UI, band, HA_READINESS_BAND_UI.DEGRADED);
}

export function testResultBadge(
  result: string | null | undefined
): StatusBadgeConfig {
  return lookup(HA_TEST_RESULT_UI, result, HA_TEST_RESULT_UI["NEVER-TESTED"]);
}

export function pairModeBadge(
  mode: string | null | undefined
): StatusBadgeConfig {
  return lookup(HA_MODE_UI, mode, HA_MODE_UI["ACTIVE-STANDBY"]);
}
