import { db } from "@/lib/db";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../_lib/api";
import {
  FLOW_RETENTION_CHUNK_SIZE,
  FLOW_RETENTION_KEY,
  FLOW_RETENTION_MAX_DELETES_PER_RUN,
  flowRetentionCutoff,
  parseStoredFlowRetention,
  readFlowRetentionSetting,
  shouldPruneFlowRecords,
} from "@/lib/flows/retention";
import { z } from "zod";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  triggeredBy: z.string().trim().min(1).max(40).optional(),
}).strict();

export async function POST(request: Request) {
  const auth = authenticateServiceRequest(request, "jobs");
  if (!auth.ok) {
    return fail(auth.code, auth.message, auth.code === "SERVICE_SCOPE_INSUFFICIENT" ? 403 : 401);
  }

  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsedBody = bodySchema.safeParse(body);
  if (!parsedBody.success) return fail("INVALID_BODY", firstIssueMessage(parsedBody.error), 400);

  const policy = parseStoredFlowRetention((await readFlowRetentionSetting())?.valueJson);
  const now = new Date();
  const cutoff = flowRetentionCutoff(now, policy.days);
  const correlationId = newCorrelationId("RET");
  const startedAt = Date.now();

  const result = await db.$transaction(async (tx) => {
    let flowRecordsDeleted = 0;
    if (shouldPruneFlowRecords(policy)) {
      const batches = FLOW_RETENTION_MAX_DELETES_PER_RUN / FLOW_RETENTION_CHUNK_SIZE;
      for (let batchNumber = 0; batchNumber < batches; batchNumber += 1) {
        const expired = await tx.flowRecord.findMany({
          where: { receivedAt: { lt: cutoff } },
          orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
          take: FLOW_RETENTION_CHUNK_SIZE,
          select: { id: true },
        });
        if (expired.length === 0) break;
        const deleted = await tx.flowRecord.deleteMany({
          where: {
            id: { in: expired.map((row) => row.id) },
            receivedAt: { lt: cutoff },
          },
        });
        flowRecordsDeleted += deleted.count;
      }
    }

    const durationMs = Date.now() - startedAt;
    const prunedAt = now.toISOString();
    const outcome = policy.enabled ? "pruned" : "disabled";
    const pruneResult = {
      outcome,
      flowRecordsDeleted,
      durationMs,
      retentionDays: policy.days,
      cutoff: cutoff.toISOString(),
      triggeredBy: parsedBody.data.triggeredBy ?? "SCHEDULE",
      prunedAt,
      correlationId,
    };
    const updatedPolicy = {
      days: policy.days,
      enabled: policy.enabled,
      lastPrunedAt: prunedAt,
      lastPruneResult: pruneResult,
    };
    await tx.setting.upsert({
      where: { key: FLOW_RETENTION_KEY },
      update: { valueJson: JSON.stringify(updatedPolicy) },
      create: { key: FLOW_RETENTION_KEY, valueJson: JSON.stringify(updatedPolicy) },
    });
    await tx.auditEvent.create({
      data: {
        actorName: "system:flow-retention-worker",
        action: "FLOW_RECORDS_PRUNED",
        resourceType: "FlowRecord",
        resourceLabel: "Flow retention prune",
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify(pruneResult),
      },
    });
    return pruneResult;
  }, { maxWait: 5_000, timeout: 30_000 });

  return ok(result);
}
