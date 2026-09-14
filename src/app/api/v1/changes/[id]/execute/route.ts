import { db } from "@/lib/db";
import { fail, failWithDetail, firstIssueMessage, newJobCorrelationId, ok } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import {
  ExecutionInFlightError,
  executionLeaseExpiry,
  isUniqueConflict,
} from "@/lib/change/execution-guard";
import { loadApprovalGate } from "@/lib/change/approval-gate";
import { APPROVAL_FINGERPRINT_UNBINDABLE } from "@/lib/change/fingerprint";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/changes/[id]/execute — queue a change execution (Task 4-b).
 *
 * Body: { failAt?: "APPLY"|"VALIDATE"|null }
 *   failAt is the DEMO-ONLY control rendered as "Simulate failure at" in the
 *   execute dialog — it forces the engine down its rollback path.
 *
 * Guards:
 *   404 CHANGE_NOT_FOUND / 400 ACTOR_NOT_FOUND;
 *   409 INVALID_STATE — only APPROVED | SCHEDULED changes can be executed;
 *   409 APPROVALS_PENDING — the bindable approval gate (POL-001/002/003) is
 *     not yet satisfied: every level needs its quorum of DISTINCT approvers
 *     (CAB on CRITICAL changes: TWO distinct approvers);
 *   409 APPROVAL_EXPIRED — the gate WAS satisfied but quorum-counting
 *     decisions have passed their validity horizon (POL-003). Fail-closed:
 *     the change is flipped back to AWAITING_APPROVAL in the same
 *     transaction (CHANGE_APPROVALS_INVALIDATED audit) and a fresh approval
 *     cycle is required;
 *   409 APPROVALS_REBIND_REQUIRED — the gate carries pre-POL data (APPROVED
 *     rows with no bindable decisions / approvals without verifiable
 *     horizons). Fail-closed flip identical to the expiry path — re-approval
 *     under the bindable model is required (never a silent bypass);
 *   409 APPROVAL_FINGERPRINT_MISMATCH — POL-002: the change's CURRENT spec
 *     (devices, operations, restore target, schedule) does not hash to the
 *     approval fingerprint the gate was satisfied against — the approval
 *     authorizes exactly the spec it saw, so execution refuses (audit
 *     CHANGE_EXECUTE_FINGERPRINT_MISMATCH);
 *   409 EXECUTION_IN_FLIGHT — SAFE-003 single-flight: the change already
 *     carries a QUEUED/RUNNING CHANGE_EXECUTE job (a DB-enforced execution
 *     lease — the PK IS the lock — so even two racing POSTs can never both
 *     queue; the loser's whole transaction rolls back);
 *   403 RBAC_FORBIDDEN — Phase 19-C (audit AUTHZ-101B): queueing an
 *     execution requires the "change.execute" permission (engineer; admin
 *     via wildcard). Once real adapters land this is the direct
 *     production network-control gate.
 *
 * Creates a QUEUED JobExecution (type CHANGE_EXECUTE, targetType CHANGE,
 * targetId = change.id, payloadJson { failAt, triggerUserId })
 * + a CHANGE_EXECUTION_QUEUED audit event. The change status stays untouched
 * until the worker claims the job and the step executor drives the state
 * machine (PRE_CHECK → EXECUTING → VALIDATING → SUCCESSFUL / ROLLBACK…).
 *
 * Transaction order (SAFE-003 + POL): approval-gate evaluation (refusal
 * flips commit; everything is atomic with the queueing) → job INSERT →
 * lease INSERT → step injection → audit. The lease INSERT is the
 * serialization point — its P2002 fires before any step row or audit event
 * exists, and the losing transaction rolls back its job row too, leaving
 * exactly one execution behind.
 */
const ID_MAX = 64;

const executeSchema = z.object({
  failAt: z.enum(["APPLY", "VALIDATE"]).nullable().optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid change id", 400);
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = executeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { failAt } = parsed.data;

  // Phase 19-C (audit AUTHZ-101B): executions are permission-gated FIRST —
  // change.execute (engineer; admin wildcard) — before any resource lookup
  // so unauthorized callers learn nothing about change existence.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "change.execute");
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
      title: true,
      status: true,
      riskLevel: true,
      _count: { select: { steps: true } },
    },
  });
  if (!change) {
    return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404);
  }
  if (!["APPROVED", "SCHEDULED"].includes(change.status)) {
    return fail(
      "INVALID_STATE",
      `Only APPROVED or SCHEDULED changes can be executed — this change is ${change.status}`,
      409
    );
  }

  const correlationId = newJobCorrelationId();
  const now = new Date();

  /** The refusal payload produced inside the gate section of the tx. */
  type GateRefusal = {
    code: string;
    message: string;
    detail?: Record<string, unknown>;
  };

  // SAFE-003 + POL — gate evaluation, job creation, lease acquisition, step
  // injection and audit all happen in ONE transaction; the lease INSERT
  // (PK = changeId) is the DB-enforced single-flight serialization point.
  // Refusal paths that MUTATE state (expiry/rebind flips, fingerprint
  // audit) commit deliberately — fail-closed is still durable truth.
  let jobId: string;
  try {
    const result = await db.$transaction(
      async (tx) => {
        // ── Bindable approval gate (POL-001/002/003) ──────────────────────
        const gate = await loadApprovalGate(change.id, now, tx);
        if (!gate) {
          return fail("CHANGE_NOT_FOUND", "The requested change does not exist", 404) as never;
        }

        const verdict = gate.verdict;

        if (verdict.state !== "SATISFIED") {
          if (verdict.state === "EXPIRED" || verdict.state === "UNBINDABLE") {
            // Fail-closed flip: the approval gate no longer holds (validity
            // lapsed / pre-POL data) — return the change to
            // AWAITING_APPROVAL and re-open every non-terminal level. The
            // flip commits; the caller answers 409 with the truthful code.
            const reason = verdict.state === "EXPIRED" ? "EXPIRED" : "REBIND_REQUIRED";
            await tx.changeRequest.update({
              where: { id: change.id },
              data: { status: "AWAITING_APPROVAL", approvalFingerprint: null },
            });
            for (const level of verdict.levels) {
              const row = gate.rows.find((r) => r.level === level.level);
              if (!row || row.status === "NOT_REQUIRED" || row.status === "REJECTED") continue;
              await tx.changeApproval.update({
                where: { id: row.id },
                data: { status: "PENDING" },
              });
            }
            await tx.auditEvent.create({
              data: {
                actorId: actor.id,
                actorName: actor.name ?? "Acting user",
                action: "CHANGE_APPROVALS_INVALIDATED",
                resourceType: "ChangeRequest",
                resourceId: change.id,
                resourceLabel: change.number,
                result: "SUCCESS",
                correlationId,
                beforeJson: JSON.stringify({ status: change.status }),
                afterJson: JSON.stringify({
                  status: "AWAITING_APPROVAL",
                  reason,
                  levels: verdict.blocking,
                  riskLevel: change.riskLevel,
                  policy: "POL-001/002/003",
                }),
              },
            });
            const refusal: GateRefusal =
              verdict.state === "EXPIRED"
                ? {
                    code: "APPROVAL_EXPIRED",
                    message: `Approval validity lapsed on ${verdict.blocking.join(", ")} — approvals expire by risk policy (POL-003). The change returned to AWAITING_APPROVAL for a fresh approval cycle.`,
                    detail: {
                      expiredLevels: verdict.blocking,
                      levels: verdict.levels.map((l) => ({
                        level: l.level,
                        state: l.state,
                        earliestExpiry: l.earliestExpiry,
                      })),
                    },
                  }
                : {
                    code: "APPROVALS_REBIND_REQUIRED",
                    message: `The approval gate on ${verdict.blocking.join(", ")} carries pre-POL data (approvals without bindable decisions or verifiable validity) — re-approval under the bindable model is required (POL-001/002/003). The change returned to AWAITING_APPROVAL.`,
                    detail: { unbindableLevels: verdict.blocking },
                  };
            return { refusal };
          }
          // PENDING (and defensive REJECTED) — plain refusal, no mutation.
          const refusal: GateRefusal =
            verdict.state === "PENDING"
              ? {
                  code: "APPROVALS_PENDING",
                  message: `Approvals still pending: ${verdict.blocking.join(", ")} — decide them (quorum of distinct approvers per level) before executing`,
                  detail: { pendingLevels: verdict.blocking },
                }
              : {
                  code: "INVALID_STATE",
                  message: `The approval gate is REJECTED on ${verdict.blocking.join(", ")} — the change cycle is over`,
                };
          return { refusal };
        }

        // POL-002 — the gate is satisfied; verify the binding. Both the
        // change-level stamp AND every quorum-counting decision must hash
        // to the CURRENT spec fingerprint.
        const stampDrift =
          gate.change.approvalFingerprint !== gate.currentFingerprint;
        if (stampDrift || gate.mismatchedLevels.length > 0) {
          await tx.auditEvent.create({
            data: {
              actorId: actor.id,
              actorName: actor.name ?? "Acting user",
              action: "CHANGE_EXECUTE_FINGERPRINT_MISMATCH",
              resourceType: "ChangeRequest",
              resourceId: change.id,
              resourceLabel: change.number,
              result: "FAILURE",
              correlationId,
              afterJson: JSON.stringify({
                expected: gate.change.approvalFingerprint,
                current: gate.currentFingerprint,
                mismatchedLevels: gate.mismatchedLevels,
                policy: "POL-002",
              }),
            },
          });
          const refusal: GateRefusal = {
            code: "APPROVAL_FINGERPRINT_MISMATCH",
            message: `${APPROVAL_FINGERPRINT_UNBINDABLE}: the approved spec no longer matches the change's current devices, operations, restore target or schedule — the approval authorizes exactly the spec it saw (POL-002). Re-approval is required.`,
            detail: {
              expected: gate.change.approvalFingerprint,
              current: gate.currentFingerprint,
              mismatchedLevels: gate.mismatchedLevels,
            },
          };
          return { refusal };
        }

        // ── SAFE-003 single-flight queueing (unchanged contract) ─────────
        // Crash valve: a lease past its TTL may be taken over (its job could
        // never reach a terminal state — see the model docstring). Live
        // leases are never touched here.
        await tx.changeExecutionLease.deleteMany({
          where: { changeId: change.id, expiresAt: { lt: now } },
        });

        const job = await tx.jobExecution.create({
          data: {
            type: "CHANGE_EXECUTE",
            targetType: "CHANGE",
            targetId: change.id,
            status: "QUEUED",
            progress: 0,
            priority: 3,
            maxAttempts: 3,
            payloadJson: JSON.stringify({
              failAt: failAt ?? null,
              triggerUserId: actor.id,
              changeNumber: change.number,
              changeTitle: change.title,
            }),
            correlationId,
          },
        });

        // THE guard: a live lease for this change makes the unique violation
        // fire here — before any step row or audit event exists — aborting
        // this transaction (the fresh job row rolls back with it).
        try {
          await tx.changeExecutionLease.create({
            data: {
              changeId: change.id,
              jobId: job.id,
              acquiredAt: now,
              expiresAt: executionLeaseExpiry(now),
            },
          });
        } catch (error) {
          if (isUniqueConflict(error)) {
            throw new ExecutionInFlightError(change.number);
          }
          throw error;
        }

        // Stepless changes (some seeded rows ship without a plan): inject the
        // standard 5-step execution plan so the engine has real work to drive
        // and the timeline is meaningful. Changes authored via the wizard or
        // the restore flow already carry their steps. Injection runs AFTER
        // the fingerprint verification — the approved intent is the pre-
        // injection spec, and injected default steps are engine-owned.
        if (change._count.steps === 0) {
          await tx.changeStep.createMany({
            data: [
              { changeId: change.id, order: 1, name: "Pre-change checks", type: "CHECK" },
              { changeId: change.id, order: 2, name: "Pre-change backup", type: "BACKUP" },
              { changeId: change.id, order: 3, name: "Apply configuration", type: "APPLY" },
              { changeId: change.id, order: 4, name: "Post-change validation", type: "VALIDATE" },
              { changeId: change.id, order: 5, name: "Post-change backup", type: "BACKUP" },
            ],
          });
        }

        await tx.auditEvent.create({
          data: {
            actorId: actor.id,
            actorName: actor.name ?? "Acting user",
            action: "CHANGE_EXECUTION_QUEUED",
            resourceType: "ChangeRequest",
            resourceId: change.id,
            resourceLabel: change.number,
            result: "SUCCESS",
            correlationId,
            afterJson: JSON.stringify({
              jobId: job.id,
              failAt: failAt ?? null,
              riskLevel: change.riskLevel,
              singleFlight: "lease-acquired",
              approvalFingerprint: gate.currentFingerprint,
            }),
          },
        });

        return { job };
      },
      { maxWait: 5_000, timeout: 20_000 }
    );

    if ("refusal" in result && result.refusal) {
      const refusal = result.refusal as GateRefusal;
      return failWithDetail(
        refusal.code,
        refusal.message,
        409,
        refusal.detail
      );
    }
    jobId = (result as { job: { id: string } }).job.id;
  } catch (error) {
    if (error instanceof ExecutionInFlightError) {
      // Name the execution that holds the lease so the operator can follow
      // it instead of fighting it (the winner's tx has committed by now —
      // the unique violation only fires after the holder's row is visible).
      const active = await db.jobExecution.findFirst({
        where: {
          type: "CHANGE_EXECUTE",
          targetType: "CHANGE",
          targetId: change.id,
          status: { in: ["QUEUED", "RUNNING"] },
        },
        orderBy: { createdAt: "desc" },
        select: { id: true, status: true, correlationId: true, createdAt: true },
      });
      return failWithDetail(
        error.code,
        active
          ? `${error.message} (active job ${active.id}, correlation ${active.correlationId})`
          : error.message,
        error.httpStatus,
        active
          ? { activeJob: { id: active.id, status: active.status, correlationId: active.correlationId } }
          : undefined
      );
    }
    throw error;
  }

  return ok(
    {
      job: {
        id: jobId,
        type: "CHANGE_EXECUTE",
        status: "QUEUED",
        correlationId,
      },
      change: {
        id: change.id,
        number: change.number,
        status: change.status,
      },
      message: `Execution queued for ${change.number} — follow the steps on this page or the Job Center (correlation ${correlationId}).`,
      audit: { action: "CHANGE_EXECUTION_QUEUED", correlationId },
    },
    undefined,
    201
  );
}
