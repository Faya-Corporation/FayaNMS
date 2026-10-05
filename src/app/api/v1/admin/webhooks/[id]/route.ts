import { z } from "zod";

import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { classifyWebhookUrl } from "@/lib/integrations/ssrf-guard";
import {
  WEBHOOK_EVENT_CATALOG,
  webhookView,
} from "@/lib/integrations/webhooks";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/webhooks/[id] (Task 7-b)
 *
 * PATCH  — partial update: name / url / events / isActive (revoke = false).
 *          Regenerating the secret is NOT part of PATCH (keep it explicit —
 *          a future rotate endpoint would follow the api-clients pattern).
 * DELETE — remove the endpoint. Audited WEBHOOK_UPDATED / WEBHOOK_DELETED.
 */

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: z
    .string()
    .trim()
    .url("url must be a valid absolute URL")
    .refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
      message: "url must use http(s)",
    })
    .optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_CATALOG)).min(1).max(WEBHOOK_EVENT_CATALOG.length).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Phase 19-C (audit AUTHZ-001 sweep): admin-only gate (requireRole
    // replaces resolveAdminActor, whose UNAUTHENTICATED fallback let
    // anonymous callers through).
    let actor: Awaited<ReturnType<typeof requireRole>>;
    try {
      actor = await requireRole(request, "admin");
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
    }

    const existing = await db.webhookEndpoint.findUnique({ where: { id } });
    if (!existing) {
      return fail("WEBHOOK_NOT_FOUND", `No webhook endpoint with id ${id}`, 404);
    }

    // P1-010 (SSRF): an updated URL re-passes admission-time egress
    // classification (same policy as creation — rotation cannot be used to
    // smuggle a loopback/metadata target into the stored endpoint).
    if (parsed.data.url !== undefined) {
      const urlCheck = classifyWebhookUrl(parsed.data.url);
      if (!urlCheck.ok) {
        return fail("SSRF_BLOCKED", urlCheck.reason, 400);
      }
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.url !== undefined) data.url = parsed.data.url;
    if (parsed.data.events !== undefined) {
      data.eventsJson = JSON.stringify(parsed.data.events);
    }
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;

    // Wave-9 (audit 9-a F-2): the update and its WEBHOOK_UPDATED audit row
    // commit together.
    const correlationId = newCorrelationId("WH");
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.webhookEndpoint.update({ where: { id }, data });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? actor.email,
          action: "WEBHOOK_UPDATED",
          resourceType: "WebhookEndpoint",
          resourceId: id,
          resourceLabel: updated.name,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({
            name: existing.name,
            url: existing.url,
            isActive: existing.isActive,
          }),
          afterJson: JSON.stringify({
            name: updated.name,
            url: updated.url,
            isActive: updated.isActive,
          }),
        },
      });
      return updated;
    });

    return ok(
      { webhook: webhookView(row), audit: { correlationId } },
      undefined,
      200
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Phase 19-C (audit AUTHZ-001 sweep): admin-only gate (requireRole
    // replaces resolveAdminActor, whose UNAUTHENTICATED fallback let
    // anonymous callers through).
    let actor: Awaited<ReturnType<typeof requireRole>>;
    try {
      actor = await requireRole(request, "admin");
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
    const { id } = await params;

    const existing = await db.webhookEndpoint.findUnique({ where: { id } });
    if (!existing) {
      return fail("WEBHOOK_NOT_FOUND", `No webhook endpoint with id ${id}`, 404);
    }

    // Wave-9 (audit 9-a F-2): the delete and its WEBHOOK_DELETED audit row
    // commit together.
    const correlationId = newCorrelationId("WH");
    await db.$transaction(async (tx) => {
      await tx.webhookEndpoint.delete({ where: { id } });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? actor.email,
          action: "WEBHOOK_DELETED",
          resourceType: "WebhookEndpoint",
          resourceId: id,
          resourceLabel: existing.name,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({
            name: existing.name,
            url: existing.url,
          }),
        },
      });
    });

    return ok(
      { deleted: true, audit: { correlationId } },
      undefined,
      200
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
