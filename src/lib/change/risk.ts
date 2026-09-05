/**
 * FayaNMS — Change risk scoring engine (Task 4-a).
 *
 * PURE module — zero dependencies, safe to import from both client
 * components (wizard live preview) and API routes (authoritative score).
 * Client and server MUST agree because they share this exact file.
 *
 * Transparent factor model: every point comes from a documented factor row
 * so the wizard can render the full breakdown (never a black box).
 *
 * Factor table (cumulative, clamped 0–100):
 *   1. Base by change type .......... STANDARD 5 · NORMAL 15 · EMERGENCY 30
 *   2. CRITICAL devices ............. +8 per CRITICAL device (cap 24)
 *   3. Fleet size ................... +4 per additional device beyond the
 *                                     first (cap 12)
 *   4. Firewall exposure ............ +10 when the change touches any
 *                                     firewall (see affectsFirewall hints)
 *   5. Multi-site blast radius ...... +6 when devices span >1 site
 *   6. No rollback plan ............. +15 (rollback is the safety net)
 *   7. No validation plan ........... +8 (post-change verification)
 *   8. Business-hours window ........ +12 when scheduled inside Sun–Thu
 *                                     08:00–17:00 (user population awake;
 *                                     deliberately naive hour-range check —
 *                                     no tz library in the sandbox)
 *
 * Level thresholds (mirrors riskLevelFor in the restore route and the
 * RISK_LEVEL map in src/lib/domain/status.ts):
 *   LOW <21 · MEDIUM <41 · HIGH <71 · CRITICAL ≥71
 */

export type ChangeType = "STANDARD" | "NORMAL" | "EMERGENCY";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface RiskInput {
  /** Criticality values of the targeted devices (e.g. "CRITICAL"). */
  deviceCriticalities: string[];
  /** Total number of targeted devices (1–20). */
  deviceCount: number;
  type: ChangeType;
  /** Number of distinct sites spanned by the targeted devices. */
  siteCount: number;
  hasRollbackPlan: boolean;
  hasValidationPlan: boolean;
  /** Scheduled inside business hours (Sun–Thu 08:00–17:00). */
  scheduledBusinessHours: boolean;
  /**
   * Firewall exposure — the CALLER derives this from device attributes
   * (hostname/model/role/vendor) using deviceAffectsFirewall() below.
   */
  affectsFirewall: boolean;
}

export interface RiskFactor {
  key: string;
  label: string;
  points: number;
  /** Human explanation rendered in the wizard's risk breakdown. */
  detail: string;
}

export interface RiskBreakdown {
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
}

/** Level banding — the ONLY place these thresholds live. */
export function riskLevelFor(score: number): RiskLevel {
  if (score >= 71) return "CRITICAL";
  if (score >= 41) return "HIGH";
  if (score >= 21) return "MEDIUM";
  return "LOW";
}

/**
 * Firewall exposure heuristic. Caller passes the device attributes it has
 * (hostname/model are the primary hints; role/vendorKey when joined).
 * Deliberately broad "fw" substring match — documented, deterministic.
 */
export function deviceAffectsFirewall(device: {
  hostname?: string | null;
  model?: string | null;
  role?: string | null;
  vendorKey?: string | null;
}): boolean {
  if (device.role === "FIREWALL") return true;
  const haystack = `${device.hostname ?? ""} ${device.model ?? ""} ${
    device.vendorKey ?? ""
  }`.toLowerCase();
  return (
    haystack.includes("fw") ||
    haystack.includes("fortigate") ||
    haystack.includes("fortios") ||
    haystack.includes("sophos") ||
    haystack.includes("sfos") ||
    haystack.includes("xgs")
  );
}

/**
 * Business-hours test — Sun–Thu 08:00–16:59 local server time. Naive
 * hour-range check on purpose (no tz lib); good enough for advisory
 * scheduling guidance and deterministic on both sides.
 */
export function isBusinessHours(date: Date): boolean {
  const day = date.getDay(); // 0 = Sunday … 6 = Saturday
  const hour = date.getHours();
  // Sun(0)–Thu(4) working week (Gulf region convention).
  const workday = day >= 0 && day <= 4;
  return workday && hour >= 8 && hour < 17;
}

