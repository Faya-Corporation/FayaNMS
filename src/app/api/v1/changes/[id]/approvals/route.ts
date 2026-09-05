import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import { isSodViolation, resolveActingUser } from "../../../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/changes/[id]/approvals — record an approval decision (4-b).
 *
 * Body: { level, decision: "APPROVED"|"REJECTED", comment?, actAsUserId? }
 *
 * Guards (in order):
 *   404 CHANGE_NOT_FOUND / APPROVAL_NOT_FOUND — change or (changeId, level)
 *     row missing;
 *   409 ALREADY_DECIDED — the approval row is not PENDING;
 *   409 INVALID_STATE — the change is not AWAITING_APPROVAL;
 *   400 ACTOR_NOT_FOUND — actAsUserId does not resolve to a seeded user;
 *   403 SOD_VIOLATION — separation of duties: the requester cannot approve
 *     their own HIGH/CRITICAL change (MEDIUM/LOW self-approval is allowed
 *     and flagged selfApproval: true).
 *
 * On success (single short transaction):
 *   - approval row → decision (approverId/decidedAt/comment);
 *   - CHANGE_APPROVED / CHANGE_REJECTED audit (afterJson {level, decision,
 *     approver, comment}, correlationId);
 *   - gate re-evaluation: every level APPROVED (or NOT_REQUIRED) → change
 *     APPROVED + CHANGE_APPROVED audit (afterJson {by, levels}); any
 *     REJECTED → change REJECTED + CHANGE_REJECTED audit.
 *
 * Returns { change, approvals summary, selfApproval, audit }.
 */

const ID_MAX = 64;

const decisionSchema = z.object({
  level: z.enum(["TECHNICAL", "SECURITY", "MANAGER", "CAB"]),
  decision: z.enum(["APPROVED", "REJECTED"]),
  comment: z.string().trim().max(1000).optional(),
  actAsUserId: z.string().trim().max(64).optional(),
});

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

  const actor = await resolveActingUser(parsed.data.actAsUserId);
  if (!actor) {
    return fail(
      "ACTOR_NOT_FOUND",
      "actAsUserId does not match any active user — pick a user from the Act-as selector",
      400
    );
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
  if (approval.status !== "PENDING") {
    return fail(
      "ALREADY_DECIDED",
      `The ${level} approval was already decided (${approval.status})`,
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

  const correlationId = newCorrelationId("APR");
  const now = new Date();
  const actorLabel = actor.name ?? "Acting user";
  const selfApproval = actor.id === change.requesterId;

  const result = await db.$transaction(
    async (tx) => {
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
          resourceType: "ChangeApproval",
          resourceId: `${change.id}:${level}`,
          resourceLabel: `${change.number} — ${level}`,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            level,
            decision,
            approver: actorLabel,
            comment: comment ?? null,
          }),
        },
      });

      // Gate re-evaluation over every approval row of the change.
      const all = await tx.changeApproval.findMany({
        where: { changeId: change.id },
        select: { level: true, status: true },
      });
      const anyRejected = all.some((row) => row.status === "REJECTED");
      const allApproved = all.every(
        (row) => row.status === "APPROVED" || row.status === "NOT_REQUIRED"
      );

      let changeStatus = change.status;
      if (anyRejected) {
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
      } else if (allApproved) {
        changeStatus = "APPROVED";
        await tx.changeRequest.update({
          where: { id: change.id },
          data: { status: "APPROVED" },
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
            afterJson: JSON.stringify({ by: actorLabel, levels: all.map((row) => row.level) }),
          },
        });
      }

      return {
        changeStatus,
        levels: all
          .map((row) => ({ level: row.level, status: row.status }))
          .sort((a, b) => a.level.localeCompare(b.level)),
      };
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok({
    change: {
      id: change.id,
      number: change.number,
      status: result.changeStatus,
      riskLevel: change.riskLevel,
    },
    approvals: result.levels,
    selfApproval,
    audit: {
      action: decision === "APPROVED" ? "CHANGE_APPROVED" : "CHANGE_REJECTED",
      correlationId,
    },
    message: `${level} approval ${decision.toLowerCase()} by ${actorLabel}.`,
  });
}
