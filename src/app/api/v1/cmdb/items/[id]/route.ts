import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import {
  authErrorToFail,
  requirePermission,
  requireSessionRead,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionAllowsSite, sessionSiteScope } from "@/lib/auth/scope";
import {
  CMDB_ITEM_SUMMARY_SELECT,
  cmdbCriticalitySchema,
  cmdbStatusSchema,
  resolveCmdbItem,
} from "@/lib/cmdb/server";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * CMDB — single configuration item (Phase 15-a)
 *
 * GET /api/v1/cmdb/items/[id]
 *   Full CI record: the item (device + owner resolved), its relations in
 *   BOTH directions (outgoing: this → target; incoming: source → this, each
 *   joined to the counterpart summary) and the recent CMDB_* audit rows that
 *   touch the CI — either directly (resourceId) or through its relations
 *   (resourceLabel contains the stable CI-… identifier, so removed-relation
 *   history survives the relation row itself).
 *   `[id]` accepts the cuid primary key OR the CI-000NNN identifier.
 *   Read-only → no audit event (app convention).
 *
 *   F-031 wave-9 (read-plane migration): the CI detail is gated by the
 *   same visibility predicate the list uses — the linked device's site
 *   code, else the CI's siteId tag; a CI with no site linkage is a global
 *   resource. An out-of-scope CI answers the SAME `CMDB_NOT_FOUND` 404
 *   envelope a wildcard session gets for a missing CI (404-not-403 — no
 *   existence leak). The relation lists drop edges whose counterpart is
 *   out-of-scope, and the audit rows drop entries referencing
 *   out-of-scope/unresolvable CIs (labels embed CI- identifiers of BOTH
 *   relation endpoints). Wildcard sessions keep the byte-unchanged
 *   queries.
 *
 * PATCH /api/v1/cmdb/items/[id]
 *   Update status / criticality / ownerId / description. Guards:
 *     404 CMDB_NOT_FOUND           — unknown CI
 *     400 INVALID_BODY             — schema violation (strict: unknown keys
 *                                    are rejected)
 *     422 DEVICE_LINK_IMMUTABLE    — a deviceId key was supplied; the device
 *                                    link is established at creation time and
 *                                    is intentionally not editable
 *   Audit: CMDB_CI_UPDATED with before/after carrying ONLY the changed fields.
 * ───────────────────────────────────────────────────────────────────────────── */

const updateItemSchema = z
  .object({
    status: cmdbStatusSchema.optional(),
    criticality: cmdbCriticalitySchema.optional(),
    ownerId: z.string().trim().min(1).max(64).nullable().optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
  })
  .strict();

