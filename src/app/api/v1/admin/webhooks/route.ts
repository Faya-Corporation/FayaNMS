import { randomBytes } from "node:crypto";

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
import { authErrorToFail } from "@/lib/auth/session";
import {
  WEBHOOK_EVENT_CATALOG,
  webhookView,
} from "@/lib/integrations/webhooks";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/webhooks (Task 7-b)
 *
 * GET   — list webhook endpoints. The HMAC signing secret is NEVER
 *         returned in full — `secretMasked` shows "••••••••" + last 8.
 * POST  — create an endpoint: name + url + subscribed events[] → a 32-byte
 *         hex signing secret is generated server-side. The plaintext
 *         secret is included ONCE in the POST response as `secretOnce`.
 *         Audited WEBHOOK_CREATED (WH-XXXXXX correlation).
 */

const urlSchema = z
  .string()
  .trim()
  .url("url must be a valid absolute URL")
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "url must use http(s)",
  });

const createSchema = z.object({
  name: z.string().trim().min(1, "name cannot be empty").max(80),
  url: urlSchema,
  events: z
    .array(z.enum(WEBHOOK_EVENT_CATALOG))
    .min(1, "subscribe to at least one event")
    .max(WEBHOOK_EVENT_CATALOG.length),
  isActive: z.boolean().optional(),
});

export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);
    const rows = await db.webhookEndpoint.findMany({
      orderBy: { createdAt: "desc" },
    });
    return ok(
      {
        webhooks: rows.map(webhookView),
        events: WEBHOOK_EVENT_CATALOG,
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
    const { actor } = await resolveAdminActor(request);
    const body = await request.json().catch(() => null);
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
    }

    const secret = randomBytes(32).toString("hex");
    const row = await db.webhookEndpoint.create({
      data: {
        name: parsed.data.name,
        url: parsed.data.url,
        secret,
        eventsJson: JSON.stringify(parsed.data.events),
        isActive: parsed.data.isActive ?? true,
      },
    });

    const correlationId = newCorrelationId("WH");
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name,
        action: "WEBHOOK_CREATED",
        resourceType: "WebhookEndpoint",
        resourceId: row.id,
        resourceLabel: row.name,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          name: row.name,
          url: row.url,
          events: parsed.data.events,
          isActive: row.isActive,
        }),
      },
    });

    return ok(
      {
        webhook: webhookView(row),
        // The plaintext secret is returned exactly once, at creation.
        secretOnce: secret,
        audit: { correlationId },
      },
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
