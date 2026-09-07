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

/**
 * Family-scoped i18n: labelKey = `status.<family>.<key>` (same contract as
 * status.ts makeConfig). Keys whose label+key exactly match a status.ts
 * entry REUSE that translation via `reuse` instead of duplicating strings.
 */
function makeConfig(
  family: string,
  key: string,
  label: string,
  token: StatusToken,
  icon: string,
  reuse?: string
): StatusBadgeConfig {
  const classes = TOKEN_CLASSES[token];
  return {
    key,
    label,
    labelKey: reuse ?? `status.${family}.${key}`,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/** Alert statuses as stored in the database. */
export const ALERT_STATUS_UI: Record<string, StatusBadgeConfig> = {
  ACTIVE: makeConfig("alert", "ACTIVE", "Active", "danger", "BellRing"),
  ACKNOWLEDGED: makeConfig("alert", "ACKNOWLEDGED", "Acknowledged", "warning", "BellDot", "status.alert.ACKNOWLEDGED"),
  SUPPRESSED: makeConfig("alert", "SUPPRESSED", "Suppressed", "neutral", "BellOff", "status.alert.SUPPRESSED"),
  RESOLVED: makeConfig("alert", "RESOLVED", "Resolved", "success", "CircleCheck", "status.alert.RESOLVED"),
};

/** Incident lifecycle as stored in the database. */
export const INCIDENT_STATUS_UI: Record<string, StatusBadgeConfig> = {
  NEW: makeConfig("incidentStatus", "NEW", "New", "danger", "Siren"),
  ACKNOWLEDGED: makeConfig("incidentStatus", "ACKNOWLEDGED", "Acknowledged", "warning", "Eye", "status.incidentStatus.ACKNOWLEDGED"),
  ASSIGNED: makeConfig("incidentStatus", "ASSIGNED", "Assigned", "warning", "Wrench"),
  INVESTIGATING: makeConfig("incidentStatus", "INVESTIGATING", "Investigating", "info", "Search", "status.incidentStatus.INVESTIGATING"),
  MITIGATING: makeConfig("incidentStatus", "MITIGATING", "Mitigating", "warning", "Wrench"),
  MONITORING: makeConfig("incidentStatus", "MONITORING", "Monitoring", "info", "Eye"),
  RESOLVED: makeConfig("incidentStatus", "RESOLVED", "Resolved", "success", "CircleCheck", "status.incidentStatus.RESOLVED"),
  POST_INCIDENT_REVIEW: makeConfig(
    "incidentStatus",
    "POST_INCIDENT_REVIEW",
    "Post-Incident Review",
    "warning",
    "FilePen"
  ),
  CLOSED: makeConfig("incidentStatus", "CLOSED", "Closed", "neutral", "Archive", "status.incidentStatus.CLOSED"),
};

/** Change lifecycle as stored in the database (schema comment values). */
export const CHANGE_STATUS_UI: Record<string, StatusBadgeConfig> = {
  DRAFT: makeConfig("change", "DRAFT", "Draft", "neutral", "FilePen", "status.change.DRAFT"),
  PLANNING: makeConfig("change", "PLANNING", "Planning", "neutral", "Clock"),
  TECHNICAL_REVIEW: makeConfig("change", "TECHNICAL_REVIEW", "Technical Review", "info", "Search"),
  AWAITING_APPROVAL: makeConfig("change", "AWAITING_APPROVAL", "Awaiting Approval", "warning", "Clock"),
  APPROVED: makeConfig("change", "APPROVED", "Approved", "info", "ShieldCheck", "status.change.APPROVED"),
  SCHEDULED: makeConfig("change", "SCHEDULED", "Scheduled", "info", "CalendarClock", "status.change.SCHEDULED"),
  PRE_CHECK: makeConfig("change", "PRE_CHECK", "Pre-Check", "info", "Search"),
  EXECUTING: makeConfig("change", "EXECUTING", "Executing", "info", "LoaderCircle"),
  VALIDATING: makeConfig("change", "VALIDATING", "Validating", "info", "Search", "status.change.VALIDATING"),
  SUCCESSFUL: makeConfig("change", "SUCCESSFUL", "Successful", "success", "CircleCheck"),
  POST_REVIEW: makeConfig("change", "POST_REVIEW", "Post-Review", "info", "FilePen"),
  CLOSED: makeConfig("change", "CLOSED", "Closed", "neutral", "Archive", "status.change.CLOSED"),
  FAILED: makeConfig("change", "FAILED", "Failed", "danger", "CircleX", "status.change.FAILED"),
  ROLLBACK: makeConfig("change", "ROLLBACK", "Rolled Back", "warning", "Undo2", "status.change.ROLLED_BACK"),
  ROLLBACK_FAILED: makeConfig("change", "ROLLBACK_FAILED", "Rollback Failed", "danger", "ShieldAlert", "status.change.ROLLBACK_FAILED"),
  REJECTED: makeConfig("change", "REJECTED", "Rejected", "neutral", "CircleSlash", "status.change.REJECTED"),
  CANCELLED: makeConfig("change", "CANCELLED", "Cancelled", "neutral", "Ban", "status.change.CANCELLED"),
  EXPIRED: makeConfig("change", "EXPIRED", "Expired", "neutral", "CircleOff", "status.change.EXPIRED"),
  PARTIAL_SUCCESS: makeConfig("change", "PARTIAL_SUCCESS", "Partial Success", "warning", "CircleAlert", "status.change.PARTIAL_SUCCESS"),
};

/** Change execution steps (ChangeStep.status values). Added in Task 4-a. */
export const CHANGE_STEP_STATUS_UI: Record<string, StatusBadgeConfig> = {
  PENDING: makeConfig("changeStep", "PENDING", "Pending", "neutral", "Clock"),
  RUNNING: makeConfig("changeStep", "RUNNING", "Running", "info", "LoaderCircle"),
  PASSED: makeConfig("changeStep", "PASSED", "Passed", "success", "CircleCheck"),
  FAILED: makeConfig("changeStep", "FAILED", "Failed", "danger", "CircleX"),
  SKIPPED: makeConfig("changeStep", "SKIPPED", "Skipped", "neutral", "CircleMinus"),
};

/** Change step types (ChangeStep.type values) — icon used in the timeline. */
export const CHANGE_STEP_TYPE_UI: Record<string, StatusBadgeConfig> = {
  CHECK: makeConfig("changeStepType", "CHECK", "Check", "info", "Search"),
  BACKUP: makeConfig("changeStepType", "BACKUP", "Backup", "neutral", "HardDriveDownload"),
  APPLY: makeConfig("changeStepType", "APPLY", "Apply", "warning", "Play"),
  VALIDATE: makeConfig("changeStepType", "VALIDATE", "Validate", "info", "ClipboardCheck"),
  ROLLBACK: makeConfig("changeStepType", "ROLLBACK", "Rollback", "danger-orange", "Undo2"),
};

/** Change approval statuses (ChangeApproval.status values). Task 4-a. */
export const CHANGE_APPROVAL_STATUS_UI: Record<string, StatusBadgeConfig> = {
  PENDING: makeConfig("changeApproval", "PENDING", "Pending", "warning", "Clock"),
  APPROVED: makeConfig("changeApproval", "APPROVED", "Approved", "success", "ShieldCheck"),
  REJECTED: makeConfig("changeApproval", "REJECTED", "Rejected", "danger", "CircleX"),
  NOT_REQUIRED: makeConfig("changeApproval", "NOT_REQUIRED", "Not Required", "neutral", "CircleMinus"),
};

/** Change approval levels (ChangeApproval.level values) with display labels. */
export const CHANGE_APPROVAL_LEVEL_UI: Record<string, StatusBadgeConfig> = {
  TECHNICAL: makeConfig("changeApprovalLevel", "TECHNICAL", "Technical", "info", "Wrench"),
  SECURITY: makeConfig("changeApprovalLevel", "SECURITY", "Security", "warning", "ShieldCheck"),
  MANAGER: makeConfig("changeApprovalLevel", "MANAGER", "Manager", "neutral", "Scale"),
  CAB: makeConfig("changeApprovalLevel", "CAB", "CAB", "danger-orange", "Users"),
};

/** Change types (ChangeRequest.type values) for outline badges with icons. */
export const CHANGE_TYPE_UI: Record<string, StatusBadgeConfig> = {
  STANDARD: makeConfig("changeType", "STANDARD", "Standard", "success", "ShieldCheck"),
  NORMAL: makeConfig("changeType", "NORMAL", "Normal", "info", "Wrench"),
  EMERGENCY: makeConfig("changeType", "EMERGENCY", "Emergency", "danger", "Siren"),
};

/** Change device results (ChangeDevice.result values). Task 4-a. */
export const CHANGE_DEVICE_RESULT_UI: Record<string, StatusBadgeConfig> = {
  PENDING: makeConfig("changeDeviceResult", "PENDING", "Pending", "neutral", "Clock"),
  SUCCESS: makeConfig("changeDeviceResult", "SUCCESS", "Success", "success", "CircleCheck"),
  FAILED: makeConfig("changeDeviceResult", "FAILED", "Failed", "danger", "CircleX"),
  SKIPPED: makeConfig("changeDeviceResult", "SKIPPED", "Skipped", "neutral", "CircleMinus"),
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
