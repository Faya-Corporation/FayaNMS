import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/notifications/read — mark notifications read (Task 5-a).
 *
 * Body: { ids?: string[], all?: boolean } — either a list of ids or
 * all:true. Only rows visible to the acting user (own + broadcast) are
 * touched; unread ones get read.
 *
 * P2 (GA re-audit 2026-10-06) — PER-USER read state: marking a broadcast
 * read is no longer global. Own rows keep their row-level readAt; broadcasts
 * get a NotificationReceipt(notificationId, userId, readAt) UPSERT for the
 * acting user — every other user still sees the broadcast unread. The
 * broadcast row's own readAt stays null (it is the "nobody read it yet"
 * baseline, not a per-user flag).
 * Returns { updated, unreadCount } — `updated` counts rows+receipts this
 * call created/touched for the CALLING user only.
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

  const idFilter = parsed.data.all ? [] : [{ id: { in: parsed.data.ids ?? [] } }];

  // Own rows: the row-level readAt (per-user rows, already user-scoped).
  const own = await db.notification.updateMany({
    where: {
      AND: [{ userId: actor.id }, { readAt: null }, ...idFilter],
    },
    data: { readAt: new Date() },
  });

  // Broadcasts: a per-user receipt (P2) — never the global row.readAt.
  const broadcastTargets = await db.notification.findMany({
    where: {
      AND: [{ userId: null }, ...idFilter],
    },
    select: { id: true },
  });
  const now = new Date();
  let receiptCount = 0;
  for (const target of broadcastTargets) {
    const receipt = await db.notificationReceipt.upsert({
      where: {
        notificationId_userId: { notificationId: target.id, userId: actor.id },
      },
      create: { notificationId: target.id, userId: actor.id, readAt: now },
      update: {}, // already read by this user — idempotent, readAt preserved
    });
    if (receipt.readAt.getTime() === now.getTime()) receiptCount += 1;
  }

  const unreadCount = await db.notification.count({
    where: {
      OR: [
        { userId: actor.id, readAt: null },
        { userId: null, receipts: { none: { userId: actor.id } } },
      ],
    },
  });

  return ok({ updated: own.count + receiptCount, unreadCount });
}
