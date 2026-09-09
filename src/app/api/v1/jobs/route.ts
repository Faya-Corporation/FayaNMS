import { db } from "@/lib/db";
import {
  csvParam,
  fail,
  firstIssueMessage,
  newJobCorrelationId,
  ok,
  pageMeta,
  paginationSchema,
  requestContext,
} from "../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET  /api/v1/jobs        — recent job executions (status csv filter, newest first).
 * POST /api/v1/jobs        — queue a job. Body: { type: "CONFIG_BACKUP", deviceId }.
 * Creates a QUEUED JobExecution + a CONFIG_BACKUP_QUEUED audit event and
 * returns both. The Phase 2 worker mini-service will pick these up.
 */

const listSchema = paginationSchema.extend({
  status: z.string().optional(),
  deviceId: z.string().trim().min(1).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = listSchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
    deviceId: url.searchParams.get("deviceId") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400, requestContext(request));
  }

  const { page, pageSize, deviceId } = parsed.data;
  const statuses = csvParam(parsed.data.status);

  const where = {
    AND: [
      statuses ? { status: { in: statuses } } : {},
      deviceId ? { targetId: deviceId, targetType: "DEVICE" } : {},
    ],
  };

  const [total, rows] = await Promise.all([
    db.jobExecution.count({ where }),
    db.jobExecution.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return ok(rows, pageMeta(page, pageSize, total), 200, requestContext(request));
}

const createSchema = z.object({
  type: z.enum(["CONFIG_BACKUP", "REPORT_RUN"]),
  deviceId: z.string().trim().min(1, "deviceId is required"),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, requestContext(request));
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, requestContext(request));
  }

  const { deviceId } = parsed.data;
  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: { id: true, hostname: true, status: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404, requestContext(request));
  }
  if (device.status === "UNMANAGED") {
    return fail(
      "DEVICE_UNMANAGED",
      "Backup cannot be queued for an unmanaged device",
      409,
      requestContext(request)
    );
  }

  const correlationId = newJobCorrelationId();

  const [job, audit] = await db.$transaction([
    db.jobExecution.create({
      data: {
        type: "CONFIG_BACKUP",
        targetType: "DEVICE",
        targetId: device.id,
        status: "QUEUED",
        progress: 0,
        priority: 5,
        maxAttempts: 3,
        payloadJson: JSON.stringify({ deviceId: device.id }),
        correlationId,
      },
    }),
    db.auditEvent.create({
      data: {
        actorName: "Admin",
        action: "CONFIG_BACKUP_QUEUED",
        resourceType: "DEVICE",
        resourceId: device.id,
        resourceLabel: device.hostname,
        result: "SUCCESS",
        correlationId,
      },
    }),
  ]);

  return ok({ job, audit }, { correlationId }, 201, requestContext(request));
}
