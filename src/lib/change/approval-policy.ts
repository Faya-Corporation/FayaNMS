/**
 * FayaNMS — bindable approval policy (POL-001/002/003, external ULTRA audit
 * P1-001/P1-002 closeout).
 *
 * PURE module — zero dependencies, safe to import from routes, worker and
 * tests (same posture as risk.ts / restore-op.ts / execution-guard.ts).
 *
 * What changed vs the pre-POL model:
 *   - POL-001 (quorum): an approval LEVEL is satisfied by QUORUM distinct
 *     approvers, not one row. Policy: every level requires 1 approver except
 *     CAB on CRITICAL changes, which requires a TWO-person quorum ("enforce
 *     distinct approvers for CRITICAL changes" — audit §6 P1-001). The same
 *     principal can never fill two quorum slots, even a wildcard holder —
 *     a quorum of one person is not a quorum.
 *   - POL-002 (fingerprint): every decision carries the SHA-256 fingerprint
 *     of the canonical approved spec it saw (fingerprint.ts). The execute
 *     gate verifies the change's current spec still hashes identically.
 *   - POL-003 (expiry): APPROVED decisions carry a validity horizon
 *     (risk-tiered below). Expired decisions stop counting toward the
 *     quorum; execution refuses fail-closed and the change returns to
 *     AWAITING_APPROVAL for a fresh approval cycle.
 *
 * The evaluator below is the SINGLE source of truth for level state — the
 * decision route and the execute gate both call it, so the cached
 * ChangeApproval.status column and the execution-time verdict can never
 * disagree.
 */

/** Risk tiers that gate the two-person CAB quorum (P1-001). */
export const CAB_QUORUM_RISK_LEVELS: readonly string[] = ["CRITICAL"];

/** Quorum size for CAB on those tiers. */
export const CAB_QUORUM_SIZE = 2;

/**
 * Quorum for a level on a risk tier: 1 everywhere except CAB on the
 * quorum-gated tiers (2 distinct approvers).
 */
export function quorumRequiredFor(level: string, riskLevel: string): number {
  if (level === "CAB" && CAB_QUORUM_RISK_LEVELS.includes(riskLevel)) {
    return CAB_QUORUM_SIZE;
  }
  return 1;
}

/**
 * Approval validity windows (POL-003), risk-tiered — riskier changes get
 * tighter horizons so stale approvals cannot authorize stale intent:
 *   CRITICAL 14d · HIGH 30d · MEDIUM 90d · LOW 180d.
 * Deliberate code constants (not env): the approval policy is governance,
 * reviewed in PRs like the TTL policies in execution-guard.ts — not a
 * per-deployment knob.
 */
export const APPROVAL_VALIDITY_MS: Record<string, number> = {
  CRITICAL: 14 * 24 * 60 * 60 * 1000,
  HIGH: 30 * 24 * 60 * 60 * 1000,
  MEDIUM: 90 * 24 * 60 * 60 * 1000,
  LOW: 180 * 24 * 60 * 60 * 1000,
};

/** Default for unknown risk levels — HIGH's window (fail-tight, not loose). */
export const APPROVAL_VALIDITY_DEFAULT_MS = APPROVAL_VALIDITY_MS.HIGH;

export function approvalValidityMsFor(riskLevel: string): number {
  return APPROVAL_VALIDITY_MS[riskLevel] ?? APPROVAL_VALIDITY_DEFAULT_MS;
}

/**
 * Validity horizon for a decision. APPROVED → decidedAt + window;
 * REJECTED → null (a rejection needs no horizon — it ends the cycle).
 */
export function approvalExpiryFor(
  riskLevel: string,
  decision: "APPROVED" | "REJECTED",
  decidedAt: Date
): Date | null {
  if (decision !== "APPROVED") return null;
  return new Date(decidedAt.getTime() + approvalValidityMsFor(riskLevel));
}

/** Decision record the evaluator consumes (Prisma rows project onto this). */
export interface ApprovalDecisionInput {
  decision: string; // APPROVED | REJECTED
  /** Approver principal — null (deleted user) decisions never count. */
  approverId: string | null;
  /** POL-003 validity horizon; APPROVED decisions with null expiry are
   * treated as UNBINDABLE (fail-closed — see UNBINDABLE_DECISION). */
  expiresAt: Date | null;
  /** POL-002 spec fingerprint the decision was cast against. */
  fingerprint: string;
  decidedAt: Date;
  approverName?: string | null;
}

