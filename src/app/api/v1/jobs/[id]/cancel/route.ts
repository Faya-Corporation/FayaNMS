import { db } from "@/lib/db";
import {
  authErrorToFail,
  requirePermission,
  requireSiteScope,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionSiteScope } from "@/lib/auth/scope";
import {
  requireDeviceLegScope,
  resolveChangeScopeTarget,
} from "../../../_lib/change-scope";
import { fail, ok } from "../../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/jobs/[id]/cancel (Phase 9-b) — cancel a queued or running
 * job execution.
 *
 * Only QUEUED / RUNNING jobs are cancellable (the worker's complete()
 * handler already refuses to touch anything that is not RUNNING, so a
 * CANCELLED job can never be overwritten by a late completion).
 *
 * - 404 JOB_NOT_FOUND       — unknown id
 * - 409 JOB_NOT_CANCELLABLE — terminal status (SUCCEEDED/FAILED/DEAD/CANCELLED)
 * - 403 SITE_SCOPE_FORBIDDEN — wave 10 (F-031, audit 13-b F-4): the job's
 *     target must be inside the session's site scope before the
 *     cancellation (and its SAFE-003 lease release) mutates anything —
 *     DEVICE targets ride the device's site, CHANGE targets the change's
 *     site dimension (ALL linked devices for a site-less change); other
 *     target types are refused fail-closed for sites-limited sessions
 *     (they are invisible on the list plane too). Wildcard sessions are
 *     byte-unchanged.
 * - 200                     — status → CANCELLED + finishedAt, audited
 *                             JOB_CANCELLED (session actor + correlationId).
 *
 * Standard _lib envelope; session enforced (middleware + requirePermission).
 */

const CANCELLABLE_STATUSES = new Set(["QUEUED", "RUNNING"]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): cancelling a job requires the
  // "job.run" permission (was authentication-only via requireUser).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "job.run");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const job = await db.jobExecution.findUnique({ where: { id } });
  if (!job) {
    return fail(
      "JOB_NOT_FOUND",
      "The requested job execution does not exist",
      404
    );
  }

  // F-4 (wave 10, audit 13-b): the job's target must be inside the
  // session's site scope before the cancellation mutates anything
  // (releasing a SAFE-003 execution lease cross-scope is a real state
  // change). The gate engages for sites-limited sessions only; a wildcard
  // session is byte-unchanged.
  const scope = sessionSiteScope(await sessionScopeFor(request));
  if (scope.mode === "sites") {
    let siteCode: string | null = null;
    if (job.targetType === "DEVICE" && job.targetId) {
      const device = await db.device.findUnique({
        where: { id: job.targetId },
        select: { site: { select: { code: true } } },
      });
      // Unknown target ≡ unknown job for a sites-limited session (the
      // route's ordinary 404 shape — no target-existence oracle).
      if (!device) {
        return fail(
          "JOB_NOT_FOUND",
          "The requested job execution does not exist",
          404
        );
      }
      siteCode = device.site?.code ?? null;
    } else if (job.targetType === "CHANGE" && job.targetId) {
      const target = await resolveChangeScopeTarget(job.targetId);
      if (target.kind === "missing") {
        return fail(
          "JOB_NOT_FOUND",
          "The requested job execution does not exist",
          404
        );
      }
      if (target.kind === "site") siteCode = target.code;
      else if (target.kind === "devices") {
        const deviceLegFail = await requireDeviceLegScope(request, target.deviceIds);
        if (deviceLegFail) return deviceLegFail;
      }
      // target.kind === "unscoped" → no site dimension — the documented
      // assertSiteScope(null) bypass applies.
    } else {
      // SITE/POLICY/SYSTEM-targeted rows are invisible to sites-limited
      // sessions on the list plane — fail-closed parity here.
      return fail(
        "SITE_SCOPE_FORBIDDEN",
        "This session's site scope does not cover jobs without an in-scope device target.",
        403
      );
    }
    try {
      await requireSiteScope(request, siteCode);
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
  }

  if (!CANCELLABLE_STATUSES.has(job.status)) {
    return fail(
      "JOB_NOT_CANCELLABLE",
      `Job status is ${job.status} — only QUEUED or RUNNING jobs can be cancelled`,
      409
    );
  }

  const finishedAt = new Date();
  const actorName = actor.name ?? actor.email;

  const [, updated] = await db.$transaction([
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName,
        action: "JOB_CANCELLED",
        resourceType: job.targetType ?? "SYSTEM",
        resourceId: job.targetId ?? job.id,
        resourceLabel: job.correlationId,
        result: "SUCCESS",
        correlationId: job.correlationId,
        beforeJson: JSON.stringify({ id: job.id, status: job.status }),
        afterJson: JSON.stringify({ id: job.id, status: "CANCELLED" }),
      },
    }),
    db.jobExecution.update({
      where: { id },
      data: { status: "CANCELLED", finishedAt },
    }),
    // SAFE-003 — CANCELLED is a terminal state: release the change's
    // execution lease so the change can be deliberately executed again.
    db.changeExecutionLease.deleteMany({ where: { jobId: job.id } }),
  ]);

  return ok(
    { job: updated },
    { correlationId: updated.correlationId },
    200
  );
}
