/**
 * FayaNMS — Status single source of truth.
 *
 * Every device/severity/change/job/backup state used across the UI is
 * declared ONCE here. Rendering rules:
 *   - Never color alone: every config carries an icon name + label, and
 *     badges render icon + text on a subtle token background.
 *   - Tokens map 1:1 to CSS custom properties exposed in globals.css:
 *     success | warning | danger | danger-orange | info | neutral.
 *   - Severity mapping (identical everywhere):
 *       Critical -> danger | High -> danger-orange | Medium -> warning
 *       Low -> info      | Info  -> neutral
 * No external dependencies; icon names are resolved to lucide components
 * by the StatusIcon registry in src/components/domain/status-icon.tsx.
 *
 * i18n: every config built here carries a `labelKey` into the "status"
 * namespace of messages/{en,ar}.json (e.g. "status.device.ONLINE"). The
 * English `label` remains the canonical fallback — shared badges resolve
 * the label through useStatusLabel() (src/hooks/use-status-label.ts), so
 * server-side consumers and any missing key keep rendering English.
 */

export type StatusToken =
  | "success"
  | "warning"
  | "danger"
  | "danger-orange"
  | "info"
  | "neutral";

/** Everything a badge/dot needs to render a status (icon + label, never color-only). */
export interface StatusBadgeConfig {
  /** Canonical state key, e.g. "ONLINE", "SEV1", "ROLLED_BACK". */
  key: string;
  /** Human label (English — the canonical fallback for i18n). */
  label: string;
  /**
   * i18n key under the status namespace, e.g. "status.device.ONLINE";
   * English fallback stays in `label`. Optional so out-of-tree config
   * builders (src/components/views/status-extras.ts) stay valid — those
   * configs simply render the English label via the fallback path.
   */
  labelKey?: string;
  /** Token color key mapped in globals.css. */
  token: StatusToken;
  /** lucide icon name (resolved via StatusIcon registry). */
  icon: string;
  /** Tailwind classes for a solid colored dot. */
  dotClass: string;
  /** Tailwind classes for a Badge: subtle background + token text + border. */
  badgeClass: string;
  /** Tailwind classes for the icon / plain text in token color. */
  iconClass: string;
}

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
 * Builds a config for a status family. `family` is the lowerCamelCase slug
 * of the grouping the status belongs to (mirrors the section headers below:
 * device, interfaceAdmin, interfaceOper, snapshot, snapshotSource, severity,
 * incident, change, risk, backup, backupCompliance, drift, job, alert,
 * incidentStatus, common) and produces the labelKey used for i18n lookup.
 */
function makeConfig(
  family: string,
  key: string,
  label: string,
  token: StatusToken,
  icon: string
): StatusBadgeConfig {
  const classes = TOKEN_CLASSES[token];
  return {
    key,
    label,
    labelKey: `status.${family}.${key}`,
    token,
    icon,
    dotClass: classes.dot,
    badgeClass: classes.badge,
    iconClass: classes.icon,
  };
}

/* ------------------------------------------------------------------ */
/* Devices                                                             */
/* ------------------------------------------------------------------ */