/** Approval-level row the evaluator consumes (cached status included). */
export interface ApprovalRowInput {
  id: string;
  level: string;
  status: string; // PENDING | APPROVED | REJECTED | NOT_REQUIRED
  quorumRequired: number;
}

/** Per-level outcome of the gate evaluation. */
export type ApprovalLevelState =
  | "SATISFIED" // quorum met among unexpired APPROVED decisions
  | "PENDING" // quorum never met (nothing to decide, or not enough)
  | "EXPIRED" // quorum met historically but validity lapsed
  | "REJECTED" // at least one REJECTED decision — cycle over
  | "NOT_REQUIRED" // policy-exempt level
  | "UNBINDABLE"; // legacy shape: APPROVED cached status with zero bindable
// decisions (pre-POL data) — re-approval required, execution refused.

export interface ApprovalLevelVerdict {
  level: string;
  state: ApprovalLevelState;
  quorumRequired: number;
  /** DISTINCT approvers counted toward the quorum (unexpired APPROVED). */
  distinctApprovers: number;
  /** Total distinct approvers across ALL APPROVED decisions (any expiry). */
  distinctApproversEver: number;
  /** The validity horizon of the quorum-counting decisions (min — the
   * quorum is only as fresh as its shortest-lived approval). */
  earliestExpiry: Date | null;
}

export type ApprovalGateVerdictState =
  | "SATISFIED"
  | "PENDING"
  | "EXPIRED"
  | "REJECTED"
  | "UNBINDABLE";

export interface ApprovalGateVerdict {
  state: ApprovalGateVerdictState;
  levels: ApprovalLevelVerdict[];
  /** Levels in the blocking state that matches the verdict. */
  blocking: string[];
}

/**
 * Decision-thinning: within one level, an approver may cast a new decision
 * only after their previous APPROVED decision expired (re-approval cycles).
 * Expired decisions stay in the table as history but never count. The
 * evaluator therefore works on the decisions as-given and lets callers pass
 * every row.
 */

function isUnexpired(decision: ApprovalDecisionInput, now: Date): boolean {
  if (decision.decision !== "APPROVED") return false;
  // Fail-closed on missing horizon: an APPROVED decision without an expiry
  // cannot be age-verified, so it does not count (UNBINDABLE_DECISION —
  // surfaced via the level state by the caller when quorum fails).
  if (!decision.expiresAt) return false;
  return decision.expiresAt.getTime() > now.getTime();
}

/**
 * The single gate evaluator. Deterministic and pure: same rows/decisions/
 * now always yield the same verdict.
 *
 * Verdict precedence (documented, greppable):
 *   REJECTED  > UNBINDABLE > EXPIRED > PENDING > SATISFIED
 * (a rejection ends the cycle outright; unbindable/legacy data refuses
 * closed before expiry messaging, which itself precedes "still waiting").
 */
