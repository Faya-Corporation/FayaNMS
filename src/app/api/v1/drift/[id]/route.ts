import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/drift/[id] — triage a drift record (Task 3-c).
 *
 * Body: { action: "ACCEPT" | "RESOLVE" }
 *   ACCEPT  → status ACCEPTED (deviation acknowledged as intentional)
 *   RESOLVE → status RESOLVED  (device was brought back into compliance)
 * Both set resolvedAt = now. Only OPEN records can transition — anything
 * else is a 409 INVALID_TRANSITION (keep-the-state-machine-honest rule).
 *
 * Audited DRIFT_ACCEPTED / DRIFT_RESOLVED with before/after JSON and a
 * DFT-prefixed correlation id.
 */

const patchSchema = z.object({
  action: z.enum(["ACCEPT", "RESOLVE"]),
});

const ID_MAX = 64;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid drift record id", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  // Phase 19-C (audit AUTHZ-001 sweep): drift triage requires the
  // "config.baseline" permission and the audit row is attributed to the
  // session principal (the seeded-admin fallback actor is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.baseline");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { action } = parsed.data;

  const record = await db.driftRecord.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      deviceId: true,
      detectedAt: true,
      resolvedAt: true,
      diffSummary: true,
      device: { select: { hostname: true } },
    },
  });
  if (!record) {
    return fail("DRIFT_RECORD_NOT_FOUND", "The drift record does not exist", 404);
  }

  if (record.status !== "OPEN") {
    return fail(
      "INVALID_TRANSITION",
      `Only OPEN drift records can be triaged (this one is ${record.status})`,
      409
    );
  }

  const correlationId = newCorrelationId("DFT");
  const now = new Date();
  const nextStatus = action === "ACCEPT" ? "ACCEPTED" : "RESOLVED";

  const updated = await db.$transaction(
    async (tx) => {
      const row = await tx.driftRecord.update({
        where: { id },
        data: { status: nextStatus, resolvedAt: now },
      });

      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? "Unknown user",
          action: action === "ACCEPT" ? "DRIFT_ACCEPTED" : "DRIFT_RESOLVED",
          resourceType: "DriftRecord",
          resourceId: id,
          resourceLabel: record.device.hostname,
          result: "SUCCESS",
          correlationId,
          beforeJson: JSON.stringify({
            status: record.status,
            resolvedAt: record.resolvedAt,
          }),
          afterJson: JSON.stringify({
            status: nextStatus,
            resolvedAt: now,
            diffSummary: record.diffSummary,
          }),
        },
      });

      return row;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok({
    record: {
      id: updated.id,
      deviceId: updated.deviceId,
      status: updated.status,
      resolvedAt: updated.resolvedAt,
    },
    audit: {
      action: action === "ACCEPT" ? "DRIFT_ACCEPTED" : "DRIFT_RESOLVED",
      correlationId,
    },
  });
}