export const DEVICE_STATUS = {
  ONLINE: makeConfig("device", "ONLINE", "Online", "success", "CircleCheck"),
  OFFLINE: makeConfig("device", "OFFLINE", "Offline", "danger", "CircleOff"),
  DEGRADED: makeConfig("device", "DEGRADED", "Degraded", "warning", "TriangleAlert"),
  MAINTENANCE: makeConfig("device", "MAINTENANCE", "Maintenance", "info", "Wrench"),
  UNKNOWN: makeConfig("device", "UNKNOWN", "Unknown", "neutral", "CircleHelp"),
  UNMANAGED: makeConfig("device", "UNMANAGED", "Unmanaged", "neutral", "CircleDashed"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type DeviceStatusKey = keyof typeof DEVICE_STATUS;

/* ------------------------------------------------------------------ */
/* Interfaces (admin/oper states per IF-MIB ifTable semantics)         */
/* ------------------------------------------------------------------ */

export const INTERFACE_ADMIN_STATUS = {
  UP: makeConfig("interfaceAdmin", "UP", "Admin Up", "success", "CircleCheck"),
  DOWN: makeConfig("interfaceAdmin", "DOWN", "Admin Down", "neutral", "CircleMinus"),
  TESTING: makeConfig("interfaceAdmin", "TESTING", "Testing", "warning", "CircleAlert"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type InterfaceAdminStatusKey = keyof typeof INTERFACE_ADMIN_STATUS;

export const INTERFACE_OPER_STATUS = {
  UP: makeConfig("interfaceOper", "UP", "Up", "success", "CircleCheck"),
  DOWN: makeConfig("interfaceOper", "DOWN", "Down", "danger", "CircleOff"),
  TESTING: makeConfig("interfaceOper", "TESTING", "Testing", "warning", "CircleAlert"),
  UNKNOWN: makeConfig("interfaceOper", "UNKNOWN", "Unknown", "neutral", "CircleHelp"),
  DORMANT: makeConfig("interfaceOper", "DORMANT", "Dormant", "warning", "Clock"),
  NOT_PRESENT: makeConfig(
    "interfaceOper",
    "NOT_PRESENT",
    "Not Present",
    "neutral",
    "CircleDashed"
  ),
  LOWER_LAYER_DOWN: makeConfig(
    "interfaceOper",
    "LOWER_LAYER_DOWN",
    "Lower Layer Down",
    "danger-orange",
    "CircleSlash"
  ),
} as const satisfies Record<string, StatusBadgeConfig>;

export type InterfaceOperStatusKey = keyof typeof INTERFACE_OPER_STATUS;

/* ------------------------------------------------------------------ */
/* Config snapshots (version history status + capture source)          */
/* ------------------------------------------------------------------ */

export const SNAPSHOT_STATUS = {
  CURRENT: makeConfig("snapshot", "CURRENT", "Current", "success", "CircleCheck"),
  HISTORICAL: makeConfig("snapshot", "HISTORICAL", "Historical", "neutral", "Archive"),
  BASELINE: makeConfig("snapshot", "BASELINE", "Baseline", "info", "ShieldCheck"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type SnapshotStatusKey = keyof typeof SNAPSHOT_STATUS;

export const SNAPSHOT_SOURCE = {
  SCHEDULED: makeConfig("snapshotSource", "SCHEDULED", "Scheduled", "info", "Clock"),
  MANUAL: makeConfig("snapshotSource", "MANUAL", "Manual", "neutral", "FilePen"),
  PRE_CHANGE: makeConfig(
    "snapshotSource",
    "PRE_CHANGE",
    "Pre-Change",
    "warning",
    "FileDiff"
  ),
  POST_CHANGE: makeConfig(
    "snapshotSource",
    "POST_CHANGE",
    "Post-Change",
    "info",
    "ShieldCheck"
  ),
  EVENT: makeConfig("snapshotSource", "EVENT", "Event-Driven", "warning", "TriangleAlert"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type SnapshotSourceKey = keyof typeof SNAPSHOT_SOURCE;

/* ------------------------------------------------------------------ */
/* Severity (Critical/High/Medium/Low/Info)                            */
/* ------------------------------------------------------------------ */

export const SEVERITY = {
  CRITICAL: makeConfig("severity", "CRITICAL", "Critical", "danger", "OctagonX"),
  HIGH: makeConfig("severity", "HIGH", "High", "danger-orange", "TriangleAlert"),
  MEDIUM: makeConfig("severity", "MEDIUM", "Medium", "warning", "CircleAlert"),
  LOW: makeConfig("severity", "LOW", "Low", "info", "Info"),
  INFO: makeConfig("severity", "INFO", "Info", "neutral", "CircleMinus"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type SeverityKey = keyof typeof SEVERITY;

/** Incident severities mapped onto the same severity tokens. */
export const INCIDENT_SEVERITY = {
  SEV1: makeConfig("incident", "SEV1", "SEV1 — Critical", "danger", "OctagonX"),
  SEV2: makeConfig("incident", "SEV2", "SEV2 — High", "danger-orange", "TriangleAlert"),
  SEV3: makeConfig("incident", "SEV3", "SEV3 — Medium", "warning", "CircleAlert"),
  SEV4: makeConfig("incident", "SEV4", "SEV4 — Low", "info", "Info"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type IncidentSeverityKey = keyof typeof INCIDENT_SEVERITY;

/* ------------------------------------------------------------------ */
/* Change lifecycle, grouped by family                                 */
/* ------------------------------------------------------------------ */

export type ChangeStatusFamily =
  | "active"
  | "success"
  | "warning"
  | "danger"
  | "neutral";

const CHANGE_FAMILY_TOKEN: Record<ChangeStatusFamily, StatusToken> = {
  active: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
  neutral: "neutral",
};

export interface ChangeStatusConfig extends StatusBadgeConfig {
  family: ChangeStatusFamily;
}

function changeConfig(
  key: string,
  label: string,
  family: ChangeStatusFamily,
  icon: string
): ChangeStatusConfig {
  return {
    ...makeConfig("change", key, label, CHANGE_FAMILY_TOKEN[family], icon),
    family,
  };
}

export const CHANGE_STATUS = {
  DRAFT: changeConfig("DRAFT", "Draft", "neutral", "FilePen"),
  PENDING_APPROVAL: changeConfig(
    "PENDING_APPROVAL",
    "Pending Approval",
    "warning",
    "Clock"
  ),
  APPROVED: changeConfig("APPROVED", "Approved", "active", "ShieldCheck"),
  SCHEDULED: changeConfig("SCHEDULED", "Scheduled", "active", "CalendarClock"),
  IN_PROGRESS: changeConfig("IN_PROGRESS", "In Progress", "active", "LoaderCircle"),
  VALIDATING: changeConfig("VALIDATING", "Validating", "active", "Search"),
  COMPLETED: changeConfig("COMPLETED", "Completed", "success", "CircleCheck"),
  PARTIAL_SUCCESS: changeConfig(
    "PARTIAL_SUCCESS",
    "Partial Success",
    "warning",
    "CircleAlert"
  ),
  ROLLING_BACK: changeConfig("ROLLING_BACK", "Rolling Back", "warning", "RotateCcw"),
  ROLLED_BACK: changeConfig("ROLLED_BACK", "Rolled Back", "warning", "Undo2"),
  ROLLBACK_FAILED: changeConfig(
    "ROLLBACK_FAILED",
    "Rollback Failed",
    "danger",
    "ShieldAlert"
  ),
  FAILED: changeConfig("FAILED", "Failed", "danger", "CircleX"),
  REJECTED: changeConfig("REJECTED", "Rejected", "neutral", "CircleSlash"),
  CANCELLED: changeConfig("CANCELLED", "Cancelled", "neutral", "Ban"),
  EXPIRED: changeConfig("EXPIRED", "Expired", "neutral", "CircleOff"),
  CLOSED: changeConfig("CLOSED", "Closed", "neutral", "Archive"),
} as const satisfies Record<string, ChangeStatusConfig>;

export type ChangeStatusKey = keyof typeof CHANGE_STATUS;

/* ------------------------------------------------------------------ */
/* Change risk (0–100 score buckets)                                   */
/* ------------------------------------------------------------------ */

export const RISK_LEVEL = {
  LOW: makeConfig("risk", "LOW", "Low Risk", "success", "ShieldCheck"),
  MEDIUM: makeConfig("risk", "MEDIUM", "Medium Risk", "warning", "ShieldAlert"),
  HIGH: makeConfig("risk", "HIGH", "High Risk", "danger-orange", "TriangleAlert"),
  CRITICAL: makeConfig("risk", "CRITICAL", "Critical Risk", "danger", "Siren"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type RiskLevelKey = keyof typeof RISK_LEVEL;

/* ------------------------------------------------------------------ */
/* Backups & drift                                                     */
/* ------------------------------------------------------------------ */

/** Individual backup run outcome. */
export const BACKUP_STATUS = {
  QUEUED: makeConfig("backup", "QUEUED", "Queued", "neutral", "Clock"),
  RUNNING: makeConfig("backup", "RUNNING", "Running", "info", "LoaderCircle"),
  SUCCESS: makeConfig("backup", "SUCCESS", "Success", "success", "CircleCheck"),
  FAILED: makeConfig("backup", "FAILED", "Failed", "danger", "CircleX"),
  SKIPPED: makeConfig("backup", "SKIPPED", "Skipped", "neutral", "CircleMinus"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type BackupStatusKey = keyof typeof BACKUP_STATUS;

/** Per-device backup compliance rollup. */
export const BACKUP_COMPLIANCE = {
  COMPLIANT: makeConfig("backupCompliance", "COMPLIANT", "Compliant", "success", "ShieldCheck"),
  OVERDUE: makeConfig("backupCompliance", "OVERDUE", "Overdue", "warning", "Clock"),
  FAILED: makeConfig(
    "backupCompliance",
    "FAILED",
    "Last Backup Failed",
    "danger",
    "CircleX"
  ),
  NEVER_BACKED_UP: makeConfig(
    "backupCompliance",
    "NEVER_BACKED_UP",
    "Never Backed Up",
    "danger",
    "CloudOff"
  ),
  UNKNOWN: makeConfig("backupCompliance", "UNKNOWN", "Unknown", "neutral", "CircleHelp"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type BackupComplianceKey = keyof typeof BACKUP_COMPLIANCE;

export const DRIFT_STATUS = {
  OPEN: makeConfig("drift", "OPEN", "Open", "warning", "FileDiff"),
  RESOLVED: makeConfig("drift", "RESOLVED", "Resolved", "success", "CircleCheck"),
  ACCEPTED: makeConfig("drift", "ACCEPTED", "Accepted", "info", "Check"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type DriftStatusKey = keyof typeof DRIFT_STATUS;

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export const JOB_STATUS = {
  QUEUED: makeConfig("job", "QUEUED", "Queued", "neutral", "Clock"),
  RUNNING: makeConfig("job", "RUNNING", "Running", "info", "LoaderCircle"),
  SUCCEEDED: makeConfig("job", "SUCCEEDED", "Succeeded", "success", "CircleCheck"),
  FAILED: makeConfig("job", "FAILED", "Failed", "danger", "CircleX"),
  DEAD: makeConfig("job", "DEAD", "Dead (Retries Exhausted)", "danger", "Skull"),
  CANCELLED: makeConfig("job", "CANCELLED", "Cancelled", "neutral", "Ban"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type JobStatusKey = keyof typeof JOB_STATUS;

/* ------------------------------------------------------------------ */
/* Alerts & incidents                                                  */
/* ------------------------------------------------------------------ */

export const ALERT_STATUS = {
  FIRING: makeConfig("alert", "FIRING", "Firing", "danger", "BellRing"),
  ACKNOWLEDGED: makeConfig("alert", "ACKNOWLEDGED", "Acknowledged", "warning", "BellDot"),
  SUPPRESSED: makeConfig("alert", "SUPPRESSED", "Suppressed", "neutral", "BellOff"),
  RESOLVED: makeConfig("alert", "RESOLVED", "Resolved", "success", "CircleCheck"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type AlertStatusKey = keyof typeof ALERT_STATUS;

export const INCIDENT_STATUS = {
  OPEN: makeConfig("incidentStatus", "OPEN", "Open", "danger", "Siren"),
  ACKNOWLEDGED: makeConfig("incidentStatus", "ACKNOWLEDGED", "Acknowledged", "warning", "Eye"),
  INVESTIGATING: makeConfig(
    "incidentStatus",
    "INVESTIGATING",
    "Investigating",
    "info",
    "Search"
  ),
  RESOLVED: makeConfig("incidentStatus", "RESOLVED", "Resolved", "success", "CircleCheck"),
  CLOSED: makeConfig("incidentStatus", "CLOSED", "Closed", "neutral", "Archive"),
} as const satisfies Record<string, StatusBadgeConfig>;

export type IncidentStatusKey = keyof typeof INCIDENT_STATUS;

/* ------------------------------------------------------------------ */
/* Safe lookup                                                         */
/* ------------------------------------------------------------------ */

export const FALLBACK_STATUS_CONFIG: StatusBadgeConfig = makeConfig(
  "common",
  "UNKNOWN",
  "Unknown",
  "neutral",
  "CircleHelp"
);

/**
 * Resolve a state key against a status map. Never throws and never falls
 * back to a bare color: the returned config always carries an icon + label.
 * Lookup normalizes case, whitespace and hyphens ("rolled-back" -> "ROLLED_BACK").
 * When the key is missing, the map's own UNKNOWN entry wins (if present),
 * otherwise the shared neutral fallback is returned.
 */
export function getStatusConfig<T extends Record<string, StatusBadgeConfig>>(
  map: T,
  key: string | null | undefined
): StatusBadgeConfig {
  const record = map as Record<string, StatusBadgeConfig>;
  if (key) {
    const normalized = key
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, "_");
    const match = record[normalized];
    if (match) return match;
  }
  return record["UNKNOWN"] ?? FALLBACK_STATUS_CONFIG;
}
