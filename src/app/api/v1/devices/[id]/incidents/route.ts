import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/incidents — incidents linked to the device via
 * IncidentDevice, newest first.
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
    db.incident.count({ where }),
    db.incident.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: Math.min(pageSize, 100),
      select: {
        id: true,
        number: true,
        title: true,
        severity: true,
        priority: true,
        status: true,
        source: true,
        createdAt: true,
        resolvedAt: true,
        slaDueAt: true,
      },
    }),
  ]);

  return ok(rows, pageMeta(page, Math.min(pageSize, 100), total));
}
