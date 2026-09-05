import type { StatusBadgeConfig, StatusToken } from "@/lib/domain/status";
import { FALLBACK_STATUS_CONFIG } from "@/lib/domain/status";

/**
 * UI status maps for DB values that pre-date the corresponding entries in
 * src/lib/domain/status.ts (alert "ACTIVE", incident lifecycle incl. NEW /
 * MITIGATING / MONITORING, and the change lifecycle's AWAITING_APPROVAL /
 * EXECUTING / ROLLBACK / SUCCESSFUL). Mirrors the token classes and safe
 * lookup of status.ts without modifying it; icon names are restricted to
 * the StatusIcon registry.
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

function makeConfig(
  key: string,
  label: string,
  token: StatusToken,
  icon: string
): StatusBadgeConfig {
  const classes = TOKEN_CLASSES[token];
  return {
    key,
    label,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/** Alert statuses as stored in the database. */
export const ALERT_STATUS_UI: Record<string, StatusBadgeConfig> = {
  ACTIVE: makeConfig("ACTIVE", "Active", "danger", "BellRing"),
  ACKNOWLEDGED: makeConfig("ACKNOWLEDGED", "Acknowledged", "warning", "BellDot"),
  SUPPRESSED: makeConfig("SUPPRESSED", "Suppressed", "neutral", "BellOff"),
  RESOLVED: makeConfig("RESOLVED", "Resolved", "success", "CircleCheck"),
};

/** Incident lifecycle as stored in the database. */
export const INCIDENT_STATUS_UI: Record<string, StatusBadgeConfig> = {
  NEW: makeConfig("NEW", "New", "danger", "Siren"),
  ACKNOWLEDGED: makeConfig("ACKNOWLEDGED", "Acknowledged", "warning", "Eye"),
  ASSIGNED: makeConfig("ASSIGNED", "Assigned", "warning", "Wrench"),
  INVESTIGATING: makeConfig("INVESTIGATING", "Investigating", "info", "Search"),
  MITIGATING: makeConfig("MITIGATING", "Mitigating", "warning", "Wrench"),
  MONITORING: makeConfig("MONITORING", "Monitoring", "info", "Eye"),
  RESOLVED: makeConfig("RESOLVED", "Resolved", "success", "CircleCheck"),
  POST_INCIDENT_REVIEW: makeConfig(
    "POST_INCIDENT_REVIEW",
    "Post-Incident Review",
    "warning",
    "FilePen"
  ),
  CLOSED: makeConfig("CLOSED", "Closed", "neutral", "Archive"),
};

/** Change lifecycle as stored in the database (schema comment values). */
export const CHANGE_STATUS_UI: Record<string, StatusBadgeConfig> = {
  DRAFT: makeConfig("DRAFT", "Draft", "neutral", "FilePen"),
  PLANNING: makeConfig("PLANNING", "Planning", "neutral", "Clock"),
  TECHNICAL_REVIEW: makeConfig("TECHNICAL_REVIEW", "Technical Review", "info", "Search"),
  AWAITING_APPROVAL: makeConfig("AWAITING_APPROVAL", "Awaiting Approval", "warning", "Clock"),
  APPROVED: makeConfig("APPROVED", "Approved", "info", "ShieldCheck"),
  SCHEDULED: makeConfig("SCHEDULED", "Scheduled", "info", "CalendarClock"),
  PRE_CHECK: makeConfig("PRE_CHECK", "Pre-Check", "info", "Search"),
  EXECUTING: makeConfig("EXECUTING", "Executing", "info", "LoaderCircle"),
  VALIDATING: makeConfig("VALIDATING", "Validating", "info", "Search"),
  SUCCESSFUL: makeConfig("SUCCESSFUL", "Successful", "success", "CircleCheck"),
  POST_REVIEW: makeConfig("POST_REVIEW", "Post-Review", "info", "FilePen"),
  CLOSED: makeConfig("CLOSED", "Closed", "neutral", "Archive"),
  FAILED: makeConfig("FAILED", "Failed", "danger", "CircleX"),
  ROLLBACK: makeConfig("ROLLBACK", "Rolled Back", "warning", "Undo2"),
  ROLLBACK_FAILED: makeConfig("ROLLBACK_FAILED", "Rollback Failed", "danger", "ShieldAlert"),
  REJECTED: makeConfig("REJECTED", "Rejected", "neutral", "CircleSlash"),
  CANCELLED: makeConfig("CANCELLED", "Cancelled", "neutral", "Ban"),
  EXPIRED: makeConfig("EXPIRED", "Expired", "neutral", "CircleOff"),
  PARTIAL_SUCCESS: makeConfig("PARTIAL_SUCCESS", "Partial Success", "warning", "CircleAlert"),
};

