import { db } from "@/lib/db";
import { authErrorToFail, requireSessionRead } from "@/lib/auth/session";
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
 * unreadCount. Identity = the authenticated session principal (P19 SEC-001).
 * `?unreadOnly=true` filters to unread.
 */
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  unreadOnly: z.enum(["true", "false"]).default("false"),
});

export async function GET(request: Request) {
  // F-008 phase 4b (read-plane defense-in-depth): the GET handler verifies
  // the human session itself (requireSessionRead) — the proxy matcher stays
  // the coarse gate, not the only check.
  try {
    await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    unreadOnly: url.searchParams.get("unreadOnly") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }
  // P2 (GA re-audit 2026-10-06) — read state is PER-USER: own rows ride
  // their row-level readAt; broadcasts are read for THIS user iff a
  // NotificationReceipt(notificationId, userId=me) exists. The broadcast
  // row's own readAt stays null (the nobody-read-it baseline).
  const visibility = {
    OR: [{ userId: null }, ...(actor ? [{ userId: actor.id }] : [])],
  };
  const unreadFilter = parsed.data.unreadOnly === "true"
    ? {
        OR: [
          { userId: actor.id, readAt: null as Date | null },
          { userId: null, receipts: { none: { userId: actor.id } } },
        ],
      }
    : {};

  const limit = parsed.data.limit;
  const [rows, unreadCount, total] = await Promise.all([
    db.notification.findMany({
      where: { AND: [visibility, unreadFilter] },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.notification.count({ where: { AND: [visibility, unreadFilter] } }),
    db.notification.count({ where: visibility }),
  ]);

  // Per-user receipts for THIS page — one query, then compose the effective
  // readAt (row-level first, receipt fallback for broadcasts).
  const receipts = await db.notificationReceipt.findMany({
    where: { userId: actor.id, notificationId: { in: rows.map((r) => r.id) } },
    select: { notificationId: true, readAt: true },
  });
  const receiptByNotification = new Map(receipts.map((r) => [r.notificationId, r.readAt]));

  return ok(
    rows.map((row) => ({
      ...row,
      readAt: row.readAt ?? receiptByNotification.get(row.id) ?? null,
      mine: row.userId !== null,
    })),
    { unreadCount, total, identity: actor ? { id: actor.id, name: actor.name } : null },
    200
  );
}
