import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/notifications/read — mark notifications read (Task 5-a).
 *
 * Body: { ids?: string[], all?: boolean } — either a list of
 * ids or all:true. Only rows visible to the acting user (own + broadcast)
 * are touched; unread ones get readAt = now. Demo simplification: marking
 * a broadcast row read is global (SQLite demo has no per-user read state).
 * Returns { updated, unreadCount }.
 */
const readSchema = z
  .object({
    ids: z.array(z.string().trim().min(1).max(64)).max(100).optional(),
    all: z.boolean().optional(),
  })
  .refine(
    (data) => data.all === true || (data.ids !== undefined && data.ids.length > 0),
    { message: "Provide ids[] or all:true" }
  );

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = readSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }
  const visibility = {
    OR: [{ userId: null }, ...(actor ? [{ userId: actor.id }] : [])],
  };

  const updated = await db.notification.updateMany({
    where: {
      AND: [
        visibility,
        { readAt: null },
        ...(parsed.data.all ? [] : [{ id: { in: parsed.data.ids ?? [] } }]),
      ],
    },
    data: { readAt: new Date() },
  });

  const unreadCount = await db.notification.count({
    where: { AND: [visibility, { readAt: null }] },
  });

  return ok({ updated: updated.count, unreadCount });
}
