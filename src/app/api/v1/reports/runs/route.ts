import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import {
  requirePermission,
  authErrorToFail,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionSiteScope } from "@/lib/auth/scope";
import { scheduleReadableByViewer } from "@/lib/reports/consumption-scope";
import {
  csvParam,
  fail,
  firstIssueMessage,
  ok,
  pageMeta,
  paginationSchema,
} from "../../_lib/api";
import { expectedRangeFor } from "@/lib/reports/generate";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/reports/runs (Task 9-a) — runs history.
 *
 * The history IS the REPORT_RUN JobExecution stream (no schema change):
 * newest first, optional status csv filter (?status=QUEUED,RUNNING,…),
 * joined with the ReportSchedule for name/type/format (schedule may be
 * gone — deleted schedules leave their runs behind with schedule: null).
 *
 * Per row: status, progress, durationMs (finishedAt − startedAt when both
 * exist), range (from the stored artifact when SUCCEEDED, otherwise the
 * schedule-derived expectation), rowCount (artifact size when available),
 * error, correlationId. meta carries the view's KPI counters: total,
 * succeeded, failed, lastRunAt, plus the page block.
 *
 * FNM-2026-104 (2026-10-18 re-audit, Wave R2) — consumption scoping:
 * the list requires the "report.read" permission (was authentication-only)
 * and a site-limited viewer sees ONLY runs whose schedule's frozen scope
 * is contained in the viewer's own scope. A wildcard-scope run (fleet-wide
 * data) and a run whose schedule is deleted (scope unknowable) are HIDDEN
 * from site-limited viewers — fail-closed, not 403-per-row.
 */

const listSchema = paginationSchema.extend({
  status: z.string().optional(),
  scheduleId: z.string().trim().max(64).optional(),
});

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

function parsePayloadScheduleId(
  payloadJson: string | null,
  targetId: string | null
): string | null {
  const payload = safeParseJson(payloadJson);
  if (typeof payload.scheduleId === "string" && payload.scheduleId) {
    return payload.scheduleId;
  }
  return targetId ?? null;
}

export async function GET(request: Request) {
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "report.read");
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const url = new URL(request.url);
  const parsed = listSchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    scheduleId: url.searchParams.get("scheduleId") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize, scheduleId } = parsed.data;
  const statuses = csvParam(parsed.data.status);

  const where: { AND: Prisma.JobExecutionWhereInput[] } = {
    AND: [
      { type: "REPORT_RUN" },
      statuses ? { status: { in: statuses } } : {},
      scheduleId ? { targetId: scheduleId } : {},
    ],
  };

  // FNM-2026-104: site-limited viewers only see runs whose schedule's
  // frozen scope is contained in their own. Wildcard schedules (null
  // scopeJson = fleet-wide data) and runs whose schedule is gone (scope
  // unknowable) are excluded — fail-closed. Deny-all schedules ("[]")
  // produce empty artifacts and stay visible (containment holds trivially).
  const viewerScope = sessionSiteScope(await sessionScopeFor(request));
  if (viewerScope.mode === "sites") {
    const candidates = await db.reportSchedule.findMany({
      where: { scopeJson: { not: null } },
      select: { id: true, scopeJson: true },
    });
    where.AND.push({
      targetId: {
        in: candidates
          .filter((s) => scheduleReadableByViewer(s.scopeJson, viewerScope))
          .map((s) => s.id),
      },
    });
  }

  const [total, rows, succeeded, failed, lastRun] = await Promise.all([
    db.jobExecution.count({ where }),
    db.jobExecution.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.jobExecution.count({ where: { ...where, status: "SUCCEEDED" } }),
    db.jobExecution.count({ where: { ...where, status: "FAILED" } }),
    db.jobExecution.findFirst({
      where,
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  // Manual join to ReportSchedule (no Prisma relation — schema is frozen).
  const scheduleIds = [
    ...new Set(
      rows
        .map((row) => parsePayloadScheduleId(row.payloadJson, row.targetId))
        .filter((id): id is string => Boolean(id))
    ),
  ];
  const schedules = scheduleIds.length
    ? await db.reportSchedule.findMany({
        where: { id: { in: scheduleIds } },
        select: {
          id: true,
          name: true,
          reportType: true,
          frequency: true,
          format: true,
        },
      })
    : [];
  const scheduleById = new Map(schedules.map((s) => [s.id, s]));

  const data = rows.map((row) => {
    const artifact = safeParseJson(row.resultJson);
    const schedule = (() => {
      const id = parsePayloadScheduleId(row.payloadJson, row.targetId);
      return id ? scheduleById.get(id) ?? null : null;
    })();

    let rowCount: number | null = null;
    if (Array.isArray(artifact.rows)) rowCount = artifact.rows.length;

    const durationMs =
      row.startedAt && row.finishedAt
        ? row.finishedAt.getTime() - row.startedAt.getTime()
        : null;

    const range =
      typeof artifact.range === "string"
        ? artifact.range
        : schedule
          ? expectedRangeFor(schedule.reportType, schedule.frequency)
          : null;

    return {
      id: row.id,
      status: row.status,
      progress: row.progress,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      error: row.error,
      correlationId: row.correlationId,
      createdAt: row.createdAt.toISOString(),
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      durationMs,
      range,
      rowCount,
      reportType:
        schedule?.reportType ??
        (typeof safeParseJson(row.payloadJson).reportType === "string"
          ? (safeParseJson(row.payloadJson).reportType as string)
          : null),
      format: schedule?.format ?? null,
      schedule: schedule
        ? {
            id: schedule.id,
            name: schedule.name,
            reportType: schedule.reportType,
            frequency: schedule.frequency,
            format: schedule.format,
          }
        : null,
    };
  });

  return ok(data, {
    ...pageMeta(page, pageSize, total),
    total,
    succeeded,
    failed,
    lastRunAt: lastRun?.createdAt.toISOString() ?? null,
  });
}
