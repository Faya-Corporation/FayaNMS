import { db } from "@/lib/db";
import { fail, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import {
  COLLECTOR_HEARTBEAT_INTERVAL_S,
  COLLECTOR_LEASE_TTL_MS,
} from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * GET /api/v1/collectors/assignments?agentKey=… — REAL collector control
 * plane (GA-4b). Machine plane (telemetry-scoped service JWT). Poll
 * fallback for agents that lost their in-memory state (restart, deploy):
 * returns the CURRENT ownership snapshot this agent is expected to claim —
 * deviceId + leaseEpoch per row — so the next heartbeat re-syncs without
 * ever resurrecting a fenced epoch.
 * ───────────────────────────────────────────────────────────────────────────── */

export async function GET(request: Request) {
  const auth = authenticateServiceRequest(request, "telemetry");
  if (!auth.ok) return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);

  const agentKey = new URL(request.url).searchParams.get("agentKey")?.trim();
  if (!agentKey || !/^[A-Za-z0-9._:-]{3,120}$/.test(agentKey)) {
    return fail("INVALID_QUERY", "agentKey query parameter is required (3–120 chars)", 400);
  }

  const agent = await db.collectorAgent.findUnique({
    where: { agentKey },
    select: { id: true, agentKey: true, status: true, capacity: true },
  });
  if (!agent) {
    return fail("COLLECTOR_AGENT_UNKNOWN", `No registered agent "${agentKey}" — register first`, 404);
  }

  const assignments = await db.collectorAssignment.findMany({
    where: { agentId: agent.id },
    orderBy: { deviceId: "asc" },
    select: {
      deviceId: true,
      leaseEpoch: true,
      leasedUntil: true,
      via: true,
      assignedBy: true,
      assignedAt: true,
      device: { select: { hostname: true, status: true } },
    },
  });

  return ok(
    {
      agent: {
        agentKey: agent.agentKey,
        status: agent.status,
        capacity: agent.capacity,
      },
      assignments: assignments.map((row) => ({
        deviceId: row.deviceId,
        hostname: row.device.hostname,
        deviceStatus: row.device.status,
        leaseEpoch: row.leaseEpoch,
        leasedUntil: row.leasedUntil?.toISOString() ?? null,
        via: row.via,
        assignedBy: row.assignedBy,
        assignedAt: row.assignedAt.toISOString(),
      })),
      heartbeatIntervalS: COLLECTOR_HEARTBEAT_INTERVAL_S,
      leaseTtlMs: COLLECTOR_LEASE_TTL_MS,
    },
    { plane: "real", subject: auth.principal.id },
    200
  );
}
