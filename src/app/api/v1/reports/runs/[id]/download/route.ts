import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { fail, newCorrelationId } from "../../../../_lib/api";
import { artifactToCsv, type ReportArtifact } from "@/lib/reports/generate";
import { renderArtifactPdf } from "@/lib/reports/render-pdf";
import { renderArtifactXlsx } from "@/lib/reports/render-xlsx";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/reports/runs/[id]/download?format=CSV|JSON|PDF|XLSX (Task 9-a;
 * GA-5 2026-10-06 re-audit adds the binary formats).
 *
 * Streams the stored resultJson artifact of a SUCCEEDED REPORT_RUN as a
 * file attachment: CSV rendered via artifactToCsv, JSON verbatim pretty
 * print, and — closing the GA-5 format-honesty gap — REAL PDF 1.4 and
 * XLSX (SpreadsheetML) bytes rendered at delivery time by
 * renderArtifactPdf/renderArtifactXlsx from the stored artifact (the
 * resultJson stays the single source of truth; no schema change, no
 * binary blob persisted). QUEUED/RUNNING/FAILED runs answer 409
 * RUN_NOT_DOWNLOADABLE — there is nothing to download until the artifact
 * exists.
 *
 * Audited like every other export surface (REPORT_DOWNLOAD, DL-style
 * correlation id, actor from the session). Authorization (Phase 19-C,
 * audit AUTHZ-001 sweep): requires the "report.read" permission — the
 * viewer/auditor roles hold "*.read" and still pass. The response is a
 * plain byte attachment (Content-Disposition), so it behaves identically
 * in LTR and RTL contexts.
 */

const ID_MAX = 64;

function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "report";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // Phase 19-C (audit AUTHZ-001 sweep): downloads require the "report.read"
  // permission (was authentication-only via requireUser) — read-only, so
  // "*.read" wildcard holders (viewer/auditor) still pass.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "report.read");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }

  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid run id", 400);
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "CSV").toUpperCase();
  if (format !== "CSV" && format !== "JSON" && format !== "PDF" && format !== "XLSX") {
    return fail("INVALID_QUERY", "format must be CSV, JSON, PDF or XLSX", 400);
  }

  const run = await db.jobExecution.findUnique({
    where: { id },
    select: {
      id: true,
      type: true,
      status: true,
      resultJson: true,
      correlationId: true,
      createdAt: true,
      payloadJson: true,
    },
  });
  if (!run || run.type !== "REPORT_RUN") {
    return fail("RUN_NOT_FOUND", "Report run not found", 404);
  }
  if (run.status !== "SUCCEEDED" || !run.resultJson) {
    return fail(
      "RUN_NOT_DOWNLOADABLE",
      `Run is ${run.status} — downloads unlock when the run succeeds`,
      409
    );
  }

  let artifact: Record<string, unknown>;
  try {
    const parsed = JSON.parse(run.resultJson);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).columns) ||
      !Array.isArray((parsed as Record<string, unknown>).rows)
    ) {
      throw new Error("artifact shape");
    }
    artifact = parsed as Record<string, unknown>;
  } catch {
    return fail(
      "ARTIFACT_INVALID",
      "The stored report artifact could not be read",
      500
    );
  }

  const reportType =
    typeof artifact.reportType === "string" ? artifact.reportType : "REPORT";
  const generatedAt =
    typeof artifact.generatedAt === "string" ? artifact.generatedAt : run.createdAt.toISOString();
  const stamp = generatedAt.slice(0, 10);

  // Payload carries the schedule name (denormalized at queue time) so the
  // filename stays meaningful even after the schedule is deleted.
  let scheduleName = "schedule";
  try {
    const payload = JSON.parse(run.payloadJson ?? "{}") as Record<string, unknown>;
    if (typeof payload.scheduleName === "string" && payload.scheduleName) {
      scheduleName = payload.scheduleName;
    }
  } catch {
    /* keep fallback */
  }

  const correlationId = newCorrelationId("DL");
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? actor.email,
      action: "REPORT_DOWNLOAD",
      resourceType: "REPORT_RUN",
      resourceId: run.id,
      resourceLabel: `${reportType} (${format})`,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        runId: run.id,
        reportType,
        format,
        runCorrelationId: run.correlationId,
      }),
    },
  });

  const baseName = `${safeFilenamePart(scheduleName)}-${safeFilenamePart(reportType)}-${stamp}-${run.id.slice(-6)}`;

  if (format === "CSV") {
    const csv = artifactToCsv(
      artifact as unknown as Parameters<typeof artifactToCsv>[0]
    );
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseName}.csv"`,
        "X-Correlation-Id": correlationId,
        "Cache-Control": "no-store",
      },
    });
  }

  // GA-5: the binary formats render at delivery from the stored artifact.
  if (format === "PDF") {
    const pdf = renderArtifactPdf(artifact as unknown as ReportArtifact);
    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${baseName}.pdf"`,
        "X-Correlation-Id": correlationId,
        "Cache-Control": "no-store",
      },
    });
  }

  if (format === "XLSX") {
    const xlsx = renderArtifactXlsx(artifact as unknown as ReportArtifact);
    return new NextResponse(xlsx as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${baseName}.xlsx"`,
        "X-Correlation-Id": correlationId,
        "Cache-Control": "no-store",
      },
    });
  }

  return new NextResponse(JSON.stringify(artifact, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${baseName}.json"`,
      "X-Correlation-Id": correlationId,
      "Cache-Control": "no-store",
    },
  });
}
