import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok, requestContext } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
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

async function loadItemDetail(id: string) {
  const item = await resolveCmdbItem(id);
  if (!item) return null;

  const [outgoing, incoming, audits] = await Promise.all([
    db.cmdbRelation.findMany({
      where: { sourceId: item.id },
      orderBy: [{ relationType: "asc" }, { id: "asc" }],
      include: { target: { select: CMDB_ITEM_SUMMARY_SELECT } },
    }),
    db.cmdbRelation.findMany({
      where: { targetId: item.id },
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
        result: true,
        actorName: true,
        resourceLabel: true,
        correlationId: true,
        afterJson: true,
        createdAt: true,
      },
    }),
  ]);

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
      ownerName: owner ? owner.name ?? owner.email ?? owner.id : null,
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
    audits: audits.map((a) => ({
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
  const ctx = requestContext(request);
  const { id } = await params;

  const detail = await loadItemDetail(id);
  if (!detail) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${id}"`, 404, ctx);
  }

  // Zod-validated response contract — a malformed payload fails loudly
  // instead of shipping a shape the client cannot trust (HA precedent).
  const validated = detailResponseSchema.parse(detail) as ItemDetail;

  return ok(validated, undefined, 200, ctx);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = requestContext(request);
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
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, ctx);
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
      422,
      ctx
    );
  }

  const parsed = updateItemSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, ctx);
  }
  const data = parsed.data;
  if (Object.keys(data).length === 0) {
    return fail(
      "INVALID_BODY",
      "No fields to update — provide status, criticality, ownerId or description",
      400,
      ctx
    );
  }

  const item = await resolveCmdbItem(id);
  if (!item) {
    return fail("CMDB_NOT_FOUND", `No configuration item matches "${id}"`, 404, ctx);
  }

  if (data.ownerId) {
    const owner = await db.user.findUnique({
      where: { id: data.ownerId },
      select: { id: true },
    });
    if (!owner) {
      return fail("UNKNOWN_OWNER", "The referenced owner (user) does not exist", 422, ctx);
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
    const detail = await loadItemDetail(id);
    return ok(detail, { unchanged: true }, 200, ctx);
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
    200,
    ctx
  );
}
