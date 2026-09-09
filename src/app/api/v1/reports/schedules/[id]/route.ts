import { db } from "@/lib/db";
import { requireUser, authErrorToFail } from "@/lib/auth/session";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../_lib/api";
import { serializeSchedule } from "@/lib/reports/schedule-serializer";
import {
  REPORT_FORMATS,
  REPORT_FREQUENCIES,
  REPORT_TYPES,
} from "@/lib/reports/generate";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * /api/v1/reports/schedules/[id] — per-schedule mutations.
 *
 * This route file was MISSING since Task 9-a shipped the Scheduled Reports
 * view: the client's useUpdateReportSchedule / useDeleteReportSchedule have
 * been calling PATCH and DELETE here, but only the [id]/run sub-route ever
 * existed — edit and delete answered a framework 404 HTML page (surfaced by
 * the Phase 18 builder→save→delete golden path and fixed there).
 *
 * PATCH — partial update (name/reportType/frequency/format/recipients/
 *         isActive, all optional; recipients re-validated when present).
 *         Audited REPORT_SCHEDULE_UPDATED with before/after snapshots.
 * DELETE — removes the schedule row (no soft-delete column exists; run
 *         history artifacts live on their JobExecution rows and survive).
 *         Audited REPORT_SCHEDULE_DELETED with a before snapshot.
 *
 * Both: requireUser (same as the list/create route), 404 SCHEDULE_NOT_FOUND
 * on an unknown id, REP-XXXXXX correlation ids, { schedule|deleted, audit }
 * response shapes exactly as the existing hooks type them.
 */

const ID_MAX = 64;

const emailList = z
  .array(
    z.string()
      .trim()
      .toLowerCase()
      .email("recipients must be valid email addresses")
      .max(160)
  )
  .min(1, "at least one recipient is required")
  .max(20, "at most 20 recipients are allowed");

const patchSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(160).optional(),
    reportType: z.enum(REPORT_TYPES).optional(),
    frequency: z.enum(REPORT_FREQUENCIES).optional(),
    format: z.enum(REPORT_FORMATS).optional(),
    recipients: emailList.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

/** Require a session; map auth errors to the standard envelope. */
async function auth(request: Request) {
  try {
    return { actor: await requireUser(request), envelope: null };
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return { actor: null, envelope };
    throw error;
  }
}

async function resolveId(params: Promise<{ id: string }>) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return {
      id: null,
      envelope: fail("INVALID_ID", "Invalid schedule id", 400),
    };
  }
  return { id, envelope: null };
}

async function loadSchedule(id: string) {
  const schedule = await db.reportSchedule.findUnique({ where: { id } });
  if (!schedule) {
    return {
      schedule: null,
      envelope: fail("SCHEDULE_NOT_FOUND", "Report schedule not found", 404),
    };
  }
  return { schedule, envelope: null };
}

/** before/after audit snapshots (recipients parsed for readability). */
function scheduleSnapshot(schedule: {
  name: string;
  reportType: string;
  frequency: string;
  format: string;
  recipientsJson: string;
  isActive: boolean;
}) {
  let recipients: string[] = [];
  try {
    const parsed = JSON.parse(schedule.recipientsJson);
    if (Array.isArray(parsed)) {
      recipients = parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    recipients = [];
  }
  return {
    name: schedule.name,
    reportType: schedule.reportType,
    frequency: schedule.frequency,
    format: schedule.format,
    recipients,
    isActive: schedule.isActive,
  };
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await auth(request);
  if (authResult.envelope) return authResult.envelope;
  const actor = authResult.actor;

  const idResult = await resolveId(params);
  if (idResult.envelope) return idResult.envelope;
  const id = idResult.id as string;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;
  if (Object.keys(data).length === 0) {
    return fail("INVALID_BODY", "No updatable fields provided", 400);
  }

  const existingResult = await loadSchedule(id);
  if (existingResult.envelope) return existingResult.envelope;
  const existing = existingResult.schedule!;
  const before = scheduleSnapshot(existing);

  const correlationId = newCorrelationId("REP");
  const updated = await db.reportSchedule.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.reportType !== undefined ? { reportType: data.reportType } : {}),
      ...(data.frequency !== undefined ? { frequency: data.frequency } : {}),
      ...(data.format !== undefined ? { format: data.format } : {}),
      ...(data.recipients !== undefined
        ? { recipientsJson: JSON.stringify(data.recipients) }
        : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });

  await db.auditEvent.create({
    data: {
      actorId: actor!.id,
      actorName: actor!.name ?? actor!.email,
      action: "REPORT_SCHEDULE_UPDATED",
      resourceType: "REPORT_SCHEDULE",
      resourceId: updated.id,
      resourceLabel: updated.name,
      result: "SUCCESS",
      correlationId,
      beforeJson: JSON.stringify(before),
      afterJson: JSON.stringify(scheduleSnapshot(updated)),
    },
  });

  return ok({
    schedule: serializeSchedule(updated),
    audit: { correlationId },
  });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const authResult = await auth(request);
  if (authResult.envelope) return authResult.envelope;
  const actor = authResult.actor;

  const idResult = await resolveId(params);
  if (idResult.envelope) return idResult.envelope;
  const id = idResult.id as string;

  const existingResult = await loadSchedule(id);
  if (existingResult.envelope) return existingResult.envelope;
  const existing = existingResult.schedule!;
  const snapshot = scheduleSnapshot(existing);

  const correlationId = newCorrelationId("REP");

  await db.$transaction([
    db.reportSchedule.delete({ where: { id } }),
    db.auditEvent.create({
      data: {
        actorId: actor!.id,
        actorName: actor!.name ?? actor!.email,
        action: "REPORT_SCHEDULE_DELETED",
        resourceType: "REPORT_SCHEDULE",
        resourceId: existing.id,
        resourceLabel: existing.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify(snapshot),
      },
    }),
  ]);

  return ok({ deleted: true, audit: { correlationId } });
}