async function loadItemDetail(
  id: string,
  scoped: {
    claims: Parameters<typeof sessionSiteScope>[0];
    ciScopeWhere: Prisma.CmdbItemWhereInput;
  } | null
) {
  const item = await resolveCmdbItem(id);
  if (!item) return null;

  const [outgoing, incoming, audits] = await Promise.all([
    db.cmdbRelation.findMany({
      where: {
        sourceId: item.id,
        // F-031 wave-9: hide edges whose counterpart is out-of-scope.
        ...(scoped ? { target: scoped.ciScopeWhere } : {}),
      },
      orderBy: [{ relationType: "asc" }, { id: "asc" }],
      include: { target: { select: CMDB_ITEM_SUMMARY_SELECT } },
    }),
    db.cmdbRelation.findMany({
      where: {
        targetId: item.id,
        ...(scoped ? { source: scoped.ciScopeWhere } : {}),
      },
      orderBy: [{ relationType: "asc" }, { id: "asc" }],
      include: { source: { select: CMDB_ITEM_SUMMARY_SELECT } },
    }),
    db.auditEvent.findMany({
      where: {
        action: { startsWith: "CMDB_" },
        OR: [{ resourceId: item.id }, { resourceLabel: { contains: item.ciId } }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 12,
      select: {
        action: true,
        resourceType: true,
        resourceId: true,
        result: true,
        actorName: true,
        resourceLabel: true,
        correlationId: true,
        afterJson: true,
        createdAt: true,
      },
    }),
  ]);

  // F-031 wave-9: relation rows label BOTH endpoints ("CI-A → CI-B") —
  // drop rows referencing an out-of-scope or unresolvable counterpart.
  const scopedAudits = scoped
    ? await filterCmdbAuditsForScope(scoped.claims, audits)
    : audits;

  const [device, owner] = await Promise.all([
    item.deviceId
      ? db.device.findUnique({
          where: { id: item.deviceId },
          select: { id: true, hostname: true, status: true, model: true },
        })
      : Promise.resolve(null),
    item.ownerId
      ? db.user.findUnique({
          where: { id: item.ownerId },
          select: { id: true, name: true, email: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    item: {
      id: item.id,
      ciId: item.ciId,
      name: item.name,
      ciType: item.ciType,
      status: item.status,
      criticality: item.criticality,
      environment: item.environment,
      serviceTier: item.serviceTier,
      description: item.description,
      siteId: item.siteId,
      deviceId: item.deviceId,
      device: device
        ? {
            id: device.id,
            hostname: device.hostname,
            status: device.status,
            model: device.model,
          }
        : null,
      ownerId: item.ownerId,
      // R69 re-review discipline (mirrors meta/users): the fallback is the
      // email LOCAL-PART — a bare `?? owner.email` ships the full address
      // of any owner whose name is null.
      ownerName: owner ? owner.name ?? owner.email.split("@")[0] ?? owner.id : null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    },
    outgoing: outgoing.map((rel) => ({
      id: rel.id,
      relationType: rel.relationType,
      counterpart: rel.target,
      createdAt: rel.createdAt.toISOString(),
    })),
    incoming: incoming.map((rel) => ({
      id: rel.id,
      relationType: rel.relationType,
      counterpart: rel.source,
      createdAt: rel.createdAt.toISOString(),
    })),
    audits: scopedAudits.map((a) => ({
      action: a.action,
      result: a.result,
      actorName: a.actorName,
      resourceLabel: a.resourceLabel,
      correlationId: a.correlationId,
      afterJson: a.afterJson,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

type ItemDetail = NonNullable<Awaited<ReturnType<typeof loadItemDetail>>>;

const detailResponseSchema = z.object({
  item: z.object({
    id: z.string(),
    ciId: z.string(),
    name: z.string(),
    ciType: z.string(),
    status: z.string(),
    criticality: z.string(),
    environment: z.string(),
    serviceTier: z.string(),
    description: z.string().nullable(),
    siteId: z.string().nullable(),
    deviceId: z.string().nullable(),
    device: z
      .object({
        id: z.string(),
        hostname: z.string(),
        status: z.string(),
        model: z.string().nullable(),
      })
      .nullable(),
    ownerId: z.string().nullable(),
    ownerName: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  outgoing: z.array(
    z.object({
      id: z.string(),
      relationType: z.string(),
      counterpart: z.object({
        id: z.string(),
        ciId: z.string(),
        name: z.string(),
        ciType: z.string(),
        status: z.string(),
        criticality: z.string(),
        environment: z.string(),
        serviceTier: z.string(),
      }),
      createdAt: z.string(),
    })
  ),
  incoming: z.array(
    z.object({
      id: z.string(),
      relationType: z.string(),
      counterpart: z.object({
        id: z.string(),
        ciId: z.string(),
        name: z.string(),
        ciType: z.string(),
        status: z.string(),
        criticality: z.string(),
        environment: z.string(),
        serviceTier: z.string(),
      }),
      createdAt: z.string(),
    })
  ),
  audits: z.array(
    z.object({
      action: z.string(),
      result: z.string(),
      actorName: z.string(),
      resourceLabel: z.string().nullable(),
      correlationId: z.string().nullable(),
      afterJson: z.string().nullable(),
      createdAt: z.string(),
    })
  ),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
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
  const { id } = await params;

  // F-031 wave-9: resolve the scope and gate the target CI BEFORE any
  // detail assembly. The SAME CMDB_NOT_FOUND envelope answers a missing CI
  // and an out-of-scope CI (404-not-403 — a 403 would confirm existence).
  const scopeClaims = await sessionScopeFor(request);
  const scope = sessionSiteScope(scopeClaims);
  const isWildcard = scope.mode === "wildcard";
  // Sites-limited sessions scope the CI legs; the wildcard path never
  // consumes ciScopeWhere (every use is guarded).
  const scopedCodes = scope.mode === "sites" ? scope.codes : [];
  const ciScopeWhere: Prisma.CmdbItemWhereInput = {
    OR: [
      { device: { site: { code: { in: scopedCodes } } } },
      { AND: [{ deviceId: null }, { siteId: { in: scopedCodes } }] },
      { AND: [{ deviceId: null }, { siteId: null }] },
    ],
  };

  const target = await resolveCmdbItem(id);
  if (!target) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${id}"`, 404);
  }
  if (
    !isWildcard &&
    !sessionAllowsSite(scopeClaims, await cmdbItemSiteCode(target))
  ) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${id}"`, 404);
  }

  const detail = await loadItemDetail(
    id,
    isWildcard ? null : { claims: scopeClaims, ciScopeWhere }
  );
  if (!detail) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${id}"`, 404);
  }

  // Zod-validated response contract — a malformed payload fails loudly
  // instead of shipping a shape the client cannot trust (HA precedent).
  const validated = detailResponseSchema.parse(detail) as ItemDetail;

  return ok(validated, undefined, 200);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Phase 19-C (audit AUTHZ-001 sweep): updating configuration items
  // requires the "cmdb.write" permission; the actor is the session
  // principal (resolveActingUser replaced by requirePermission, and the
  // "Admin" actorName fallback removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "cmdb.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  // The device link is established at creation and intentionally immutable —
  // reject it explicitly (before the schema strips/strict-rejects it) so the
  // client gets an actionable code instead of a generic schema error.
  if (
    body &&
    typeof body === "object" &&
    "deviceId" in (body as Record<string, unknown>)
  ) {
    return fail(
      "DEVICE_LINK_IMMUTABLE",
      "The device link is set at CI creation and cannot be changed — create a new CI for a different device",
      422
    );
  }

  const parsed = updateItemSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;
  if (Object.keys(data).length === 0) {
    return fail(
      "INVALID_BODY",
      "No fields to update — provide status, criticality, ownerId or description",
      400
    );
  }

  const item = await resolveCmdbItem(id);
  if (!item) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${id}"`, 404);
  }

  if (data.ownerId) {
    const owner = await db.user.findUnique({
      where: { id: data.ownerId },
      select: { id: true },
    });
    if (!owner) {
      return fail("UNKNOWN_OWNER", "The referenced owner (user) does not exist", 422);
    }
  }

  // Changed-fields-only before/after for a lean, reviewable audit row.
  const before: Record<string, string | null> = {};
  const after: Record<string, string | null> = {};
  const patch: Record<string, string | null> = {};
  const track = (key: string, next: string | null, prev: string | null) => {
    if (next === prev) return;
    before[key] = prev;
    after[key] = next;
    patch[key] = next;
  };
  track("status", data.status ?? item.status, item.status);
  track("criticality", data.criticality ?? item.criticality, item.criticality);
  track(
    "ownerId",
    data.ownerId === undefined ? item.ownerId : data.ownerId,
    item.ownerId
  );
  track(
    "description",
    data.description === undefined ? item.description : data.description,
    item.description
  );

  if (Object.keys(patch).length === 0) {
    // Nothing actually changed — return the current state without an audit row.
    const detail = await loadItemDetail(id, null);
    return ok(detail, { unchanged: true }, 200);
  }

  const actorName = actor.name ?? "Unknown user";
  const correlationId = newCorrelationId("CI");

  const [updated] = await db.$transaction([
    db.cmdbItem.update({
      where: { id: item.id },
      data: patch,
    }),
    db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName,
        action: "CMDB_CI_UPDATED",
        resourceType: "CmdbItem",
        resourceId: item.id,
        resourceLabel: `${item.ciId} — ${item.name}`,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify(before),
        afterJson: JSON.stringify(after),
      },
    }),
  ]);

  return ok(
    {
      item: {
        id: updated.id,
        ciId: updated.ciId,
        name: updated.name,
        ciType: updated.ciType,
        status: updated.status,
        criticality: updated.criticality,
        environment: updated.environment,
        serviceTier: updated.serviceTier,
        siteId: updated.siteId,
        deviceId: updated.deviceId,
        ownerId: updated.ownerId,
        description: updated.description,
      },
      correlationId,
    },
    { actor: actorName },
    200
  );
}

/* ───────────────────────── F-031 wave-9 helpers ───────────────────────── */

/**
 * Resolve the CI's governing site code: the LINKED DEVICE's site when
 * device-linked (a site-less linked device yields null, which HIDES the CI
 * from sites-limited sessions — row-level parity with the device rules);
 * otherwise the CI's own siteId tag; null when the CI has no site linkage
 * at all (a global resource — the assertSiteScope(null) bypass).
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

type CmdbAuditRow = {
  action: string;
  resourceType: string;
  resourceId: string | null;
  resourceLabel: string | null;
  result: string;
  actorName: string | null;
  correlationId: string | null;
  afterJson: string | null;
  createdAt: Date;
};

/**
 * Scope-filter the CMDB_* audit rows for sites-limited sessions — a row
 * passes only when EVERY CI- identifier it references (resourceLabel
 * tokens; a CmdbItem row's resourceId) resolves to a visible CI. Labels
 * embed "CI-A → CI-B" for relation rows, so an out-of-scope counterpart
 * drops the row; stale references (removed relation / deleted CI) drop it
 * fail-closed. Rows without CI references pass. Wildcard never calls this.
 *
 * KEPT IN SYNC with the twin helper in cmdb/items/route.ts (no shared lib
 * file in this wave's ownership).
 */
async function filterCmdbAuditsForScope(
  claims: Parameters<typeof sessionSiteScope>[0],
  rows: CmdbAuditRow[]
): Promise<CmdbAuditRow[]> {
  const labelTokens = new Set<string>();
  const itemResourceIds: string[] = [];
  for (const row of rows) {
    for (const token of row.resourceLabel?.match(/CI-\d{6}/g) ?? []) {
      labelTokens.add(token);
    }
    if (row.resourceType === "CmdbItem" && row.resourceId) {
      itemResourceIds.push(row.resourceId);
    }
  }
  if (labelTokens.size === 0 && itemResourceIds.length === 0) return rows;

  const referenced = await db.cmdbItem.findMany({
    where: {
      OR: [
        ...(itemResourceIds.length > 0 ? [{ id: { in: itemResourceIds } }] : []),
        ...(labelTokens.size > 0 ? [{ ciId: { in: [...labelTokens] } }] : []),
      ],
    },
    select: {
      id: true,
      ciId: true,
      deviceId: true,
      siteId: true,
      device: { select: { site: { select: { code: true } } } },
    },
  });

  const visibleById = new Set<string>();
  const visibleByCiId = new Set<string>();
  for (const item of referenced) {
    const visible = item.deviceId
      ? sessionAllowsSite(claims, item.device?.site?.code ?? null)
      : item.siteId === null || sessionAllowsSite(claims, item.siteId);
    if (visible) {
      visibleById.add(item.id);
      visibleByCiId.add(item.ciId);
    }
  }

  return rows.filter((row) => {
    for (const token of row.resourceLabel?.match(/CI-\d{6}/g) ?? []) {
      if (!visibleByCiId.has(token)) return false;
    }
    if (row.resourceType === "CmdbItem" && row.resourceId) {
      if (!visibleById.has(row.resourceId)) return false;
    }
    return true;
  });
}
