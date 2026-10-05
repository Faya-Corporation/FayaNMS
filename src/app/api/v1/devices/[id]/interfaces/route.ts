import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";
import { sessionAllowsSite } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/interfaces?q=
 *
 * Interface inventory for a device. BigInt bps counters are serialized as
 * strings (Prisma throws on BigInt in JSON). Optional `q` search across
 * name/description/mac.
 *
 * F-008 phase 3 (read-plane defense-in-depth): the handler verifies the
 * human session itself (requireSessionRead) — the proxy matcher stays the
 * coarse gate, not the only check, for this read route.
 *
 * F-031 (site scoping — device-domain migration): the answer is gated by
 * sessionAllowsSite with 404-NOT-403 parity — an out-of-scope device gets
 * the SAME DEVICE_NOT_FOUND envelope (no existence leak), mirroring the
 * reference detail route (authorization-matrix.md §5.1).
 */

const querySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(80).optional(),
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
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize, q } = parsed.data;

  const scopeClaims = await sessionScopeFor(request);
  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true, site: { select: { code: true } } },
  });
  // F-031: the SAME not-found envelope for a missing device AND an
  // out-of-scope device — a device hidden from the list cannot leak
  // through this sub-resource route (sessionAllowsSite mirrors the list
  // route's where filter; site-less devices stay hidden from
  // sites-limited sessions — fail-closed parity with SQL).
  if (!device || !sessionAllowsSite(scopeClaims, device.site?.code ?? null)) {
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
