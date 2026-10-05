import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import { isSodViolation } from "../../../_lib/actor";
import {
  authErrorToFail,
  actorIsWildcard,
  requireApprovalEntitlement,
  requireSiteScope,
} from "@/lib/auth/session";
import { loadApprovalGate } from "@/lib/change/approval-gate";
import {
  requireDeviceLegScope,
  resolveChangeScopeTarget,
} from "../../../_lib/change-scope";
import {
  APPROVALS_UNBINDABLE,
  approvalExpiryFor,
  canCastDecision,
} from "@/lib/change/approval-policy";
import { APPROVAL_FINGERPRINT_UNBINDABLE } from "@/lib/change/fingerprint";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/changes/[id]/approvals — record a bindable approval decision
 * (4-b; POL-001/002/003 — external ULTRA audit P1-001/P1-002 closeout).
 *
 * Body: { level, decision: "APPROVED"|"REJECTED", comment? }
 *
 * The decision is a first-class bindable record (ChangeApprovalDecision):
 *   - POL-002 — it carries the SHA-256 fingerprint of the canonical approved
 *     spec AS SEEN at decision time; the gate refuses to complete while any
 *     quorum-counting decision disagrees with the CURRENT spec
 *     (APPROVAL_FINGERPRINT_MISMATCH — an approval authorizes exactly the
 *     spec it saw);
 *   - POL-003 — APPROVED decisions carry a risk-tiered validity horizon
 *     (approvalExpiryFor); expired decisions stop counting toward the
 *     quorum and may be superseded by a fresh cast from the same approver;
 *   - POL-001 — a level is satisfied when DISTINCT approvers reach the
 *     level's quorum (CAB on CRITICAL changes requires TWO distinct
 *     approvers; one principal can never fill two slots, wildcard or not).
 *
 * Guards (in order):
 *   404 CHANGE_NOT_FOUND / APPROVAL_NOT_FOUND — change or (changeId, level)
 *     row missing;
 *   409 ALREADY_DECIDED — the level's cached status is terminal REJECTED
 *     (the change ended this cycle);
 *   409 INVALID_STATE — the change is not AWAITING_APPROVAL;
 *   401 UNAUTHENTICATED — no valid session (actor = session principal; P19);
 *   403 RBAC_FORBIDDEN — the session role lacks the level-specific
 *     entitlement (Phase 19-C / audit AUTHZ-101A: TECHNICAL →
 *     change.approve.technical, SECURITY → .security, MANAGER → .manager,
 *     CAB → .cab; manager = technical+manager+cab, security is
 *     admin-wildcard only);
 *   403 SOD_VIOLATION — separation of duties, two forms:
 *     (a) the requester cannot approve their own HIGH/CRITICAL change
 *         (MEDIUM/LOW self-approval is allowed and flagged selfApproval);
 *     (b) the same principal cannot decide TWO DIFFERENT levels on one
 *         change (across ALL their decisions, any expiry) unless they hold
 *         the admin wildcard — one principal cannot satisfy multiple
 *         independent levels;
 *   403 SITE_SCOPE_FORBIDDEN — wave 10 (F-031, audit 13-b F-2): the
 *     change's site dimension (site relation, or EVERY linked device for a
 *     site-less change) must be inside the session's scope before any
 *     decision is recorded; a wildcard session is byte-unchanged.
 *   409 DECISION_STILL_VALID — the approver already holds a live (unexpired)
 *     decision on this level; re-casting is only for the post-expiry
 *     re-approval loop (quorum inflation guard).
 *
 * On success (single short transaction):
 *   - ChangeApprovalDecision INSERT (fingerprint + expiry stamped);
 *   - ChangeApproval cached mirror refreshed + ALL level statuses
 *     re-derived from the gate evaluator (single source of truth);
 *   - gate complete → changeRequest.approvalFingerprint = current spec
 *     fingerprint + change APPROVED + CHANGE_APPROVED audit; any REJECTED
 *     → change REJECTED + CHANGE_REJECTED audit;
 *   - CHANGE_APPROVED / CHANGE_REJECTED per-decision audit (correlationId).
 *
 * Returns { change, quorum per-level verdicts, selfApproval, audit }.
 */

const ID_MAX = 64;

const decisionSchema = z.object({
  level: z.enum(["TECHNICAL", "SECURITY", "MANAGER", "CAB"]),
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: z.string().trim().max(1000).optional(),
});

