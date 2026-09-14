import { z } from "zod";

import { db } from "@/lib/db";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  requestContext,
} from "../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail, requireRole } from "@/lib/auth/session";
import { classifyWebhookUrl } from "@/lib/integrations/ssrf-guard";
import {
  NOTIFICATION_CHANNEL_TYPES,
  channelView,
} from "@/lib/integrations/webhooks";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/notification-channels (Task 7-b)
 *
 * Notification delivery targets shown in the Integrations admin view.
 * EMAIL  → configJson: { address, displayName? } — demo mode records
 *          "queued" outcomes (no SMTP in the sandbox).
 * WEBHOOK → configJson: { url } — the test path reuses the signed
 *          webhook delivery semantics.
 *
 * GET  — list channels (config parsed, safe fields only).
 * POST — create (audited CHANNEL_CREATED, CH-XXXXXX correlation).
 */

const configSchema = z.object({
  address: z.string().trim().email().optional(),
  displayName: z.string().trim().max(80).optional(),
  url: z
    .string()
    .trim()
    .url()
    .refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
      message: "url must use http(s)",
    })
    .optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1, "name cannot be empty").max(80),
  type: z.enum(NOTIFICATION_CHANNEL_TYPES),
  config: configSchema,
  isActive: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);
    const rows = await db.notificationChannel.findMany({
      orderBy: { createdAt: "desc" },
    });
    return ok(
      {
        channels: rows.map(channelView),
        types: NOTIFICATION_CHANNEL_TYPES,
      },
      undefined,
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

export async function POST(request: Request) {
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
    const body = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
    }

    // Type/config cross-checks so a channel is always internally consistent.
    const { type, config } = parsed.data;
    if (type === "EMAIL" && !config.address) {
      return fail("INVALID_BODY", "EMAIL channels require config.address", 400);
    }
    if (type === "WEBHOOK" && !config.url) {
      return fail("INVALID_BODY", "WEBHOOK channels require config.url", 400);
    }
    // P1-010 (SSRF): the channel's webhook target passes the same
    // admission-time egress classification as webhook endpoints.
    if (config.url) {
      const urlCheck = classifyWebhookUrl(config.url);
      if (!urlCheck.ok) {
        return fail("SSRF_BLOCKED", urlCheck.reason, 400);
      }
    }

    const row = await db.notificationChannel.create({
      data: {
        name: parsed.data.name,
        type,
        configJson: JSON.stringify(config),
        isActive: parsed.data.isActive ?? true,
      },
    });

    const correlationId = newCorrelationId("CH");
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "CHANNEL_CREATED",
        resourceType: "NotificationChannel",
        resourceId: row.id,
        resourceLabel: row.name,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({ name: row.name, type, config }),
      },
    });

    return ok(
      { channel: channelView(row), audit: { correlationId } },
      undefined,
      201,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
