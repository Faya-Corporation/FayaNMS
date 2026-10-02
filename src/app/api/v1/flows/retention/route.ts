import { db } from "@/lib/db";
import { authErrorToFail, requirePermission, requireSessionRead } from "@/lib/auth/session";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../_lib/api";
import {
  FLOW_RETENTION_KEY,
  flowRetentionSchema,
  parseStoredFlowRetention,
  readFlowRetentionSetting,
} from "@/lib/flows/retention";

export const dynamic = "force-dynamic";

async function requireAdminSystem(request: Request) {
  try {
    return await requirePermission(request, "admin.system");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
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
  const actor = await requireAdminSystem(request);
  if ("status" in actor) return actor;
  return ok(parseStoredFlowRetention((await readFlowRetentionSetting())?.valueJson));
}

export async function PUT(request: Request) {
  const actor = await requireAdminSystem(request);
  if ("status" in actor) return actor;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = flowRetentionSchema.safeParse(body);
  if (!parsed.success) return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);

  const existing = await readFlowRetentionSetting();
  const stored = parseStoredFlowRetention(existing?.valueJson);
  const updated = {
    ...parsed.data,
    lastPrunedAt: stored.lastPrunedAt,
    lastPruneResult: stored.lastPruneResult,
  };
  const afterJson = JSON.stringify(updated);
  const correlationId = newCorrelationId("RET");

  await db.$transaction(async (tx) => {
    await tx.setting.upsert({
      where: { key: FLOW_RETENTION_KEY },
      update: { valueJson: afterJson },
      create: { key: FLOW_RETENTION_KEY, valueJson: afterJson },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? "Unknown user",
        action: "SETTINGS_UPDATED",
        resourceType: "Setting",
        resourceId: FLOW_RETENTION_KEY,
        resourceLabel: "Flow retention policy",
        result: "SUCCESS",
        correlationId,
        beforeJson: JSON.stringify(stored),
        afterJson,
      },
    });
  });

  return ok({ ...updated, audit: { correlationId } });
}