export function evaluateApprovalGate(input: {
  rows: ApprovalRowInput[];
  decisionsByApprovalId: Record<string, ApprovalDecisionInput[]>;
  now: Date;
}): ApprovalGateVerdict {
  const { rows, decisionsByApprovalId, now } = input;

  const levels: ApprovalLevelVerdict[] = rows.map((row) => {
    if (row.status === "NOT_REQUIRED") {
      return {
        level: row.level,
        state: "NOT_REQUIRED",
        quorumRequired: row.quorumRequired,
        distinctApprovers: 0,
        distinctApproversEver: 0,
        earliestExpiry: null,
      };
    }

    const decisions = decisionsByApprovalId[row.id] ?? [];
    const rejected = decisions.some((d) => d.decision === "REJECTED");

    const unexpiredApprovers = new Set<string>();
    const everApprovers = new Set<string>();
    let earliestExpiry: Date | null = null;
    let hasApprovedDecision = false;
    let hasUnbindableApproved = false;

    for (const decision of decisions) {
      if (decision.decision !== "APPROVED") continue;
      hasApprovedDecision = true;
      if (decision.approverId) everApprovers.add(decision.approverId);
      if (!decision.expiresAt) {
        // APPROVED with no horizon: cannot be age-verified → never counts.
        hasUnbindableApproved = true;
        continue;
      }
      if (decision.expiresAt.getTime() > now.getTime()) {
        if (decision.approverId) unexpiredApprovers.add(decision.approverId);
        if (!earliestExpiry || decision.expiresAt < earliestExpiry) {
          earliestExpiry = decision.expiresAt;
        }
      }
    }

    const distinct = unexpiredApprovers.size;
    const ever = everApprovers.size;
    const quorum = row.quorumRequired;

    let state: ApprovalLevelState;
    if (rejected) {
      state = "REJECTED";
    } else if (distinct >= quorum) {
      state = "SATISFIED";
    } else if (ever >= quorum || hasUnbindableApproved) {
      // Quorum existed among APPROVED decisions but no longer holds among
      // unexpired ones (validity lapsed), or the only approvals carry no
      // verifiable horizon (legacy/unbindable). Distinguish the two so the
      // execute gate can refuse with the truthful code.
      state = ever >= quorum && !hasUnbindableApproved ? "EXPIRED" : "UNBINDABLE";
    } else if (hasApprovedDecision) {
      // Some approvals exist but quorum has never been reached.
      state = "PENDING";
    } else {
      state = row.status === "APPROVED" ? "UNBINDABLE" : "PENDING";
    }

    return {
      level: row.level,
      state,
      quorumRequired: quorum,
      distinctApprovers: distinct,
      distinctApproversEver: ever,
      earliestExpiry,
    };
  });

  const blockingFor = (state: ApprovalLevelState) =>
    levels.filter((l) => l.state === state).map((l) => l.level);

  const rejectedLevels = blockingFor("REJECTED");
  const unbindableLevels = blockingFor("UNBINDABLE");
  const expiredLevels = blockingFor("EXPIRED");
  const pendingLevels = blockingFor("PENDING");

  const state: ApprovalGateVerdictState = rejectedLevels.length
    ? "REJECTED"
    : unbindableLevels.length
      ? "UNBINDABLE"
      : expiredLevels.length
        ? "EXPIRED"
        : pendingLevels.length
          ? "PENDING"
          : "SATISFIED";

  const blocking =
    state === "REJECTED"
      ? rejectedLevels
      : state === "UNBINDABLE"
        ? unbindableLevels
        : state === "EXPIRED"
          ? expiredLevels
          : state === "PENDING"
            ? pendingLevels
            : [];

  return { state, levels, blocking };
}

/**
 * POL-002 verification: among the decisions that COUNT toward the quorum
 * (unexpired APPROVED), every fingerprint must equal the change's CURRENT
 * spec fingerprint. Returns the offending levels (greppable — shared
 * APPROVAL_FINGERPRINT_UNBINDABLE prefix is prepended by the caller when
 * composing error copy).
 */
export function fingerprintMismatches(
  verdict: ApprovalGateVerdict,
  rows: ApprovalRowInput[],
  decisionsByApprovalId: Record<string, ApprovalDecisionInput[]>,
  now: Date,
  expectedFingerprint: string
): string[] {
  const offenders = new Set<string>();
  for (const levelVerdict of verdict.levels) {
    if (levelVerdict.state !== "SATISFIED") continue;
    const row = rows.find((r) => r.id === levelVerdict.level || r.level === levelVerdict.level);
    if (!row) continue;
    for (const decision of decisionsByApprovalId[row.id] ?? []) {
      if (!isUnexpired(decision, now)) continue;
      if (decision.fingerprint !== expectedFingerprint) {
        offenders.add(row.level);
        break;
      }
    }
  }
  return Array.from(offenders).sort();
}

/**
 * Re-cast guard (POL-003 re-approval loop): an approver may cast a decision
 * on a level while NONE of their existing decisions on that level is still
 * unexpired. Expired decisions may be superseded; live ones may not
 * (prevents quorum inflation by repeat casting).
 */
export function canCastDecision(
  existingDecisions: Array<{
    decision: string;
    approverId?: string | null;
    expiresAt: Date | null;
  }>,
  approverId: string,
  now: Date
): boolean {
  return !existingDecisions.some(
    (d) =>
      d.approverId === approverId &&
      (d.decision === "REJECTED" || (d.expiresAt !== null && d.expiresAt.getTime() > now.getTime()))
  );
}

/** Greppable shared prefix for the bindable-approval refusal family. */
export const APPROVALS_UNBINDABLE = "APPROVALS_UNBINDABLE";
