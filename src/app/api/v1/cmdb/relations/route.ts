import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../_lib/api";
import {
  authErrorToFail,
  requirePermission,
  requireSessionRead,
  requireSiteScope,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionAllowsSite, sessionSiteScope } from "@/lib/auth/scope";
import {
  CMDB_ITEM_SUMMARY_SELECT,
  cmdbRelationTypeSchema,
  resolveCmdbItem,
  type CmdbItemSummary,
} from "@/lib/cmdb/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * CMDB — relation graph edges (Phase 15-a)
 *
 * GET /api/v1/cmdb/relations?relationType=&itemId=
 *   Edge list with source/target summaries joined. itemId resolves by cuid
 *   OR CI-000NNN and matches edges where the item is EITHER endpoint.
 *   Read-only → no audit event (app convention).
 *
 *   F-031 wave-9 (read-plane migration): a sites-limited session sees only
 *   edges whose BOTH endpoints are visible CIs (the list predicate from
 *   cmdb/items — linked device's site, else the siteId tag; linkage-less
 *   CIs are global). An itemId whose CI is out-of-scope answers the SAME
 *   `CMDB_NOT_FOUND` 404 envelope a wildcard session gets for a missing CI
 *   (404-not-403 — no existence leak). Wildcard keeps the byte-unchanged
 *   queries; deny-all still lists edges between linkage-less CIs (the
 *   documented global-resource edge).
 *
 * POST /api/v1/cmdb/relations  { sourceId, targetId, relationType }
 *   Create a directed edge. Guards:
 *     404 CMDB_NOT_FOUND       — source or target CI does not exist
 *     403 SITE_SCOPE_FORBIDDEN — EITHER endpoint's governing site (linked
 *                                device's site, else the siteId tag;
 *                                linkage-less CIs are global) is outside
 *                                the session's site scope (F-031 wave-10,
 *                                audit 13-c F-6 — the wave-7 mutation
 *                                contract, 403-not-404 on the mutation
 *                                plane)
 *     422 CMDB_SELF_RELATION   — source and target are the same CI
 *     409 CMDB_RELATION_EXISTS — the exact (source, target, type) edge
 *                                already exists (unique triple)
 *   Audit: CMDB_RELATION_CREATED (resourceLabel carries both CI ids so each
 *   endpoint's per-CI history picks the row up, even after removal).
 *
 * DELETE /api/v1/cmdb/relations?id=…
 *   Remove an edge. 404 CMDB_NOT_FOUND when unknown; 403
 *   SITE_SCOPE_FORBIDDEN when either endpoint's governing site is outside
 *   the session scope (the DELETE previously echoed the CI pair of
 *   out-of-scope edges — audit 13-c F-6).
 *   Audit: CMDB_RELATION_REMOVED (afterJson keeps the full edge for history).
 * ───────────────────────────────────────────────────────────────────────────── */

const createRelationSchema = z.object({
  sourceId: z.string().trim().min(1).max(64),
  targetId: z.string().trim().min(1).max(64),
  relationType: cmdbRelationTypeSchema,
});

export async function GET(request: Request) {
  // F-008 phase 4a (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  const url = new URL(request.url);

  const relationTypeParam = url.searchParams.get("relationType") ?? undefined;
  const parsedType = cmdbRelationTypeSchema.safeParse(relationTypeParam);
  if (relationTypeParam !== undefined && !parsedType.success) {
    return fail(
      "INVALID_QUERY",
      `relationType: must be one of ${cmdbRelationTypeSchema.options.join(", ")}`,
      400
    );
  }

  const itemIdParam = url.searchParams.get("itemId") ?? undefined;
  let itemIdFilter: string | undefined;
  if (itemIdParam !== undefined) {
    const item = await resolveCmdbItem(itemIdParam);
    if (!item) {
      return fail("CMDB_NOT_FOUND", `No configuration item matches "${itemIdParam}"`, 404);
    }
    // F-031 wave-9: out-of-scope CI → the SAME 404 as a missing one.
    const scopeClaims = await sessionScopeFor(request);
    const scope = sessionSiteScope(scopeClaims);
    if (
      scope.mode === "sites" &&
      !sessionAllowsSite(scopeClaims, await cmdbItemSiteCode(item))
    ) {
      return fail("CMDB_NOT_FOUND", `No configuration item matches "${itemIdParam}"`, 404);
    }
    itemIdFilter = item.id;
  }

  // F-031 wave-9: both endpoints must be visible for the edge to render.
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const ciScopeWhere: Prisma.CmdbItemWhereInput | undefined =
    scope.mode === "sites"
      ? {
          OR: [
            { device: { site: { code: { in: scope.codes } } } },
            { AND: [{ deviceId: null }, { siteId: { in: scope.codes } }] },
            { AND: [{ deviceId: null }, { siteId: null }] },
          ],
        }
      : undefined;

  const relations = await db.cmdbRelation.findMany({
    where: {
      ...(parsedType.success && relationTypeParam !== undefined
        ? { relationType: parsedType.data }
        : {}),
      ...(itemIdFilter
        ? { OR: [{ sourceId: itemIdFilter }, { targetId: itemIdFilter }] }
        : {}),
      ...(ciScopeWhere
        ? { AND: [{ source: ciScopeWhere }, { target: ciScopeWhere }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 500,
    include: {
      source: { select: CMDB_ITEM_SUMMARY_SELECT },
      target: { select: CMDB_ITEM_SUMMARY_SELECT },
    },
  });

  return ok(
    {
      relations: relations.map((rel) => ({
        id: rel.id,
        relationType: rel.relationType,
        source: rel.source as CmdbItemSummary,
        target: rel.target as CmdbItemSummary,
        createdAt: rel.createdAt.toISOString(),
      })),
      meta: { computedAt: new Date().toISOString() },
    },
    undefined,
    200
  );
}

export async function POST(request: Request) {

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = createRelationSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { sourceId, targetId, relationType } = parsed.data;

  // Phase 19-C (audit AUTHZ-001 sweep): creating relations requires the
  // "cmdb.write" permission; the actor is the session principal
  // (resolveActingUser replaced by requirePermission, "Admin" removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "cmdb.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const [source, target] = await Promise.all([
    resolveCmdbItem(sourceId),
    resolveCmdbItem(targetId),
  ]);
  if (!source || !target) {
    return fail(
      "CMDB_NOT_FOUND",
      `Unknown configuration item — ${!source ? `source "${sourceId}"` : `target "${targetId}"`} does not exist`,
      404
    );
  }

  // F-031 wave-10 (audit 13-c F-6): BOTH endpoints must be in scope — an
  // edge is a cross-object mutation, so one out-of-scope endpoint is enough
  // to refuse it. Existence 404 first, then the scope 403 (the wave-7
  // ordering).
  try {
    await requireSiteScope(request, await cmdbItemSiteCode(source));
    await requireSiteScope(request, await cmdbItemSiteCode(target));
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  if (source.id === target.id) {
    return fail(
      "CMDB_SELF_RELATION",
      "A CI cannot relate to itself",
      422
    );
  }

  const duplicate = await db.cmdbRelation.findFirst({
    where: { sourceId: source.id, targetId: target.id, relationType },
    select: { id: true },
  });
  if (duplicate) {
    return fail(
      "CMDB_RELATION_EXISTS",
      `${source.ciId} → ${target.ciId} (${relationType}) already exists`,
      409
    );
  }

  const actorName = actor.name ?? "Unknown user";
  const correlationId = newCorrelationId("REL");
  const resourceLabel = `${source.ciId} → ${target.ciId} (${relationType})`;

  let relationId: string;
  try {
    const created = await db.$transaction(async (tx) => {
      const relation = await tx.cmdbRelation.create({
        data: {
          sourceId: source.id,
          targetId: target.id,
          relationType,
        },
      });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName,
          action: "CMDB_RELATION_CREATED",
          resourceType: "CmdbRelation",
          resourceId: relation.id,
          resourceLabel,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            relationId: relation.id,
            source: source.ciId,
            target: target.ciId,
            relationType,
          }),
        },
      });
      return relation;
    });
    relationId = created.id;
  } catch (error) {
    // Unique (source, target, type) violation — the pre-check missed a
    // concurrent create of the same edge.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return fail(
        "CMDB_RELATION_EXISTS",
        `${source.ciId} → ${target.ciId} (${relationType}) already exists`,
        409
      );
    }
    throw error;
  }

  return ok(
    {
      relation: {
        id: relationId,
        relationType,
        source: { id: source.id, ciId: source.ciId, name: source.name },
        target: { id: target.id, ciId: target.ciId, name: target.name },
      },
      correlationId,
    },
    { actor: actorName },
    200
  );
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return fail("INVALID_QUERY", "id: relation id is required", 400);
  }

  // Phase 19-C (audit AUTHZ-001 sweep): removing relations requires the
  // "cmdb.write" permission; the actor is the session principal
  // (resolveActingUser replaced by requirePermission, "Admin" removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "cmdb.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const relation = await db.cmdbRelation.findUnique({
    where: { id },
    include: {
      // deviceId/siteId ride along for the F-031 wave-10 endpoint scope
      // gate (cmdbItemSiteCode) — the response/audit only reads ciId/name.
      source: { select: { ...CMDB_ITEM_SUMMARY_SELECT, deviceId: true, siteId: true } },
      target: { select: { ...CMDB_ITEM_SUMMARY_SELECT, deviceId: true, siteId: true } },
    },
  });
  if (!relation) {
    return fail("CMDB_NOT_FOUND", `No relation matches "${id}"`, 404);
  }

  // F-031 wave-10 (audit 13-c F-6): the DELETE mutation gate — both
  // endpoints must be in scope (the removed edge previously echoed the
  // out-of-scope CI pair through the audit row and the response).
  try {
    await requireSiteScope(request, await cmdbItemSiteCode(relation.source));
    await requireSiteScope(request, await cmdbItemSiteCode(relation.target));
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const actorName = actor.name ?? "Unknown user";
  const correlationId = newCorrelationId("REL");

  await db.$transaction(async (tx) => {
    await tx.cmdbRelation.delete({ where: { id: relation.id } });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName,
        action: "CMDB_RELATION_REMOVED",
        resourceType: "CmdbRelation",
        resourceId: relation.id,
        resourceLabel: `${relation.source.ciId} → ${relation.target.ciId} (${relation.relationType})`,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          source: relation.source.ciId,
          target: relation.target.ciId,
          relationType: relation.relationType,
        }),
      },
    });
  });

  return ok(
    { removed: relation.id, correlationId },
    { actor: actorName },
    200
  );
}

/* ───────────────────────── F-031 wave-9 helper ───────────────────────── */

/**
 * Resolve the CI's governing site code (the list predicate's linkage): the
 * LINKED DEVICE's site when device-linked (a site-less linked device
 * yields null, which HIDES the CI from sites-limited sessions); otherwise
 * the CI's own siteId tag; null when the CI has no site linkage (global
 * resource — the assertSiteScope(null) bypass).
 *
 * KEPT IN SYNC with the twin helpers in cmdb/items/route.ts and
 * cmdb/items/[id]/route.ts (no shared lib file in this wave's ownership).
 */
async function cmdbItemSiteCode(item: {
  deviceId: string | null;
  siteId: string | null;
}): Promise<string | null> {
  if (item.deviceId) {
    const device = await db.device.findUnique({
      where: { id: item.deviceId },
      select: { site: { select: { code: true } } },
    });
    return device?.site?.code ?? null;
  }
  return item.siteId;
}