/** Change execution steps (ChangeStep.status values). Added in Task 4-a. */
export const CHANGE_STEP_STATUS_UI: Record<string, StatusBadgeConfig> = {
  PENDING: makeConfig("PENDING", "Pending", "neutral", "Clock"),
  RUNNING: makeConfig("RUNNING", "Running", "info", "LoaderCircle"),
  PASSED: makeConfig("PASSED", "Passed", "success", "CircleCheck"),
  FAILED: makeConfig("FAILED", "Failed", "danger", "CircleX"),
  SKIPPED: makeConfig("SKIPPED", "Skipped", "neutral", "CircleMinus"),
};

/** Change step types (ChangeStep.type values) — icon used in the timeline. */
export const CHANGE_STEP_TYPE_UI: Record<string, StatusBadgeConfig> = {
  CHECK: makeConfig("CHECK", "Check", "info", "Search"),
  BACKUP: makeConfig("BACKUP", "Backup", "neutral", "HardDriveDownload"),
  APPLY: makeConfig("APPLY", "Apply", "warning", "Play"),
  VALIDATE: makeConfig("VALIDATE", "Validate", "info", "ClipboardCheck"),
  ROLLBACK: makeConfig("ROLLBACK", "Rollback", "danger-orange", "Undo2"),
};

/** Change approval statuses (ChangeApproval.status values). Task 4-a. */
export const CHANGE_APPROVAL_STATUS_UI: Record<string, StatusBadgeConfig> = {
  PENDING: makeConfig("PENDING", "Pending", "warning", "Clock"),
  APPROVED: makeConfig("APPROVED", "Approved", "success", "ShieldCheck"),
  REJECTED: makeConfig("REJECTED", "Rejected", "danger", "CircleX"),
  NOT_REQUIRED: makeConfig("NOT_REQUIRED", "Not Required", "neutral", "CircleMinus"),
};

/** Change approval levels (ChangeApproval.level values) with display labels. */
export const CHANGE_APPROVAL_LEVEL_UI: Record<string, StatusBadgeConfig> = {
  TECHNICAL: makeConfig("TECHNICAL", "Technical", "info", "Wrench"),
  SECURITY: makeConfig("SECURITY", "Security", "warning", "ShieldCheck"),
  MANAGER: makeConfig("MANAGER", "Manager", "neutral", "Scale"),
  CAB: makeConfig("CAB", "CAB", "danger-orange", "Users"),
};

/** Change types (ChangeRequest.type values) for outline badges with icons. */
export const CHANGE_TYPE_UI: Record<string, StatusBadgeConfig> = {
  STANDARD: makeConfig("STANDARD", "Standard", "success", "ShieldCheck"),
  NORMAL: makeConfig("NORMAL", "Normal", "info", "Wrench"),
  EMERGENCY: makeConfig("EMERGENCY", "Emergency", "danger", "Siren"),
};

/** Change device results (ChangeDevice.result values). Task 4-a. */
export const CHANGE_DEVICE_RESULT_UI: Record<string, StatusBadgeConfig> = {
  PENDING: makeConfig("PENDING", "Pending", "neutral", "Clock"),
  SUCCESS: makeConfig("SUCCESS", "Success", "success", "CircleCheck"),
  FAILED: makeConfig("FAILED", "Failed", "danger", "CircleX"),
  SKIPPED: makeConfig("SKIPPED", "Skipped", "neutral", "CircleMinus"),
};

/** Safe lookup over the UI maps above (same normalization as status.ts). */
export function lookupStatusConfig(
  map: Record<string, StatusBadgeConfig>,
  key: string | null | undefined
): StatusBadgeConfig {
  if (key) {
    const normalized = key.trim().toUpperCase().replace(/[\s-]+/g, "_");
    const match = map[normalized];
    if (match) return match;
  }
  return FALLBACK_STATUS_CONFIG;
}