/** Deterministic, pure scoring — same inputs always yield the same rows. */
export function scoreChangeRisk(input: RiskInput): RiskBreakdown {
  const factors: RiskFactor[] = [];

  // 1. Base by change type.
  const baseByType: Record<ChangeType, number> = {
    STANDARD: 5,
    NORMAL: 15,
    EMERGENCY: 30,
  };
  const base = baseByType[input.type] ?? 15;
  factors.push({
    key: "type",
    label: "Change type",
    points: base,
    detail: `${input.type} change baseline`,
  });

  // 2. CRITICAL device exposure (capped so a fleet of criticals cannot
  //    drown every other signal).
  const criticalCount = input.deviceCriticalities.filter(
    (c) => c === "CRITICAL"
  ).length;
  const criticalPoints = Math.min(24, criticalCount * 8);
  if (criticalPoints > 0) {
    factors.push({
      key: "critical-devices",
      label: "Critical devices",
      points: criticalPoints,
      detail: `${criticalCount} CRITICAL device${criticalCount === 1 ? "" : "s"} (+8 each, capped at 24)`,
    });
  }

  // 3. Fleet size beyond the first device (parallel blast radius).
  const extraDevices = Math.max(0, input.deviceCount - 1);
  const fleetPoints = Math.min(12, extraDevices * 4);
  if (fleetPoints > 0) {
    factors.push({
      key: "fleet-size",
      label: "Fleet size",
      points: fleetPoints,
      detail: `${input.deviceCount} devices targeted (+4 per device beyond the first, capped at 12)`,
    });
  }

  // 4. Firewall exposure.
  if (input.affectsFirewall) {
    factors.push({
      key: "firewall",
      label: "Firewall exposure",
      points: 10,
      detail: "Change touches at least one firewall (perimeter blast radius)",
    });
  }

  // 5. Multi-site blast radius.
  if (input.siteCount > 1) {
    factors.push({
      key: "multi-site",
      label: "Multi-site scope",
      points: 6,
      detail: `Devices span ${input.siteCount} sites`,
    });
  }

  // 6. Missing rollback plan.
  if (!input.hasRollbackPlan) {
    factors.push({
      key: "no-rollback",
      label: "No rollback plan",
      points: 15,
      detail: "Rollback is the safety net when validation fails",
    });
  }

  // 7. Missing validation plan.
  if (!input.hasValidationPlan) {
    factors.push({
      key: "no-validation",
      label: "No validation plan",
      points: 8,
      detail: "Post-change verification is not documented",
    });
  }

  // 8. Business-hours window.
  if (input.scheduledBusinessHours) {
    factors.push({
      key: "business-hours",
      label: "Business-hours window",
      points: 12,
      detail: "Scheduled Sun–Thu between 08:00 and 17:00 — users are online",
    });
  }

  const score = Math.min(
    100,
    Math.max(0, factors.reduce((sum, f) => sum + f.points, 0))
  );
  return { score, level: riskLevelFor(score), factors };
}

/**
 * Approval policy map (documented governance policy, Plan §23):
 *   LOW      → TECHNICAL
 *   MEDIUM   → TECHNICAL + MANAGER
 *   HIGH     → TECHNICAL + SECURITY + MANAGER
 *   CRITICAL → TECHNICAL + SECURITY + MANAGER + CAB
 * The submission flow creates one PENDING ChangeApproval row per level
 * (@@unique changeId+level keeps re-submission idempotent).
 */
export const APPROVAL_LEVELS_BY_RISK: Record<RiskLevel, string[]> = {
  LOW: ["TECHNICAL"],
  MEDIUM: ["TECHNICAL", "MANAGER"],
  HIGH: ["TECHNICAL", "SECURITY", "MANAGER"],
  CRITICAL: ["TECHNICAL", "SECURITY", "MANAGER", "CAB"],
};

export function approvalLevelsFor(level: string): string[] {
  return APPROVAL_LEVELS_BY_RISK[level] ?? APPROVAL_LEVELS_BY_RISK.MEDIUM;
}
