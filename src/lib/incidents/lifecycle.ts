/**
 * Incident lifecycle contract (Task 5-b).
 *
 * Single source of truth for the 9-state incident lifecycle
 * (NEW | ACKNOWLEDGED | ASSIGNED | INVESTIGATING | MITIGATING | MONITORING |
 *  RESOLVED | POST_INCIDENT_REVIEW | CLOSED), the SLA math and the timeline
 * event attribution. The API routes under /api/v1/incidents consume this
 * module — do not duplicate the transition rules in views.
 */

/** Statuses where the incident is still open (operationally active). */
export const INCIDENT_OPEN_STATUSES: readonly string[] = [
  "NEW",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "MITIGATING",
  "MONITORING",
];

/** Statuses where the operational work is done (resolve onward). */
export const INCIDENT_RESOLVED_STATUSES: readonly string[] = [
  "RESOLVED",
  "POST_INCIDENT_REVIEW",
  "CLOSED",
];

/** Lifecycle action → allowed source statuses + target status. */
export const INCIDENT_TRANSITIONS: Record<
  string,
  { from: readonly string[]; to: string; audit: string }
> = {
  acknowledge: {
    from: INCIDENT_OPEN_STATUSES,
    to: "ACKNOWLEDGED",
    audit: "INCIDENT_ACKNOWLEDGED",
  },
  assign: {
    from: ["NEW", "ACKNOWLEDGED", "ASSIGNED"],
    to: "ASSIGNED",
    audit: "INCIDENT_ASSIGNED",
  },
  investigate: {
    from: INCIDENT_OPEN_STATUSES,
    to: "INVESTIGATING",
    audit: "INCIDENT_INVESTIGATING",
  },
  mitigate: {
    from: INCIDENT_OPEN_STATUSES,
    to: "MITIGATING",
    audit: "INCIDENT_MITIGATING",
  },
  monitor: {
    from: INCIDENT_OPEN_STATUSES,
    to: "MONITORING",
    audit: "INCIDENT_MONITORING",
  },
  resolve: {
    from: INCIDENT_OPEN_STATUSES,
    to: "RESOLVED",
    audit: "INCIDENT_RESOLVED",
  },
  review: {
    from: ["RESOLVED"],
    to: "POST_INCIDENT_REVIEW",
    audit: "INCIDENT_REVIEW_OPENED",
  },
  close: {
    from: ["RESOLVED", "POST_INCIDENT_REVIEW"],
    to: "CLOSED",
    audit: "INCIDENT_CLOSED",
  },
};

/** IncidentEvent.kind values (schema comment) with display metadata. */
export const INCIDENT_EVENT_KINDS: Record<string, { label: string }> = {
  SYSTEM: { label: "System" },
  USER: { label: "User" },
  INTEGRATION: { label: "Integration" },
};

/** Check whether an action is legal from the incident's current status. */
export function isTransitionAllowed(
  action: string,
  currentStatus: string
): boolean {
  const transition = INCIDENT_TRANSITIONS[action];
  if (!transition) return false;
  return transition.from.includes(currentStatus);
}

export interface SlaState {
  /** true when the incident has an slaDueAt. */
  tracked: boolean;
  /** ms until slaDueAt; negative when breached; null when untracked/resolved. */
  dueInMs: number | null;
  /** Open incident whose slaDueAt has passed. */
  breached: boolean;
  /** 0–100: time remaining fraction of the SLA window (100 = just created). */
  remainingPct: number | null;
  /** Outcome for resolved incidents — MET when resolvedAt <= slaDueAt. */
  outcome: "MET" | "BREACHED" | null;
  /** Human SLA target, e.g. "1h" (derived from slaDueAt - createdAt). */
  targetLabel: string | null;
}

/**
 * Compute the SLA state for one incident.
 *  - open:    breached = now > slaDueAt; dueInMs counts down; remainingPct
 *             drives the chip coloring (green >50%, amber ≤50%, red breached).
 *  - resolved/outcome compares resolvedAt against slaDueAt.
 */
export function computeSlaState(input: {
  severity: string;
  status: string;
  createdAt: Date | string;
  slaDueAt: Date | string | null;
  resolvedAt?: Date | string | null;
  now?: Date;
}): SlaState {
  const now = input.now ?? new Date();
  const createdAt = new Date(input.createdAt);
  const slaDueAt = input.slaDueAt ? new Date(input.slaDueAt) : null;

  if (!slaDueAt) {
    return {
      tracked: false,
      dueInMs: null,
      breached: false,
      remainingPct: null,
      outcome: null,
      targetLabel: null,
    };
  }

  const totalMs = slaDueAt.getTime() - createdAt.getTime();
  const hours = Math.round((totalMs / 3_600_000) * 10) / 10;
  const targetLabel = `SLA ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;

  const resolvedAt = input.resolvedAt ? new Date(input.resolvedAt) : null;
  if (resolvedAt) {
    return {
      tracked: true,
      dueInMs: null,
      breached: resolvedAt.getTime() > slaDueAt.getTime(),
      remainingPct: null,
      outcome:
        resolvedAt.getTime() <= slaDueAt.getTime() ? "MET" : "BREACHED",
      targetLabel,
    };
  }

  const dueInMs = slaDueAt.getTime() - now.getTime();
  const remainingPct =
    totalMs > 0
      ? Math.max(0, Math.min(100, Math.round((dueInMs / totalMs) * 100)))
      : 0;

  return {
    tracked: true,
    dueInMs,
    breached: dueInMs < 0,
    remainingPct,
    outcome: null,
    targetLabel,
  };
}

/** Format a due-in ms duration compactly for chips, e.g. "42m", "1h 05m", "-3m". */
export function formatSlaCountdown(dueInMs: number): string {
  const abs = Math.abs(dueInMs);
  const sign = dueInMs < 0 ? "-" : "";
  const hours = Math.floor(abs / 3_600_000);
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  if (hours > 0) return `${sign}${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${sign}${minutes}m`;
}
