import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { csvParam, fail, firstIssueMessage, ok } from "../_lib/api";
import { resolveActingUser, SOD_GATED_RISK_LEVELS } from "../_lib/actor";
import { changeScopeListWhere } from "../_lib/change-scope";
import { requireSessionRead, sessionScopeFor, authErrorToFail } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/approvals — approval queue across changes (Task 4-b).
 *
 * Query:
 *   status       csv multi over ChangeApproval.status (default "PENDING")
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
 *
 * Wave 10 (F-031, audit 13-b): the handler verifies the session itself
 * (requireSessionRead — the proxy's API-client branch admits any opaque
 * bearer shape; garbage tokens answer 401 here, valid API-client tokens
 * fall through to authenticateApiClientRead over the wired change.read
 * domain) and composes the session's site scope through the change
 * relation into the queue, the KPI counts and the "mine" computation
 * (site leg OR device-linked in-scope change — the shared change-plane
 * predicate; wildcard sessions keep the pre-wave-10 behavior byte-
 * identical). Approver/requester labels follow the F-029/R69 discipline:
 * admin/auditor keep the full email fallback, everyone else the
 * local-part.
 */

const querySchema = z.object({
  status: z.string().optional(),
  q: z.string().trim().max(120).optional(),
});

export async function GET(request: Request) {
  // F-1 (wave 10, audit 13-b P1): handler-level credential validation is
  // the FIRST step — before any DB access. The proxy's API-client branch
  // (step 3b) admits any opaque-shaped bearer on the documented trust that
  // "fail-closed lives in the handlers"; this handler now honors it.
  let principal: Awaited<ReturnType<typeof requireSessionRead>>;
  try {
    principal = await requireSessionRead(request);
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }
  // F-029/R69 email discipline: the full address is admin/auditor only.
  const fullEmail = principal.role === "admin" || principal.role === "auditor";
  // F-031: the session's site scope for the change leg (wildcard sessions
  // — absent claims — keep byte-identical behavior).
  const scopeLeg = changeScopeListWhere(await sessionScopeFor(request));

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    status: url.searchParams.get("status") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const statuses = csvParam(parsed.data.status) ?? ["PENDING"];
  const q = parsed.data.q;

  // F-031 (wave 10): the queue scopes through its change relation — the
  // same site-leg OR device-leg composition the changes list uses. The q
  // filter ANDs into the same change where.
  const where: Prisma.ChangeApprovalWhereInput = {
    status: { in: statuses },
    change: {
      AND: [
        q
          ? {
              OR: [{ number: { contains: q } }, { title: { contains: q } }],
            }
          : {},
        scopeLeg,
      ],
    },
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
    resolveActingUser(request),
  ]);

  const shaped = rows.map((row) => ({
    id: row.id,
    changeId: row.changeId,
    level: row.level,
    status: row.status,
    comment: row.comment,
    // F-029/R69: name or email LOCAL-PART — the full address stays
    // admin/auditor (changeUserLabel semantics).
    approverName: row.approver
      ? (row.approver.name ??
        (fullEmail ? row.approver.email : row.approver.email.split("@")[0] ?? null))
      : null,
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
      requesterName: row.change.requester
        ? (row.change.requester.name ??
          (fullEmail
            ? row.change.requester.email
            : row.change.requester.email.split("@")[0] ?? null))
        : null,
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
    // The KPI counts ride the same change scope leg as the queue (an
    // aggregate that ignored the scope would disclose cross-site activity).
    db.changeApproval.count({
      where: { status: "PENDING", change: scopeLeg },
    }),
    db.changeApproval.count({
      where: {
        status: "APPROVED",
        decidedAt: { gte: startOfToday },
        change: scopeLeg,
      },
    }),
    db.changeApproval.count({
      where: {
        status: "REJECTED",
        decidedAt: { gte: startOfToday },
        change: scopeLeg,
      },
    }),
  ]);

  // SoD-aware "awaiting my decision": PENDING rows the acting user may
  // legally decide (requester self-approval blocked on HIGH/CRITICAL).
  let mine: number | null = null;
  if (actor) {
    const pendingRows = await db.changeApproval.findMany({
      where: { status: "PENDING", change: scopeLeg },
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
