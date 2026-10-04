import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import {
  DISCOVERY_ALLOWED_PORTS,
  DISCOVERY_DEFAULT_INTERVAL_MINUTES,
  firstGovernedDiscoverySubnet,
  normalizeDiscoveryPolicyConfig,
  parseStoredDiscoveryPolicy,
} from "@/lib/discovery/policy";
import { z } from "zod";

export const dynamic = "force-dynamic";

const policyPatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  subnets: z.array(z.string().trim()).min(1).max(4).optional(),
  ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(DISCOVERY_ALLOWED_PORTS.length).optional(),
  intervalMinutes: z.number().int().min(5).max(1_440).optional(),
  enabled: z.boolean().optional(),
}).strict();

function responsePolicy(policy: {
  id: string;
  name: string;
  subnetsJson: string;
  portsJson: string;
  intervalMinutes: number;
  enabled: boolean;
  lastEnqueuedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  let subnets: unknown = [];
  let ports: unknown = [...DISCOVERY_ALLOWED_PORTS];
  try {
    subnets = JSON.parse(policy.subnetsJson);
    ports = JSON.parse(policy.portsJson);
  } catch {
    // Invalid persisted JSON is never made runnable.
  }
  return {
    id: policy.id,
    name: policy.name,
    subnets,
    ports,
    intervalMinutes: policy.intervalMinutes,
    enabled: policy.enabled,
    lastEnqueuedAt: policy.lastEnqueuedAt?.toISOString() ?? null,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

async function actorFor(request: Request) {
  try {
    return await requirePermission(request, "device.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const actor = await actorFor(request);
  if (actor instanceof Response) return actor;
  const { id } = await context.params;
  if (!id.trim()) return fail("INVALID_ID", "Policy id is required", 400);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = policyPatchSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  if (Object.keys(parsed.data).length === 0) return fail("INVALID_BODY", "At least one policy field is required", 400);

  const existing = await db.discoveryPolicy.findUnique({ where: { id } });
  if (!existing) return fail("POLICY_NOT_FOUND", "The discovery policy does not exist", 404);
  const current = parseStoredDiscoveryPolicy(
    existing.subnetsJson,
    existing.portsJson,
    existing.intervalMinutes,
    existing.enabled,
  );
  if (!current) return fail("INVALID_POLICY", "The stored discovery policy is invalid and cannot be enabled", 409);

  const mergedSubnets = parsed.data.subnets ?? current.subnets;
  const config = normalizeDiscoveryPolicyConfig({
    subnets: mergedSubnets,
    ports: parsed.data.ports ?? current.ports,
    intervalMinutes: parsed.data.intervalMinutes ?? current.intervalMinutes,
    enabled: parsed.data.enabled ?? current.enabled,
  });
  if (!config) {
    // F-038 — governed special-address subnets get a precise detail
    // (the class + the documented lab hatch) instead of the generic policy
    // message; the generic message keeps the other refusal reasons.
    const governed = firstGovernedDiscoverySubnet(mergedSubnets);
    if (governed) {
      return fail(
        "INVALID_POLICY",
        "Discovery subnet " + governed.subnet + " targets a governed address class (" + governed.addressClass + ") — remove it or set FAYANMS_PROBE_ALLOW_SPECIAL=true for lab environments.",
        400,
      );
    }
    return fail(
      "INVALID_POLICY",
      "Discovery policy must contain only bounded /24-/32 subnets, approved TCP management ports, and no more than 1,024 targets.",
      400,
    );
  }

  const correlationId = newCorrelationId("DISC");
  const updated = await db.$transaction(async (tx) => {
    const policy = await tx.discoveryPolicy.update({
      where: { id },
      data: {
        name: parsed.data.name ?? existing.name,
        subnetsJson: JSON.stringify(config.subnets),
        portsJson: JSON.stringify(config.ports),
        intervalMinutes: config.intervalMinutes,
        enabled: config.enabled,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "DISCOVERY_POLICY_UPDATED",
        resourceType: "DiscoveryPolicy",
        resourceId: policy.id,
        resourceLabel: policy.name,
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify({
          name: existing.name,
          subnets: current.subnets,
          ports: current.ports,
          intervalMinutes: current.intervalMinutes,
          enabled: current.enabled,
        }),
        afterJson: JSON.stringify({
          name: policy.name,
          subnets: config.subnets,
          ports: config.ports,
          intervalMinutes: config.intervalMinutes,
          enabled: config.enabled,
        }),
      },
    });
    return policy;
  });
  return ok({ policy: responsePolicy(updated), correlationId });
}
