import { db } from "@/lib/db";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../../_lib/api";
import {
  REPORT_FORMATS,
  REPORT_FREQUENCIES,
  REPORT_TYPES,
} from "@/lib/reports/generate";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/reports/schedules/[id]/run — "Run now" (Task 9-a).
 *
 * Queues a REPORT_RUN JobExecution for the schedule (status QUEUED) and
 * returns the job id + correlationId. The worker (:3030) claims it within
 * ~3 s and drives /api/v1/reports/execute (evaluate-in-Next), which
 * generates the artifact, stores it in the job's resultJson and flips the
 * job SUCCEEDED. The whole chain shares one REP-XXXXXX correlation id
 * (queue audit → job row → generation audit).
 *
 * A second run-now while a run for the same schedule is still QUEUED or
 * RUNNING answers 409 RUN_ALREADY_IN_FLIGHT (dedupe guard — the runs
 * history stays one-row-per-run).
 *
 * Audited REPORT_SCHEDULE_RUN_QUEUED. 404 SCHEDULE_NOT_FOUND.
 */

const ID_MAX = 64;

// The route must accept only the report-relevant enum values — mirrors the
// create schema so a stale client cannot queue a run with an unknown type.
const runParamsSchema = z.object({
  reportType: z.enum(REPORT_TYPES).optional(),
  frequency: z.enum(REPORT_FREQUENCIES).optional(),
  format: z.enum(REPORT_FORMATS).optional(),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Phase 19-C (audit AUTHZ-001 sweep): run-now requires the
  // "report.schedule" permission (was authentication-only via requireUser).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "report.schedule");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }

  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid schedule id", 400);
  }

  // Body is optional — a run-now POST carries no payload in the UI. Any
  // provided overrides are validated but ignored beyond the audit record
  // (the schedule row stays the single source of truth).
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const overrides = runParamsSchema.safeParse(body ?? {});
  if (!overrides.success) {
    return fail("INVALID_BODY", firstIssueMessage(overrides.error), 400);
  }

  const schedule = await db.reportSchedule.findUnique({ where: { id } });
  if (!schedule) {
    return fail("SCHEDULE_NOT_FOUND", "Report schedule not found", 404);
  }

  const inFlight = await db.jobExecution.findFirst({
    where: {
      type: "REPORT_RUN",
      status: { in: ["QUEUED", "RUNNING"] },
      OR: [{ targetId: schedule.id }, { payloadJson: { contains: schedule.id } }],
    },
    select: { id: true, status: true, correlationId: true },
  });
  if (inFlight) {
    return fail(
      "RUN_ALREADY_IN_FLIGHT",
      `A run for this schedule is already ${inFlight.status} (${inFlight.correlationId})`,
      409
    );
  }

  const correlationId = newCorrelationId("REP");
  const payload = {
    scheduleId: schedule.id,
    scheduleName: schedule.name,
    reportType: schedule.reportType,
    frequency: schedule.frequency,
    format: schedule.format,
    triggeredBy: "MANUAL",
  };

  const job = await db.jobExecution.create({
    data: {
      type: "REPORT_RUN",
      targetType: "REPORT_SCHEDULE",
      targetId: schedule.id,
      status: "QUEUED",
      progress: 0,
      priority: 5,
      maxAttempts: 3,
      payloadJson: JSON.stringify(payload),
      correlationId,
    },
  });

  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? actor.email,
      action: "REPORT_SCHEDULE_RUN_QUEUED",
      resourceType: "REPORT_SCHEDULE",
      resourceId: schedule.id,
      resourceLabel: schedule.name,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        jobId: job.id,
        reportType: schedule.reportType,
        frequency: schedule.frequency,
        format: schedule.format,
        recipients: overrides.success ? overrides.data : undefined,
        triggeredBy: "MANUAL",
      }),
    },
  });

  return ok(
    {
      job: {
        id: job.id,
        type: job.type,
        status: job.status,
        correlationId: job.correlationId,
        createdAt: job.createdAt.toISOString(),
      },
      schedule: { id: schedule.id, name: schedule.name },
      audit: { correlationId },
    },
    { correlationId },
    201
  );
}
