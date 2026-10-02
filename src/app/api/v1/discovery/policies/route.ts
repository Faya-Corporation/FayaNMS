import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission, requireSessionRead } from "@/lib/auth/session";
import {
  DISCOVERY_ALLOWED_PORTS,
  DISCOVERY_DEFAULT_INTERVAL_MINUTES,
  firstGovernedDiscoverySubnet,
  normalizeDiscoveryPolicyConfig,
} from "@/lib/discovery/policy";
import { z } from "zod";

export const dynamic = "force-dynamic";

// F-038 sub-fix (found while pinning the route): this regex previously had
// only THREE octet groups — it rejected EVERY valid 4-octet CIDR (the whole
// policy-POST surface was dead on arrival with INVALID_BODY) while ACCEPTING
// malformed 3-octet shapes ("10.60.0/24"). Now four octets + /24-/32 prefix,
// matching the scan route's CIDR_PATTERN and discoveryTargetCount.
const ipv4Cidr = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(3[0-2]|2[4-9])$/;

const policySchema = z.object({
  name: z.string().trim().min(1).max(120),
  subnets: z.array(z.string().trim().regex(ipv4Cidr, "must be an IPv4 /24-/32 subnet")).min(1).max(4),
  ports: z.array(z.number().int().min(1).max(65_535)).min(1).max(DISCOVERY_ALLOWED_PORTS.length).optional(),
  intervalMinutes: z.number().int().min(5).max(1_440).default(DISCOVERY_DEFAULT_INTERVAL_MINUTES),
  enabled: z.boolean().default(false),
}).strict();

function serializePolicy(policy: {
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
    // The normalized write path prevents this; an invalid row is surfaced
    // with empty values instead of being treated as a runnable policy.
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
    return await requirePermission(request, "device.read");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}

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
  const actor = await actorFor(request);
  if (actor instanceof Response) return actor;
  return ok(
    await db.discoveryPolicy.findMany({
      orderBy: { name: "asc" },
    }).then((policies) => policies.map(serializePolicy)),
  );
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = policySchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  let actor;
  try {
    actor = await requirePermission(request, "device.write");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }

  const config = normalizeDiscoveryPolicyConfig(parsed.data);
  if (!config) {
    // F-038 — governed special-address subnets get a precise detail
    // (the class + the documented lab hatch) instead of the generic policy
    // message; the generic message keeps the other refusal reasons.
    const governed = firstGovernedDiscoverySubnet(parsed.data.subnets);
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
  try {
    const policy = await db.$transaction(async (tx) => {
      const created = await tx.discoveryPolicy.create({
        data: {
          name: parsed.data.name,
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
          action: "DISCOVERY_POLICY_CREATED",
          resourceType: "DiscoveryPolicy",
          resourceId: created.id,
          resourceLabel: created.name,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            name: created.name,
            subnets: config.subnets,
            ports: config.ports,
            intervalMinutes: config.intervalMinutes,
            enabled: config.enabled,
          }),
        },
      });
      return created;
    });
    return ok({ policy: serializePolicy(policy), correlationId }, undefined, 201);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return fail("DUPLICATE_POLICY", "A discovery policy with this name already exists", 409);
    }
    throw error;
  }
}
