import { db } from "@/lib/db";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import {
  REPORT_FORMATS,
  REPORT_FREQUENCIES,
  REPORT_TYPES,
  generateReport,
} from "@/lib/reports/generate";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/v1/reports/run (Task 18-c) — user-facing ON-DEMAND report
 * generation for the Report Builder view ("reports.builder").
 *
 * Unlike /api/v1/reports/execute (the internal worker path that completes a
 * claimed REPORT_RUN JobExecution), this endpoint generates directly for a
 * signed-in operator from the builder selection — read-only over live data,
 * no job is queued and nothing is persisted except the audit row:
 *
 *   1. Auth exactly like the schedules POST (requirePermission → 401/403
 *      envelope on a missing session or a role without "report.create").
 *   2. Zod body: { reportType, frequency, format } → 400 INVALID_BODY.
 *   3. generateReport(...) — the same generator the worker path uses, so a
 *      builder preview always reconciles with the scheduled runs history.
 *      On throw → 500 GENERATION_FAILED (same convention as execute).
 *   4. ONE audit row: REPORT_BUILT with an RB-XXXXXX correlation id and a
 *      metadata-only afterJson (never the artifact content).
 *
 * FORMAT HONESTY: on this demo platform the scheduled pipeline treats the
 * format as a delivery tag only (the artifact rows/columns are identical
 * for PDF/XLSX/CSV/JSON — there is no binary renderer). This endpoint
 * behaves the same way and tags the artifact with the requested format;
 * the builder UI treats CSV/JSON as downloadable and PDF/XLSX as
 * metadata-tagged previews and says so in the UI copy.
 */

const runSchema = z
  .object({
    reportType: z.enum(REPORT_TYPES),
    frequency: z.enum(REPORT_FREQUENCIES),
    format: z.enum(REPORT_FORMATS),
  })
  .strip();

export async function POST(request: Request) {
  // Phase 19-C (audit AUTHZ-001 sweep): on-demand report generation
  // requires the "report.create" permission (was authentication-only via
  // requireUser).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "report.create");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = runSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { reportType, frequency, format } = parsed.data;

  const correlationId = newCorrelationId("RB");

  let artifact;
  try {
    artifact = await generateReport(reportType, { frequency, format });
  } catch (error) {
    // Same failure convention as the worker path (reports/execute): a
    // stable code + the underlying message; nothing was persisted.
    console.error("[reports/run] generation failure:", error);
    return fail(
      "GENERATION_FAILED",
      error instanceof Error ? error.message : "Report generation failed",
      500
    );
  }

  // ONE audit row — metadata only, never the artifact content.
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? actor.email,
      action: "REPORT_BUILT",
      resourceType: "REPORT",
      resourceLabel: `${reportType} · ${frequency}`,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        reportType,
        frequency,
        format,
        range: artifact.range,
        rows: artifact.rows.length,
        generatedAt: artifact.generatedAt,
      }),
    },
  });

  return ok({ artifact, correlationId });
}
