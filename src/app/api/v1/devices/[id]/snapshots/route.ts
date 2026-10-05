import { db } from "@/lib/db";
import { decryptSnapshotTexts } from "@/lib/config/crypto";
import { fail, firstIssueMessage, ok, pageMeta, paginationSchema } from "../../../_lib/api";
import { authErrorToFail, loadRolePermissions, requirePermission, sessionScopeFor } from "@/lib/auth/session";
import { sessionAllowsSite } from "@/lib/auth/scope";
import { roleHasPermission } from "@/lib/auth/permissions";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/snapshots
 *
 * Configuration snapshot version history for a device, newest version
 * first. Metadata always rides the list; the DECRYPTED configuration texts
 * (rawText + normalizedText) are included ONLY when the caller holds the
 * explicit "config.download" permission — the same key the dedicated
 * download route enforces (R61 P1: React masking is not an authorization
 * boundary, and the proxy session gate alone is not either).
 *
 * AUTHORIZATION (R61 P1):
 *   - the whole endpoint requires the explicit "config.read" permission
 *     (401 UNAUTHENTICATED / 403 RBAC_FORBIDDEN otherwise) — checked FIRST,
 *     before any database work;
 *   - texts ride only with "config.download" (seeded to admin/operator/
 *     engineer/manager — an auditor/viewer session gets metadata without
 *     decrypted configuration).
 * Optional `source` csv filter (used by the Backups tab to list backup-ish
 * runs).
 *
 * F-031 (site scoping — device-domain wave 7): the answer is gated by the
 * sessionAllowsSite row predicate with 404-NOT-403 parity — an out-of-scope
 * device gets the SAME DEVICE_NOT_FOUND envelope a wildcard session gets
 * for a missing device (a device hidden from the list cannot leak its
 * snapshot history through this sub-resource). Wildcard sessions (no
 * `sites` claim — the single-tenant default) are byte-unchanged.
 * authorization-matrix.md §5.1.
 */

const querySchema = paginationSchema.extend({
  source: z.string().optional(), // csv multi: SCHEDULED|MANUAL|PRE_CHANGE|POST_CHANGE|EVENT
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // R61 P1 — explicit permission gate FIRST, before any database work.
  // requirePermission returns the session principal; the SECOND check
  // (config.download) decides whether the decrypted configuration texts
  // may leave the server at all.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.read");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  const mayReadTexts = roleHasPermission(
    await loadRolePermissions(actor.role),
    "config.download",
  );
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize } = parsed.data;
  const sources = parsed.data.source
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const scopeClaims = await sessionScopeFor(request);
  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true, site: { select: { code: true } } },
  });
  // F-031 wave-7: the SAME not-found envelope for a missing device AND an
  // out-of-scope device — no existence leak on the snapshot-history read
  // (sessionAllowsSite mirrors the list route's where filter; site-less
  // devices stay hidden from sites-limited sessions — fail-closed parity
  // with SQL).
  if (!device || !sessionAllowsSite(scopeClaims, device.site?.code ?? null)) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  const where = {
    deviceId: id,
    ...(sources && sources.length > 0 ? { source: { in: sources } } : {}),
  };

  const [total, rows] = await Promise.all([
    db.configSnapshot.count({ where }),
    db.configSnapshot.findMany({
      where,
      orderBy: { version: "desc" },
      skip: (page - 1) * pageSize,
      take: Math.min(pageSize, 50),
      select: {
        id: true,
        version: true,
        source: true,
        configType: true,
        status: true,
        sha256: true,
        sizeBytes: true,
        rawText: true,
        normalizedText: true,
        encKeyId: true,
        encIv: true,
        encTag: true,
        normIv: true,
        normTag: true,
        wrappedDek: true,
        encAad: true, // AAD binding (CRYPTO-101) — required by decryptSnapshotTexts
        wrapIv: true,
        wrapTag: true,
        createdAt: true,
        change: { select: { number: true, title: true } },
        user: { select: { name: true } },
        job: { select: { correlationId: true } },
      },
    }),
  ]);

  return ok(
    rows.map((row) => {
      // R61 P1 — the decrypted texts leave the server ONLY for
      // config.download holders (the download route's key). For everyone
      // else the fields are OMITTED — server-side boundary, not a viewer
      // convention. decryptSnapshotTexts runs only on the privileged path.
      const base = {
        id: row.id,
        version: row.version,
        source: row.source,
        configType: row.configType,
        status: row.status,
        sha256: row.sha256,
        sizeBytes: row.sizeBytes,
        createdAt: row.createdAt,
        changeNumber: row.change?.number ?? null,
        capturedBy: row.user?.name ?? null,
        correlationId: row.job?.correlationId ?? null,
        textIncluded: mayReadTexts,
      };
      if (!mayReadTexts) return base;
      // P19 SEC-003: rows hold AES-256-GCM ciphertext; decrypt for the
      // privileged viewer payload (legacy encKeyId=null rows pass through).
      const texts = decryptSnapshotTexts(row);
      return { ...base, rawText: texts.rawText, normalizedText: texts.normalizedText };
    }),
    { ...pageMeta(page, Math.min(pageSize, 50), total), hostname: device.hostname }
  );
}
