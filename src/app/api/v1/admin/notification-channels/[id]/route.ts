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
import { channelView } from "@/lib/integrations/webhooks";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/notification-channels/[id] (Task 7-b)
 *
 * PATCH  — partial update: name / config / isActive.
 * DELETE — remove the channel. Audited CHANNEL_UPDATED / CHANNEL_DELETED.
 */

const configSchema = z.object({
  address: z.string().trim().email().optional(),
  displayName: z.string().trim().max(80).optional(),
  url: z.string().trim().url().optional(),
});

/**
 * Parse a stored configJson for the CHANNEL_UPDATED audit snapshot (wave-9
 * audit 9-a F-2). The schema is CLOSED (address / displayName / url only —
 * no credential fields exist in the channel config), so the full config is
 * recorded — mirroring how CHANNEL_CREATED and the webhook routes record
 * the URL. A malformed stored row degrades to {} (never throws, never
 * invents fields).
 */
function parseStoredConfig(configJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: configSchema.optional(),
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

    const existing = await db.notificationChannel.findUnique({ where: { id } });
    if (!existing) {
      return fail("CHANNEL_NOT_FOUND", `No notification channel with id ${id}`, 404);
    }

    // P1-010 (SSRF): an updated WEBHOOK channel URL re-passes the
    // admission-time egress classification (same policy as creation).
    if (parsed.data.config?.url !== undefined) {
      const urlCheck = classifyWebhookUrl(parsed.data.config.url);
      if (!urlCheck.ok) {
        return fail("SSRF_BLOCKED", urlCheck.reason, 400);
      }
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.config !== undefined) {
      data.configJson = JSON.stringify(parsed.data.config);
    }
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;

    // Wave-9 (audit 9-a F-2): the update and its CHANNEL_UPDATED audit row
    // commit together, and the audit payload now carries the FULL config
    // before/after (name/isActive-only snapshots hid URL/email retargets).
    const correlationId = newCorrelationId("CH");
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.notificationChannel.update({ where: { id }, data });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? actor.email,
          action: "CHANNEL_UPDATED",
          resourceType: "NotificationChannel",
          resourceId: id,
          resourceLabel: updated.name,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({
            name: existing.name,
            isActive: existing.isActive,
            config: parseStoredConfig(existing.configJson),
          }),
          afterJson: JSON.stringify({
            name: updated.name,
            isActive: updated.isActive,
            config: parseStoredConfig(updated.configJson),
          }),
        },
      });
      return updated;
    });

    return ok(
      { channel: channelView(row), audit: { correlationId } },
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

    const existing = await db.notificationChannel.findUnique({ where: { id } });
    if (!existing) {
      return fail("CHANNEL_NOT_FOUND", `No notification channel with id ${id}`, 404);
    }

    // Wave-9 (audit 9-a F-2): the delete and its CHANNEL_DELETED audit row
    // commit together.
    const correlationId = newCorrelationId("CH");
    await db.$transaction(async (tx) => {
      await tx.notificationChannel.delete({ where: { id } });
      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? actor.email,
          action: "CHANNEL_DELETED",
          resourceType: "NotificationChannel",
          resourceId: id,
          resourceLabel: existing.name,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({ name: existing.name, type: existing.type }),
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
