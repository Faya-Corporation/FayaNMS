import { z } from "zod";

import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import {
  COLLECTOR_HEARTBEAT_INTERVAL_S,
  COLLECTOR_LEASE_TTL_MS,
  CollectorControlError,
  registerCollectorAgent,
} from "@/lib/collectors/control-plane";

export const dynamic = "force-dynamic";

/* ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/collectors/register — REAL collector control plane (GA-4b,
 * P0-R06/P1-O01). Machine plane: a collector agent registers itself with a
 * telemetry-scoped service JWT (the same plane it relays protocol events
 * on). Idempotent upsert by agentKey; re-registration refreshes
 * residency/version/capacity and reactivates a suspended agent.
 *
 * Response carries the liveness CONTRACT (heartbeat interval + lease TTL)
 * plus the agent's current ownership snapshot count — an agent never has to
 * guess the cadence.
 * ───────────────────────────────────────────────────────────────────────────── */

const registerSchema = z.object({
  agentKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]+$/, "agentKey may contain letters, digits, dot, underscore, colon, dash")
    .min(3)
    .max(120),
  displayName: z.string().trim().min(1).max(120),
  role: z.enum(["snmp", "netflow", "syslog", "config"]),
  siteCode: z.string().trim().min(1).max(64).optional(),
  version: z.string().trim().min(1).max(64).optional(),
  capacity: z.number().int().min(1).max(10_000).optional(),
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
  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  try {
    const { created, agent } = await registerCollectorAgent(
      {
        agentKey: parsed.data.agentKey,
        displayName: parsed.data.displayName,
        role: parsed.data.role,
        siteCode: parsed.data.siteCode ?? null,
        version: parsed.data.version ?? null,
        capacity: parsed.data.capacity ?? null,
      },
      auth.principal.id
    );

    const ownedCount = await db.collectorAssignment.count({
      where: { agentId: agent.id },
    });

    return ok(
      {
        created,
        agent: {
          agentKey: agent.agentKey,
          displayName: agent.displayName,
          role: agent.role,
          siteId: agent.siteId,
          region: agent.region,
          capacity: agent.capacity,
          status: agent.status,
        },
        ownedAssignments: ownedCount,
        heartbeatIntervalS: COLLECTOR_HEARTBEAT_INTERVAL_S,
        leaseTtlMs: COLLECTOR_LEASE_TTL_MS,
      },
      { plane: "real", subject: auth.principal.id },
      created ? 201 : 200
    );
  } catch (error) {
    if (error instanceof CollectorControlError) {
      return fail(error.code, error.message, error.status);
    }
    throw error;
  }
}
