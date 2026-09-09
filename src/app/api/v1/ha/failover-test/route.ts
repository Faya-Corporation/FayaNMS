import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok, requestContext } from "../../_lib/api";
import { resolveActingUser } from "../../_lib/actor";
import {
  defaultActiveMember,
  FAILOVER_STAGE_SLEEP_MS,
  failoverStagesForMode,
  findHaPair,
  type HaFailoverStageMeta,
} from "@/lib/ha/topology";
import { z } from "zod";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/ha/failover-test — deterministic staged failover simulation
 * (Phase 14-c). Body: { pairId }.
 *
 * Guards, in order:
 *   404 HA_PAIR_NOT_FOUND    — unknown pairId (pairs are the in-code matrix)
 *   409 HA_TEST_IN_PROGRESS  — the NEWEST HA_FAILOVER_TEST audit row for the
 *                              pair is < 3 minutes old (audit-as-event-store
 *                              lookup — no schema, no locks)
 *
 * Execution — Next-side DETERMINISTIC staged simulation (no worker, no
 * schema): the stage sleeps come from the shared FAILOVER_STAGE_SLEEP_MS
 * table (~4.2s total) and EVERY stage writes ONE HA_FAILOVER_TEST audit row
 * with a shared correlationId (HA-XXXXXX) and { pairId, stage, result }
 * metadata; a final row { stage: "complete", result, durationMs } closes
 * the test. GET /api/v1/ha derives the pair's failover state from exactly
 * these rows.
 *
 * Outcome: all stages ALWAYS pass deterministically unless a pair member is
 * currently OFFLINE in the DB — then every stage carries result "degraded"
 * with the offline member(s) named in the metadata. The route still answers
 * 200 (the test itself ran; "degraded" is a measured outcome, not an error).
 * ───────────────────────────────────────────────────────────────────────────── */

const TEST_COOLDOWN_MS = 3 * 60 * 1000;

const testSchema = z.object({
  pairId: z.string().trim().min(1).max(64),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(request: Request) {
  const ctx = requestContext(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400, ctx);
  }

  const parsed = testSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400, ctx);
  }
  const { pairId } = parsed.data;

  const pair = findHaPair(pairId);
  if (!pair) {
    return fail(
      "HA_PAIR_NOT_FOUND",
      `Unknown HA pair "${pairId}" — see GET /api/v1/ha for the registered pairs`,
      404,
      ctx
    );
  }

  // Audit-as-event-store cooldown: the newest test row for this pair must
  // be at least 3 minutes old before another run may start.
  const latest = await db.auditEvent.findFirst({
    where: { action: "HA_FAILOVER_TEST", resourceType: "HaPair", resourceId: pair.pairId },
    select: { correlationId: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (latest && Date.now() - latest.createdAt.getTime() < TEST_COOLDOWN_MS) {
    const waitSec = Math.max(
      1,
      Math.ceil((TEST_COOLDOWN_MS - (Date.now() - latest.createdAt.getTime())) / 1000)
    );
    return fail(
      "HA_TEST_IN_PROGRESS",
      `A failover test for ${pair.name} ran less than 3 minutes ago (${latest.correlationId ?? "no correlation"}) — wait ${waitSec}s before re-running`,
      409,
      ctx
    );
  }

  // Live member status decides the deterministic outcome.
  const memberDevices = await db.device.findMany({
    where: { hostname: { in: [...pair.members] } },
    select: { id: true, hostname: true, status: true },
  });
  const statusByHostname = new Map(
    memberDevices.map((d) => [d.hostname, d.status])
  );
  const offlineMembers = pair.members.filter(
    (hostname) => statusByHostname.get(hostname) === "OFFLINE"
  );
  const result: "passed" | "degraded" =
    offlineMembers.length > 0 ? "degraded" : "passed";

  const actor = await resolveActingUser(request);
  if (!actor) {
    return fail("UNAUTHENTICATED", "Sign in required — no valid session was provided.", 401);
  }
  const actorName = actor?.name ?? "Admin";
  const correlationId = newCorrelationId("HA");
  const startedAt = Date.now();
  const stages = failoverStagesForMode(pair.mode);

  // Active member after the test settles: active-standby promotes back to
  // the original primary; active-active rebalances across both members.
  const activeMember = defaultActiveMember(pair);

  const stageResults: { stage: string; result: string; at: string }[] = [];

  for (const stage of stages) {
    await sleep(FAILOVER_STAGE_SLEEP_MS[stage] ?? 1000);
    const stageMember =
      stage === "promote"
        ? pair.members[1]
        : stage === "promote-back"
          ? pair.members[0]
          : undefined;
    const meta: HaFailoverStageMeta = {
      pairId: pair.pairId,
      stage,
      result,
      ...(stageMember ? { member: stageMember } : {}),
      ...(offlineMembers.length > 0 ? { offlineMembers: [...offlineMembers] } : {}),
    };
    await db.auditEvent.create({
      data: {
        actorId: actor?.id,
        actorName,
        action: "HA_FAILOVER_TEST",
        resourceType: "HaPair",
        resourceId: pair.pairId,
        resourceLabel: pair.name,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify(meta),
      },
    });
    stageResults.push({ stage, result, at: new Date().toISOString() });
  }

  const durationMs = Date.now() - startedAt;

  // Final row closes the test — this is the row deriveFailoverState reads.
  const completeMeta: HaFailoverStageMeta = {
    pairId: pair.pairId,
    stage: "complete",
    result,
    activeMember,
    durationMs,
    ...(offlineMembers.length > 0 ? { offlineMembers: [...offlineMembers] } : {}),
  };
  await db.auditEvent.create({
    data: {
      actorId: actor?.id,
      actorName,
      action: "HA_FAILOVER_TEST",
      resourceType: "HaPair",
      resourceId: pair.pairId,
      resourceLabel: pair.name,
      result: "SUCCESS",
      correlationId,
      afterJson: JSON.stringify(completeMeta),
    },
  });

  return ok(
    {
      pairId: pair.pairId,
      pairName: pair.name,
      mode: pair.mode,
      correlationId,
      result,
      durationMs,
      stages: stageResults,
      activeMember,
      offlineMembers: [...offlineMembers],
      vip: pair.vip,
    },
    { actor: actorName },
    200,
    ctx
  );
}
