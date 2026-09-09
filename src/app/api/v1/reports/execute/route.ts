import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { generateReport } from "@/lib/reports/generate";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/reports/execute — internal worker endpoint (Task 9-a).
 *
 * Body: { jobId }
 *
 * REPORT_RUN execution (evaluate-in-Next, same architecture as
 * /api/v1/alerts/evaluate and /api/v1/worker/drift-evaluate — the worker
 * never opens SQLite): the worker claims the REPORT_RUN job and POSTs the
 * jobId here; this endpoint does the REAL work and owns the completion:
 *
 *   1. Validate the claim: job must exist, be type REPORT_RUN and be
 *      RUNNING (the claim flip is the trust guard — the same mechanism the
 *      other evaluate-in-Next endpoints rely on; see the middleware's
 *      documented internal-service trust boundary — no shared service
 *      secret exists anywhere in the platform yet).
 *   2. Resolve the schedule from the job payload (scheduleId, falling back
 *      to targetId). A schedule deleted after queueing answers 404 and the
 *      job is left RUNNING — the worker's failure path then runs the
 *      standard requeue/dead-letter semantics.
 *   3. Generate the artifact (src/lib/reports/generate.ts) — live data,
 *      capped at 500 rows.
 *   4. Persist in one transaction: JobExecution → SUCCEEDED with the
 *      artifact verbatim in resultJson, ReportSchedule.lastRunAt = now.
 *      (The worker never posts /worker/complete for SUCCEEDED — completion
 *      already happened here; a late complete post would answer
 *      { updated: false } harmlessly.)
 *   5. Audit REPORT_GENERATED with the run's shared correlationId
 *      (queue → claim → generate all carry the same REP-XXXXXX id).
 *
 * Returns the generation summary { jobId, scheduleId, scheduleName,
 * reportType, format, range, rows, generatedAt }.
 */

const executeSchema = z
  .object({
    jobId: z.string().trim().min(1).max(64),
  })
  .strip();

function safeParseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  // P19 SEC-002 — machine principal only (service JWT; see service-auth.ts).
  const service = authenticateServiceRequest(request);
  if (!service.ok) {
    return fail(service.code, service.message, 401);
  }
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = executeSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { jobId } = parsed.data;

  const job = await db.jobExecution.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      type: true,
      status: true,
      targetId: true,
      payloadJson: true,
      correlationId: true,
    },
  });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced report job does not exist", 404);
  }
  if (job.type !== "REPORT_RUN") {
    return fail(
      "JOB_TYPE_MISMATCH",
      `Job ${job.id} is a ${job.type} job, not REPORT_RUN`,
      409
    );
  }
  if (job.status !== "RUNNING") {
    return fail(
      "JOB_NOT_RUNNING",
      `Job ${job.id} is ${job.status} — only RUNNING jobs can execute a report`,
      409
    );
  }

  const payload = safeParseJson(job.payloadJson);
  const scheduleId =
    typeof payload.scheduleId === "string" && payload.scheduleId
      ? payload.scheduleId
      : job.targetId;
  if (!scheduleId) {
    return fail(
      "SCHEDULE_ID_MISSING",
      "The report job payload does not reference a schedule",
      400
    );
  }

  const schedule = await db.reportSchedule.findUnique({
    where: { id: scheduleId },
  });
  if (!schedule) {
    // Left RUNNING on purpose — the worker's complete(FAILED) path applies
    // the standard requeue/backoff/dead-letter semantics to this job.
    return fail(
      "SCHEDULE_NOT_FOUND",
      "Report schedule no longer exists (deleted after this run was queued)",
      404
    );
  }

  try {
    const artifact = await generateReport(schedule.reportType, {
      frequency: schedule.frequency,
      format: schedule.format,
    });

    const now = new Date();
    await db.$transaction([
      db.jobExecution.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          progress: 100,
          finishedAt: now,
          error: null,
          resultJson: JSON.stringify(artifact),
        },
      }),
      db.reportSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: now },
      }),
    ]);

    await db.auditEvent.create({
      data: {
        actorName: "system:report-worker",
        action: "REPORT_GENERATED",
        resourceType: "REPORT_SCHEDULE",
        resourceId: schedule.id,
        resourceLabel: schedule.name,
        result: "SUCCESS",
        correlationId: job.correlationId,
        afterJson: JSON.stringify({
          jobId: job.id,
          reportType: artifact.reportType,
          range: artifact.range,
          format: artifact.format,
          rows: artifact.rows.length,
          generatedAt: artifact.generatedAt,
        }),
      },
    });

    return ok({
      jobId: job.id,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      reportType: artifact.reportType,
      format: artifact.format,
      range: artifact.range,
      rows: artifact.rows.length,
      generatedAt: artifact.generatedAt,
    });
  } catch (error) {
    // Generation failure → 500 with a stable code; the worker's failure
    // path (requeue/backoff/dead-letter) takes over from here. The job is
    // left RUNNING for the same reason as the schedule-missing case.
    console.error("[reports/execute] generation failure:", error);
    return fail(
      "GENERATION_FAILED",
      error instanceof Error ? error.message : "Report generation failed",
      500
    );
  }
}
