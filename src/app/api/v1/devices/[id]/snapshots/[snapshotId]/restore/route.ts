import { db } from "@/lib/db";
import { fail, firstIssueMessage, newCorrelationId, ok } from "../../../../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/[id]/snapshots/[snapshotId]/restore
 * Guarded restore-as-change flow (Task 3-c). A restore is NEVER a one-click
 * action: this endpoint creates an EMERGENCY ChangeRequest that the Phase 4
 * execution engine will run — it does not push configuration itself.
 *
 * Body: { confirmHostname: string }
 *   - confirmHostname must match the device hostname EXACTLY
 *     (case-sensitive) — 400 CONFIRM_MISMATCH otherwise.
 *
 * AUTHORIZATION (P19 / audit SEC-006 + Phase 19-C AUTHZ-101C): the requester
 * is the authenticated session principal (401 UNAUTHENTICATED otherwise) AND
 * must hold the dedicated "config.restore" permission (403 RBAC_FORBIDDEN
 * otherwise — seeded to operator + engineer; admin via wildcard). A viewer
 * can no longer file emergency restores merely because an approval follows:
 * requesting a restore is itself a privileged, audited act. The flow NEVER
 * auto-approves — the `autoApprove` flag and seeded-identity approvals were
 * removed: restore changes always land AWAITING_APPROVAL and a real human
 * holder of the required approval level must decide through the audited
 * approvals API (which enforces separation of duties — the requester cannot
 * approve their own HIGH/CRITICAL restore). Break-glass/fast-path execution
 * is a deliberate future capability (MFA + reason + expiry + notification),
 * not a request-body boolean.
 *
 * Risk heuristic (simple, deterministic):
 *   base 45 (target version is not the latest)  + 15 open drift records
 *   + 10 CRITICAL device criticality             → clamped 0..100
 *   riskLevel: LOW <21 · MEDIUM <41 · HIGH <71 · CRITICAL ≥71
 *
 * The change ships with 5 PENDING ChangeSteps
 *   1 CHECK    Verify device reachable
 *   2 BACKUP   Pre-restore backup
 *   3 APPLY    Apply baseline configuration
 *   4 VALIDATE Post-restore validation
 *   5 BACKUP   Post-restore backup
 * and a ChangeDevice link. The change always enters AWAITING_APPROVAL —
 * steps stay PENDING until a real approver decides and the executor claims
 * the scheduled change.
 */

const restoreSchema = z.object({
  confirmHostname: z.string().trim().min(1).max(255),
});

const ID_MAX = 64;