/** Typed failure thrown inside the tx when bindings disagree at completion. */
class FingerprintMismatchError extends Error {
  constructor(public readonly levels: string[]) {
    super(
      `${APPROVAL_FINGERPRINT_UNBINDABLE}: quorum-counting approvals on ${levels.join(", ")} were cast against a different approved spec — the change's devices, operations, restore target or schedule moved after the decisions were recorded. Re-approval is required.`
    );
    this.name = "FingerprintMismatchError";
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid change id", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { level, decision, comment } = parsed.data;

  // Phase 19-C (audit AUTHZ-101A): the approval decision is a privileged
  // act — the permission gate comes FIRST (before any resource lookup, so
  // unauthorized callers learn nothing about change existence).
  let actor: Awaited<ReturnType<typeof requireApprovalEntitlement>>;
  try {
    actor = await requireApprovalEntitlement(request, level);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const change = await db.changeRequest.findUnique({
    where: { id },
    select: {
      id: true,
      number: true,
      status: true,
      riskLevel: true,
      requesterId: true,
    },
  });
  if (!change) {
    return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
  }

  // F-2 (wave 10, audit 13-b): the change's site dimension must be inside
  // the session's scope before any decision is recorded — the gate sits
  // before the SoD/state checks so out-of-scope callers learn nothing
  // about the change's approval state. Site-less changes ride their
  // linked devices (ALL in scope); no site and no devices is the
  // documented unscoped-resource bypass.
  const scopeTarget = await resolveChangeScopeTarget(change.id);
  if (scopeTarget.kind === "missing") {
    return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
  }
  if (scopeTarget.kind === "site") {
    try {
      await requireSiteScope(request, scopeTarget.code);
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
  } else if (scopeTarget.kind === "devices") {
    const deviceLegFail = await requireDeviceLegScope(request, scopeTarget.deviceIds);
    if (deviceLegFail) return deviceLegFail;
  }

  // Separation of duties (server-authoritative — the UI disables the
  // button as a pre-check only).
  if (isSodViolation(change.riskLevel, change.requesterId, actor.id)) {
    return fail(
      "SOD_VIOLATION",
      `Separation of duties: the requester cannot approve a ${change.riskLevel} change. Switch the acting user to decide this level.`,
      403
    );
  }

  const approval = await db.changeApproval.findUnique({
    where: { changeId_level: { changeId: change.id, level } },
  });
  if (!approval) {
    return fail(
      "APPROVAL_NOT_FOUND",
      `No ${level} approval row exists for this change (required levels follow the risk policy)`,
      404
    );
  }
  if (approval.status === "REJECTED") {
    return fail(
      "ALREADY_DECIDED",
      `The ${level} approval was already decided (REJECTED) — the change cycle is over`,
      409
    );
  }
  if (change.status !== "AWAITING_APPROVAL") {
    return fail(
      "INVALID_STATE",
      `Approvals can only be decided while the change is AWAITING_APPROVAL — this change is ${change.status}`,
      409
    );
  }

  const now = new Date();

  // Separation of duties, second form (Phase 19-C / audit acceptance test
  // "same principal cannot satisfy multiple independent approval levels"):
  // one approver may not decide two distinct levels of the same change —
  // across ALL their decisions (any expiry — the binding is for the
  // change's lifetime) — admin wildcard holders are the documented policy
  // exception.
  const earlierDecision = await db.changeApprovalDecision.findFirst({
    where: {
      approverId: actor.id,
      approval: { changeId: change.id, level: { not: level } },
    },
    select: { approval: { select: { level: true } } },
    orderBy: { decidedAt: "desc" },
  });
  if (earlierDecision && !(await actorIsWildcard(actor.id))) {
    return fail(
      "SOD_VIOLATION",
      `Separation of duties: ${actor.name ?? "this approver"} already decided the ${earlierDecision.approval.level} level of this change — independent approvers are required for the remaining levels.`,
      403
    );
  }

  // POL-003 re-cast guard: a live (unexpired) decision by this approver on
  // THIS level blocks a second cast; expired history may be superseded.
  const myDecisions = await db.changeApprovalDecision.findMany({
    where: { approvalId: approval.id, approverId: actor.id },
    select: { decision: true, approverId: true, expiresAt: true },
  });
  if (!canCastDecision(myDecisions, actor.id, now)) {
    return fail(
      "DECISION_STILL_VALID",
      `${actor.name ?? "This approver"} already holds a live decision on the ${level} level of this change — re-casting is only possible after the approval expires (fresh approval cycle).`,
      409
    );
  }

  const correlationId = newCorrelationId("APR");
  const actorLabel = actor.name ?? "Acting user";
  const selfApproval = actor.id === change.requesterId;
  const expiresAt = approvalExpiryFor(
    change.riskLevel,
    decision,
    now
  );

  let result: {
    changeStatus: string;
    fingerprint: string;
    quorum: Array<{
      level: string;
      state: string;
      distinctApprovers: number;
      quorumRequired: number;
      earliestExpiry: Date | null;
    }>;
  };
  try {
    result = await db.$transaction(
      async (tx) => {
      // Current canonical spec fingerprint (POL-002) — computed INSIDE the
      // transaction so the recorded binding cannot race a spec change.
      const gate = await loadApprovalGate(change.id, now, tx);
      if (!gate) {
        throw new Error("CHANGE_NOT_FOUND");
      }

      const fingerprint = gate.currentFingerprint;

      await tx.changeApprovalDecision.create({
        data: {
          approvalId: approval.id,
          approverId: actor.id,
          approverName: actorLabel,
          decision,
          fingerprint,
          decidedAt: now,
          expiresAt,
          comment: comment ?? null,
        },
      });

      // Cached mirror (latest decision) for pre-POL readers.
      await tx.changeApproval.update({
        where: { id: approval.id },
        data: {
          status: decision,
          approverId: actor.id,
          decidedAt: now,
          comment: comment ?? null,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actorLabel,
          action: decision === "APPROVED" ? "CHANGE_APPROVED" : "CHANGE_REJECTED",
          resourceType: "ChangeApprovalDecision",
          resourceId: `${change.id}:${level}`,
          resourceLabel: `${change.number} — ${level}`,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            level,
            decision,
            approver: actorLabel,
            comment: comment ?? null,
            fingerprint,
            expiresAt,
            bindable: "POL-001/002/003",
          }),
        },
      });

      // Re-evaluate the WHOLE gate from the decisions (single source of
      // truth) and re-derive every level's cached status.
      const reloaded = await loadApprovalGate(change.id, now, tx);
      if (!reloaded) {
        throw new Error("CHANGE_NOT_FOUND");
      }
      const verdict = reloaded.verdict;

      for (const levelVerdict of verdict.levels) {
        const row = reloaded.rows.find((r) => r.level === levelVerdict.level);
        if (!row) continue;
        const derived =
          levelVerdict.state === "SATISFIED"
            ? "APPROVED"
            : levelVerdict.state === "REJECTED"
              ? "REJECTED"
              : levelVerdict.state === "NOT_REQUIRED"
                ? "NOT_REQUIRED"
                : "PENDING";
        await tx.changeApproval.update({
          where: { id: row.id },
          data: { status: derived },
        });
      }

      // Gate transition on the change itself.
      let changeStatus = change.status;
      if (verdict.state === "REJECTED") {
        changeStatus = "REJECTED";
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "REJECTED" },
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actorLabel,
            action: "CHANGE_REJECTED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "SUCCESS",
            correlationId,
            beforeJson: JSON.stringify({ status: change.status }),
            afterJson: JSON.stringify({ status: "REJECTED", by: actorLabel, level }),
          },
        });
      } else if (verdict.state === "SATISFIED") {
        // POL-002 completion gate: every quorum-counting decision must
        // carry the CURRENT fingerprint. A mismatch fails the whole
        // decision tx closed — nothing is recorded, the change stays
        // AWAITING_APPROVAL, and the approvers must re-decide.
        if (reloaded.mismatchedLevels.length > 0) {
          throw new FingerprintMismatchError(reloaded.mismatchedLevels);
        }
        changeStatus = "APPROVED";
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "APPROVED", approvalFingerprint: reloaded.currentFingerprint },
        });
        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actorLabel,
            action: "CHANGE_APPROVED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "SUCCESS",
            correlationId,
            beforeJson: JSON.stringify({ status: change.status }),
            afterJson: JSON.stringify({
              status: "APPROVED",
              by: actorLabel,
              levels: verdict.levels.map((l) => l.level),
              quorum: verdict.levels.map((l) => ({
                level: l.level,
                distinctApprovers: l.distinctApprovers,
                quorumRequired: l.quorumRequired,
              })),
              approvalFingerprint: reloaded.currentFingerprint,
            }),
          },
        });
      }

      return {
        changeStatus,
        fingerprint,
        quorum: verdict.levels
          .map((l) => ({
            level: l.level,
            state: l.state,
            distinctApprovers: l.distinctApprovers,
            quorumRequired: l.quorumRequired,
            earliestExpiry: l.earliestExpiry,
          }))
          .sort((a, b) => a.level.localeCompare(b.level)),
      };
    },
      { maxWait: 5_000, timeout: 20_000 }
    );
  } catch (error) {
    if (error instanceof FingerprintMismatchError) {
      return fail("APPROVAL_FINGERPRINT_MISMATCH", error.message, 409);
    }
    throw error;
  }

  return ok({
    change: {
      id: change.id,
      number: change.number,
      status: result.changeStatus,
      riskLevel: change.riskLevel,
    },
    decision: {
      level,
      decision,
      approver: actorLabel,
      decidedAt: now,
      expiresAt,
      fingerprint: result.fingerprint,
    },
    quorum: result.quorum,
    selfApproval,
    audit: {
      action: decision === "APPROVED" ? "CHANGE_APPROVED" : "CHANGE_REJECTED",
      correlationId,
    },
    message: `${level} approval ${decision.toLowerCase()} by ${actorLabel}.`,
  });
}
