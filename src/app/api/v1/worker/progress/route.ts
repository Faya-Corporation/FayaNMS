import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/progress — worker-facing job progress updates.
 *
 * Body: { jobId, progress(0..100), message? }
 * Updates the progress of a RUNNING job only; updates for jobs in any other
 * state are silently ignored (updated: 0) so late progress posts from a
 * timed-out or retried worker never corrupt state.
 */

const progressSchema = z.object({
  jobId: z.string().trim().min(1),
  progress: z.number().int().min(0).max(100),
  message: z.string().max(500).optional(),
});

export async function POST(request: Request) {
  // P19 SEC-002 — machine principal only (service JWT; see service-auth.ts).
  const service = authenticateServiceRequest(request, "jobs");
  if (!service.ok) {
    return fail(service.code, service.message, 401);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = progressSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const { jobId, progress } = parsed.data;

  const res = await db.jobExecution.updateMany({
    where: { id: jobId, status: "RUNNING" },
    data: { progress },
  });

  return ok({ jobId, progress, updated: res.count === 1 });
}
