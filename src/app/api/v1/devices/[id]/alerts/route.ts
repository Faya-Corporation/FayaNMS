import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/alerts — alerts for one device, newest lastSeen
 * first. Optional status csv filter. Ack lives in the Phase 5 alert tooling.
 *
 * F-008 phase 3 (read-plane defense-in-depth): the handler verifies the
 * human session itself (requireSessionRead) — the proxy matcher stays the
 * coarse gate, not the only check, for this read route.
 */

const querySchema = paginationSchema.extend({
  status: z.string().optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    status: url.searchParams.get("status") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize } = parsed.data;
  const statuses = parsed.data.status
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  const where = {
    deviceId: id,
    ...(statuses && statuses.length > 0 ? { status: { in: statuses } } : {}),
  };

  const [total, rows] = await Promise.all([
    db.alert.count({ where }),
    db.alert.findMany({
      where,
      orderBy: { lastSeen: "desc" },
      skip: (page - 1) * pageSize,
      take: Math.min(pageSize, 100),
      select: {
        id: true,
        severity: true,
        message: true,
        status: true,
        count: true,
        firstSeen: true,
        lastSeen: true,
        acknowledgedAt: true,
        rule: { select: { name: true } },
      },
    }),
  ]);

  return ok(
    rows.map((row) => ({
      id: row.id,
      severity: row.severity,
      message: row.message,
      status: row.status,
      count: row.count,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      acknowledgedAt: row.acknowledgedAt,
      ruleName: row.rule?.name ?? null,
    })),
    pageMeta(page, Math.min(pageSize, 100), total)
  );
}