function riskLevelFor(score: number): string {
  if (score >= 71) return "CRITICAL";
  if (score >= 41) return "HIGH";
  if (score >= 21) return "MEDIUM";
  return "LOW";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; snapshotId: string }> }
) {
  const { id, snapshotId } = await params;
  if (!id || id.length > ID_MAX || !snapshotId || snapshotId.length > ID_MAX) {
    return fail("INVALID_ID", "Invalid device or snapshot id", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = restoreSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const { confirmHostname } = parsed.data;

  // The restore requester is the authenticated principal AND must hold
  // "config.restore" (Phase 19-C / audit AUTHZ-101C — 401/403 otherwise).
  // No synthesized identity may file a high-risk restore (P19 SEC-001/006).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.restore");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true, criticality: true },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  // Guarded confirmation: exact, case-sensitive hostname match.
  if (confirmHostname !== device.hostname) {
    return fail(
      "CONFIRM_MISMATCH",
      `Confirmation text does not match the hostname "${device.hostname}"`,
      400
    );
  }

  // The snapshot MUST belong to the device in the URL.
  const snapshot = await db.configSnapshot.findFirst({
    where: { id: snapshotId, deviceId: device.id },
    select: { id: true, version: true, sha256: true, status: true },
  });
  if (!snapshot) {
    return fail(
      "SNAPSHOT_NOT_FOUND",
      "The requested configuration snapshot does not exist for this device",
      404
    );
  }

  // Risk heuristic inputs.
  const [latest, openDrifts] = await Promise.all([
    db.configSnapshot.findFirst({
      where: { deviceId: device.id },
      orderBy: { version: "desc" },
      select: { version: true },
    }),
    db.driftRecord.count({ where: { deviceId: device.id, status: "OPEN" } }),
  ]);

  let riskScore = 0;
  if (snapshot.version !== (latest?.version ?? 0)) riskScore += 45;
  if (openDrifts > 0) riskScore += 15;
  if (device.criticality === "CRITICAL") riskScore += 10;
  riskScore = Math.min(100, Math.max(0, riskScore));
  const riskLevel = riskLevelFor(riskScore);

  // Next change number: CHG-<currentYear>-NNNNN (max existing +1, padded 5).
  const maxChange = await db.changeRequest.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const maxSeq = Number.parseInt(maxChange?.number.slice(-5) ?? "0", 10);
  const nextNumber = `CHG-${new Date().getFullYear()}-${String(
    (Number.isFinite(maxSeq) ? maxSeq : 0) + 1
  ).padStart(5, "0")}`;

  const correlationId = newCorrelationId("RST");
  const status = "AWAITING_APPROVAL";

  const change = await db.$transaction(
    async (tx) => {
      const created = await tx.changeRequest.create({
        data: {
          number: nextNumber,
          title: `Config restore ${device.hostname} to v${snapshot.version}`,
          description: [
            `Guarded restore of ${device.hostname} to snapshot v${snapshot.version} (approved via the HighRiskActionDialog flow).`,
            `Restore source: snapshot ${snapshot.id} · v${snapshot.version} · sha256 ${snapshot.sha256}.`,
            `Risk heuristic: not-latest version +45, ${openDrifts} open drift record(s) +${openDrifts > 0 ? 15 : 0}, criticality ${device.criticality} +${device.criticality === "CRITICAL" ? 10 : 0} → score ${riskScore} (${riskLevel}).`,
            "Awaiting approval in the Changes queue; step execution starts once a real approver (per approval policy, SoD-enforced) decides and the change is scheduled.",
            `Correlation ID: ${correlationId}`,
          ].join("\n"),
          type: "EMERGENCY",
          status,
          riskScore,
          riskLevel,
          requesterId: actor.id,
          ownerId: actor.id,
          scheduledStart: null,
          implementationPlan:
            "Restore the approved configuration snapshot via the change executor: pre-check reachability, capture a pre-restore backup, apply the stored configuration, validate, then capture a post-restore backup.",
          validationPlan:
            "Post-restore validation: device reachable, running-config sha256 matches the restored snapshot, no new drift vs baseline.",
          rollbackPlan:
            "Re-apply the pre-restore backup captured in step 2 (its sha256 is the rollback reference).",
        },
      });

      await tx.changeDevice.create({
        data: { changeId: created.id, deviceId: device.id, result: "PENDING" },
      });

      await tx.changeStep.createMany({
        data: [
          {
            changeId: created.id,
            order: 1,
            name: "Verify device reachable",
            type: "CHECK",
            status: "PENDING",
          },
          {
            changeId: created.id,
            order: 2,
            name: "Pre-restore backup",
            type: "BACKUP",
            status: "PENDING",
          },
          {
            changeId: created.id,
            order: 3,
            name: "Apply baseline configuration",
            type: "APPLY",
            status: "PENDING",
          },
          {
            changeId: created.id,
            order: 4,
            name: "Post-restore validation",
            type: "VALIDATE",
            status: "PENDING",
          },
          {
            changeId: created.id,
            order: 5,
            name: "Post-restore backup",
            type: "BACKUP",
            status: "PENDING",
          },
        ],
      });

      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? "Unknown user",
          action: "RESTORE_REQUESTED",
          resourceType: "ChangeRequest",
          resourceId: created.id,
          resourceLabel: created.number,
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify({
            changeNumber: created.number,
            snapshotId: snapshot.id,
            version: snapshot.version,
            riskScore,
            riskLevel,
          }),
        },
      });

      return created;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(
    {
      change: {
        id: change.id,
        number: change.number,
        status: change.status,
        riskScore: change.riskScore,
        riskLevel: change.riskLevel,
      },
      message:
        "Change request created — awaiting a real approval in the Changes queue (SoD-enforced; auto-approval was removed in P19).",
      audit: { action: "RESTORE_REQUESTED", correlationId },
    },
    undefined,
    201
  );
}
