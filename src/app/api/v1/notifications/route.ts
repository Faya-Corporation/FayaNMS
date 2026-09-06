import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../_lib/api";
import { resolveActingUser } from "../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/notifications — the notifications center feed (Task 5-a).
 *
 * §74: notifications are a separate surface from the operational alert
 * stream (approval requested / report ready / backup completed — plus the
 * engine's ALERT/INCIDENT notices that deep-link into those views).
 *
 * Returns the latest rows visible to the acting demo user: their own rows
 * (userId = me) + broadcasts (userId null), newest first. Meta carries
 * unreadCount. `?actAsUserId=` selects the demo identity (default admin).
 * `?unreadOnly=true` filters to unread.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  actAsUserId: z.string().trim().max(64).optional(),
  unreadOnly: z.enum(["true", "false"]).default("false"),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    actAsUserId: url.searchParams.get("actAsUserId") ?? undefined,
    unreadOnly: url.searchParams.get("unreadOnly") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const actor = await resolveActingUser(parsed.data.actAsUserId);
  const visibility = {
    OR: [{ userId: null }, ...(actor ? [{ userId: actor.id }] : [])],
  };
  const where = {
    AND: [
      visibility,
      parsed.data.unreadOnly === "true" ? { readAt: null } : {},
    ],
  };

  const limit = parsed.data.limit;
  const [rows, unreadCount, total] = await Promise.all([
    db.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.notification.count({ where: { AND: [visibility, { readAt: null }] } }),
    db.notification.count({ where: visibility }),
  ]);

  return ok(
    rows.map((row) => ({ ...row, mine: row.userId !== null })),
    { unreadCount, total, identity: actor ? { id: actor.id, name: actor.name } : null }
  );
}
