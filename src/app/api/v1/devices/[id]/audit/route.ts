import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { authErrorToFail, requireSessionRead, sessionScopeFor } from "@/lib/auth/session";
import { sessionAllowsSite } from "@/lib/auth/scope";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/audit — audit events for a device. Matches both
 * Device records (DEVICE_CREATED / DEVICE_UPDATED …) and ConfigSnapshot
 * records keyed by the device id (CONFIG_BACKUP runs) so the history reads
 * as one timeline. Newest first.
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

const querySchema = paginationSchema.extend({});

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
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize } = parsed.data;

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
    resourceId: id,
    // "Device" is the seeded casing; "DEVICE" comes from the Phase 1 jobs
    // route; snapshots carry device-backed CONFIG_BACKUP history.
    resourceType: { in: ["Device", "DEVICE", "ConfigSnapshot"] },
  };

  const [total, rows] = await Promise.all([
    db.auditEvent.count({ where }),
    db.auditEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: Math.min(pageSize, 100),
      select: {
        id: true,
        actorName: true,
        action: true,
        resourceType: true,
        resourceLabel: true,
        result: true,
        ip: true,
        correlationId: true,
        createdAt: true,
      },
    }),
  ]);

  return ok(rows, pageMeta(page, Math.min(pageSize, 100), total));
}
