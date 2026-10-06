import { db } from "@/lib/db";
import {
  requireUser,
  authErrorToFail,
  requirePermission,
  sessionScopeFor,
} from "@/lib/auth/session";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  pageMeta,
  paginationSchema,
} from "../../_lib/api";
import {
  FREQUENCY_INTERVAL_DAYS,
  serializeSchedule,
} from "@/lib/reports/schedule-serializer";
import {
  REPORT_FORMATS,
  REPORT_FREQUENCIES,
  REPORT_TYPES,
  reportScopeJsonForClaims,
} from "@/lib/reports/generate";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * /api/v1/reports/schedules (Task 9-a) — report scheduler CRUD surface.
 *
 * GET  — paginated schedule list (newest first). meta carries the KPI
 *        counters for the Scheduled Reports view: activeSchedules, total,
 *        runsLast7d (REPORT_RUN JobExecutions created in the last 7 days),
 *        successRate7d (SUCCEEDED / finished runs in the window, null when
 *        no finished runs) and nextEstimatedRunAt — the earliest
 *        lastRunAt+frequency interval among ACTIVE schedules (indicative
 *        only: the demo scheduler has no cron math beyond this estimate).
 * POST — create a schedule (audited REPORT_SCHEDULE_CREATED, correlation
 *        REP-XXXXXX). Recipients are validated email addresses; they are
 *        stored as JSON in ReportSchedule.recipientsJson (schema as-is).
 *
 * PATCH/DELETE for a single schedule live on /api/v1/reports/schedules/[id]
 * (added in Phase 18 — the client hooks always pointed there). The schedule
 * serializer is shared via src/lib/reports/schedule-serializer.ts so both
 * surfaces emit identical rows.
 */

const DAY_MS = 86_400_000;

const emailList = z
  .array(z.string().trim().toLowerCase().email("recipients must be valid email addresses").max(160))
  .min(1, "at least one recipient is required")
  .max(20, "at most 20 recipients are allowed");

const listSchema = paginationSchema.extend({
  reportType: z.enum(REPORT_TYPES).optional(),
  isActive: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
});

const createSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(160),
  reportType: z.enum(REPORT_TYPES),
  frequency: z.enum(REPORT_FREQUENCIES).default("WEEKLY"),
  format: z.enum(REPORT_FORMATS).default("PDF"),
  recipients: emailList,
  isActive: z.boolean().default(true),
});

export async function GET(request: Request) {
  try {
    await requireUser(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const url = new URL(request.url);
  const parsed = listSchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    reportType: url.searchParams.get("reportType") ?? undefined,
    isActive: url.searchParams.get("isActive") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize, reportType, isActive } = parsed.data;

  const where = {
    AND: [
      reportType ? { reportType } : {},
      isActive === undefined ? {} : { isActive },
    ],
  };

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);

  const [total, rows, activeSchedules, runsLast7d, succeeded7d, finished7d] =
    await Promise.all([
      db.reportSchedule.count({ where }),
      db.reportSchedule.findMany({
        where,
        orderBy: { name: "asc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      db.reportSchedule.count({ where: { ...where, isActive: true } }),
      db.jobExecution.count({
        where: { type: "REPORT_RUN", createdAt: { gte: sevenDaysAgo } },
      }),
      db.jobExecution.count({
        where: {
          type: "REPORT_RUN",
          status: "SUCCEEDED",
          createdAt: { gte: sevenDaysAgo },
        },
      }),
      db.jobExecution.count({
        where: {
          type: "REPORT_RUN",
          status: { in: ["SUCCEEDED", "FAILED"] },
          createdAt: { gte: sevenDaysAgo },
        },
      }),
    ]);

  // Earliest indicative next run among active schedules (no cron math —
  // lastRunAt + the frequency interval; null when nothing is scheduled).
  const activeRows = rows.filter((row) => row.isActive);
  const nextEstimatedRunAt = activeRows
    .map((row) => {
      const intervalDays = FREQUENCY_INTERVAL_DAYS[row.frequency] ?? 7;
      return new Date(
        (row.lastRunAt?.getTime() ?? now.getTime()) + intervalDays * DAY_MS
      );
    })
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return ok(
    rows.map(serializeSchedule),
    {
      ...pageMeta(page, pageSize, total),
      activeSchedules,
      total,
      runsLast7d,
      successRate7d: finished7d > 0 ? Math.round((succeeded7d / finished7d) * 100) : null,
      finished7d,
      nextEstimatedRunAt: nextEstimatedRunAt?.toISOString() ?? null,
    }
  );
}

export async function POST(request: Request) {
  // Phase 19-C (audit AUTHZ-001 sweep): creating report schedules requires
  // the "report.schedule" permission (was authentication-only via
  // requireUser). The GET authentication gate above is unchanged.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "report.schedule");
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

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  const correlationId = newCorrelationId("REP");

  // P1-A01 (GA re-audit 2026-10-06): the schedule's site scope is FROZEN
  // at creation from the creating session's resolved scope and is never
  // reconstructed from the worker's global service identity at run time.
  // Wildcard sessions freeze null (byte-identical legacy behavior); a
  // site-limited creator freezes their code list (deny-all freezes "[]").
  // The column is deliberately NOT PATCHable — the frozen scope is part of
  // the schedule's identity (recreate the schedule to change it).
  const frozenScopeJson = await reportScopeJsonForClaims(
    await sessionScopeFor(request)
  );

  const schedule = await db.reportSchedule.create({
    data: {
      name: data.name,
      reportType: data.reportType,
      frequency: data.frequency,
      format: data.format,
      recipientsJson: JSON.stringify(data.recipients),
      scopeJson: frozenScopeJson,
      isActive: data.isActive,
    },
  });

  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? actor.email,
      action: "REPORT_SCHEDULE_CREATED",
      resourceType: "REPORT_SCHEDULE",
      resourceId: schedule.id,
      resourceLabel: schedule.name,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify({
        name: schedule.name,
        reportType: schedule.reportType,
        frequency: schedule.frequency,
        format: schedule.format,
        recipients: data.recipients,
        isActive: schedule.isActive,
      }),
    },
  });

  return ok(
    { schedule: serializeSchedule(schedule), audit: { correlationId } },
    { correlationId },
    201
  );
}
