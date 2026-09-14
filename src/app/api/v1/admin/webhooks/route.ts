import { randomBytes, randomUUID } from "node:crypto";

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
import { encryptAtRest, webhookSecretAad } from "@/lib/config/crypto";
import { classifyWebhookUrl } from "@/lib/integrations/ssrf-guard";
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

    // P1-010 (SSRF): admission-time egress classification — the stored URL
    // may never name loopback / private / link-local / metadata space (nor
    // any encoded IP literal the OS resolver would read as such).
    const urlCheck = classifyWebhookUrl(parsed.data.url);
    if (!urlCheck.ok) {
      return fail("SSRF_BLOCKED", urlCheck.reason, 400);
    }

    // P1-011 (secret at rest): the HMAC signing secret is encrypted under
    // the deployment KEK with AAD binding it to THIS endpoint row before it
    // ever touches the database; the plaintext is returned exactly once.
    // The id is pre-generated so the AAD context exists before the insert.
    const endpointId = randomUUID();
    const secret = randomBytes(32).toString("hex");
    const row = await db.webhookEndpoint.create({
      data: {
        id: endpointId,
        name: parsed.data.name,
        url: parsed.data.url,
        secret: encryptAtRest(secret, webhookSecretAad(endpointId)),
        eventsJson: JSON.stringify(parsed.data.events),
        isActive: parsed.data.isActive ?? true,
      },
    });

    const correlationId = newCorrelationId("WH");
    await db.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
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
