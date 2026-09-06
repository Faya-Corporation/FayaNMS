import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { runAlertEvaluation } from "@/lib/alerts/evaluate";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/alerts/evaluate — threshold-evaluation entry point (Task 5-a).
 *
 * Body: { jobId?: string, triggeredBy?: string }
 *   - Worker path (ALERT_EVALUATION claim): the worker passes the jobId of
 *     its RUNNING claim + triggeredBy "JOB"; the summary it receives is
 *     recorded verbatim as the job's resultJson by the worker itself.
 *   - Manual path (demo/debug): no jobId — triggeredBy defaults to "MANUAL".
 *
 * The whole threshold engine runs here (evaluate-in-Next, same architecture
 * as the 3-c drift engine — the worker never opens SQLite). Body parsing is
 * intentionally lenient: an empty body is valid, unknown fields are ignored.
 *
 * Returns the AlertEvaluationSummary: { evaluatedAt, triggeredBy,
 * rulesEvaluated, devicesConsidered, fired, deduped, suppressed,
 * childrenSuppressed, resolved, incidentsCreated, notificationsCreated, caps }.
 */

const evaluateSchema = z
  .object({
    jobId: z.string().trim().min(1).max(64).optional(),
    triggeredBy: z.string().trim().min(1).max(40).optional(),
  })
  .strip();

export async function POST(request: Request) {
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = evaluateSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { jobId, triggeredBy } = parsed.data;

  let jobCorrelationId: string | undefined;
  if (jobId) {
    const job = await db.jobExecution.findUnique({
      where: { id: jobId },
      select: { id: true, type: true, status: true, correlationId: true },
    });
    if (!job) {
      return fail("JOB_NOT_FOUND", "The referenced evaluation job does not exist", 404);
    }
    if (job.type !== "ALERT_EVALUATION") {
      return fail(
        "JOB_TYPE_MISMATCH",
        `Job ${job.id} is a ${job.type} job, not ALERT_EVALUATION`,
        409
      );
    }
    if (job.status !== "RUNNING") {
      return fail(
        "JOB_NOT_RUNNING",
        `Job ${job.id} is ${job.status} — only RUNNING jobs can report an evaluation`,
        409
      );
    }
    jobCorrelationId = job.correlationId;
  }

  try {
    const summary = await runAlertEvaluation({
      triggeredBy: triggeredBy ?? (jobId ? "JOB" : "MANUAL"),
      correlationId: jobCorrelationId,
    });
    return ok(summary);
  } catch (error) {
    // Engine failure → 500 with a stable code; the worker's failure path
    // (requeue/backoff/dead-letter) takes over from here.
    console.error("[alerts/evaluate] engine failure:", error);
    return fail(
      "EVALUATION_FAILED",
      error instanceof Error ? error.message : "Alert evaluation failed",
      500
    );
  }
}
