import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/changes — change requests linked to the device
 * via ChangeDevice. Includes the per-device link result (PENDING/SUCCESS/
 * FAILED/SKIPPED) alongside the request-level status/risk.
 */

const querySchema = paginationSchema.extend({});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize } = parsed.data;

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  const where = { devices: { some: { deviceId: id } } };

  const [total, rows] = await Promise.all([
    db.changeRequest.count({ where }),
    db.changeRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: Math.min(pageSize, 100),
      select: {
        id: true,
        number: true,
        title: true,
        type: true,
        status: true,
        riskScore: true,
        riskLevel: true,
        scheduledStart: true,
        scheduledEnd: true,
        createdAt: true,
        devices: {
          where: { deviceId: id },
          select: { result: true, createdAt: true },
          take: 1,
        },
      },
    }),
  ]);

  return ok(
    rows.map((row) => ({
      id: row.id,
      number: row.number,
      title: row.title,
      type: row.type,
      status: row.status,
      riskScore: row.riskScore,
      riskLevel: row.riskLevel,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      createdAt: row.createdAt,
      deviceResult: row.devices[0]?.result ?? null,
    })),
    pageMeta(page, Math.min(pageSize, 100), total)
  );
}
