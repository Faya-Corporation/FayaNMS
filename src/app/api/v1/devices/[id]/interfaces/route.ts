import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/interfaces?q=
 *
 * Interface inventory for a device. BigInt bps counters are serialized as
 * strings (Prisma throws on BigInt in JSON). Optional `q` search across
 * name/description/mac.
 */

const querySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
});

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
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize, q } = parsed.data;

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  const where = {
    deviceId: id,
    ...(q
      ? {
          OR: [
            { name: { contains: q } },
            { description: { contains: q } },
            { macAddress: { contains: q } },
          ],
        }
      : {}),
  };

  const [total, rows] = await Promise.all([
    db.deviceInterface.count({ where }),
    db.deviceInterface.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return ok(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      adminStatus: row.adminStatus,
      operStatus: row.operStatus,
      speedMbps: row.speedMbps,
      macAddress: row.macAddress,
      vlan: row.vlan,
      mtu: row.mtu,
      // BigInt -> string (JSON-safe)
      countersInBps: row.countersInBps === null ? null : row.countersInBps.toString(),
      countersOutBps: row.countersOutBps === null ? null : row.countersOutBps.toString(),
      lastFlapAt: row.lastFlapAt,
    })),
    { ...pageMeta(page, pageSize, total), hostname: device.hostname }
  );
}
