import { db } from "@/lib/db";
import { csvParam, fail, firstIssueMessage, ok } from "../_lib/api";
import { resolveActingUser, SOD_GATED_RISK_LEVELS } from "../_lib/actor";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/approvals — approval queue across changes (Task 4-b).
 *
 * Query:
 *   status       csv multi over ChangeApproval.status (default "PENDING")
 *   actAsUserId  demo acting user (id or username key) — feeds the
 *                "awaiting my decision" meta count (SoD-aware)
 *   q            change number/title contains
 *
 * Rows are per approval row, joined with the change (number/title/type/
 * riskLevel/status/requester). The change join also carries every level
 * row of the change, so the queue table can group by change and render a
 * status chip per level (PENDING neutral / APPROVED success / REJECTED
 * danger) without a second round-trip.
 *
 * Ordering: undecided (decidedAt null) first, then by the change's
 * scheduledStart (nulls last), then level. meta carries the KPI counts
 * for the approvals view: { pending, mine, approvedToday, rejectedToday }.
 */

const querySchema = z.object({
  status: z.string().optional(),
  actAsUserId: z.string().trim().max(64).optional(),
  q: z.string().trim().max(120).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    actAsUserId: url.searchParams.get("actAsUserId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const statuses = csvParam(parsed.data.status) ?? ["PENDING"];
  const q = parsed.data.q;

  const where = {
    status: { in: statuses },
    ...(q
      ? {
          change: {
            OR: [{ number: { contains: q } }, { title: { contains: q } }],
          },
        }
      : {}),
  };

  const [rows, actor] = await Promise.all([
    db.changeApproval.findMany({
      where,
      take: 400,
      include: {
        approver: { select: { name: true, email: true } },
        change: {
          include: {
            requester: { select: { name: true, email: true } },
            approvals: { select: { level: true, status: true } },
          },
        },
      },
    }),
    resolveActingUser(parsed.data.actAsUserId),
  ]);

  const shaped = rows.map((row) => ({
    id: row.id,
    changeId: row.changeId,
    level: row.level,
    status: row.status,
    comment: row.comment,
    approverName: row.approver?.name ?? row.approver?.email ?? null,
    decidedAt: row.decidedAt,
    change: {
      id: row.change.id,
      number: row.change.number,
      title: row.change.title,
      type: row.change.type,
      status: row.change.status,
      riskScore: row.change.riskScore,
      riskLevel: row.change.riskLevel,
      requesterId: row.change.requesterId,
      requesterName: row.change.requester?.name ?? row.change.requester?.email ?? null,
      createdAt: row.change.createdAt,
      scheduledStart: row.change.scheduledStart,
      /** Every approval level of the change with its current status. */
      levels: row.change.approvals
        .map((approval) => ({ level: approval.level, status: approval.status }))
        .sort((a, b) => a.level.localeCompare(b.level)),
    },
  }));

  // decidedAt-nulls-first, then change.scheduledStart (nulls last), then level.
  const timeOf = (value: Date | null) =>
    value ? value.getTime() : Number.POSITIVE_INFINITY;
  shaped.sort((a, b) => {
    const decided = timeOf(a.decidedAt) - timeOf(b.decidedAt);
    if (decided !== 0) return decided;
    const scheduled = timeOf(a.change.scheduledStart) - timeOf(b.change.scheduledStart);
    if (scheduled !== 0) return scheduled;
    return a.level.localeCompare(b.level);
  });

  // KPI meta (independent of the status filter for pending/today counts).
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [pendingTotal, approvedToday, rejectedToday] = await Promise.all([
    db.changeApproval.count({ where: { status: "PENDING" } }),
    db.changeApproval.count({
      where: { status: "APPROVED", decidedAt: { gte: startOfToday } },
    }),
    db.changeApproval.count({
      where: { status: "REJECTED", decidedAt: { gte: startOfToday } },
    }),
  ]);

  // SoD-aware "awaiting my decision": PENDING rows the acting user may
  // legally decide (requester self-approval blocked on HIGH/CRITICAL).
  let mine: number | null = null;
  if (actor) {
    const pendingRows = await db.changeApproval.findMany({
      where: { status: "PENDING" },
      select: { change: { select: { requesterId: true, riskLevel: true } } },
    });
    mine = pendingRows.filter(
      (row) =>
        row.change.requesterId !== actor.id ||
        !SOD_GATED_RISK_LEVELS.includes(row.change.riskLevel)
    ).length;
  }

  return ok(shaped, {
    pending: pendingTotal,
    mine,
    approvedToday,
    rejectedToday,
  });
}
