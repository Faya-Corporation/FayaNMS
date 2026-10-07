import { z } from "zod";

import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import {
  COLLECTOR_HEARTBEAT_INTERVAL_S,
  COLLECTOR_LEASE_TTL_MS,
  CollectorControlError,
  processHeartbeat,
} from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/collectors/heartbeat — REAL collector control plane (GA-4b).
 * Machine plane (telemetry-scoped service JWT). The agent reports every
 * assignment it still holds as {deviceId, leaseEpoch} pairs; the server:
 *   - refreshes liveness (lastHeartbeatAt),
 *   - RENEWS leases whose owner+epoch both match,
 *   - FENCES everything else with the precise reason (unknown-assignment /
 *     not-owner / stale-epoch / agent-suspended) so the agent drops exactly
 *     the state it no longer owns.
 * Healthy heartbeats write no audit rows (30s cadence); a heartbeat that
 * fences writes ONE aggregated COLLECTOR_AGENT_FENCED row.
 * ───────────────────────────────────────────────────────────────────────────── */

const heartbeatSchema = z.object({
  agentKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]+$/)
    .min(3)
    .max(120),
  claims: z
    .array(
      z.object({
        deviceId: z.string().trim().min(1).max(64),
        leaseEpoch: z.number().int().min(0),
      })
    )
    .max(5_000),
});

export async function POST(request: Request) {
  const auth = authenticateServiceRequest(request, "telemetry");
  if (!auth.ok) return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = heartbeatSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  try {
    const result = await processHeartbeat(
      parsed.data.agentKey,
      parsed.data.claims,
      new Date()
    );
    return ok(
      {
        ...result,
        heartbeatIntervalS: COLLECTOR_HEARTBEAT_INTERVAL_S,
        leaseTtlMs: COLLECTOR_LEASE_TTL_MS,
      },
      { plane: "real", subject: auth.principal.id },
      200
    );
  } catch (error) {
    if (error instanceof CollectorControlError) {
      return fail(error.code, error.message, error.status);
    }
    throw error;
  }
}
