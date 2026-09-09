import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/incidents/from-change — create an incident from a failed
 * change (Task 4-b). Offered by the change-detail outcome banner when an
 * execution FAILED.
 *
 * Body: { changeId }
 *
 * Guards:
 *   404 CHANGE_NOT_FOUND;
 *   409 INVALID_STATE — only FAILED | ROLLBACK_FAILED changes correlate to
 *     an incident this way;
 *   409 INCIDENT_EXISTS — an incident already links this change.
 *
 * Number: INC-<year>-NNNNN (max existing +1, padded 5). Severity SEV2 for
 * HIGH/CRITICAL changes else SEV3 (priority P2/P3), status NEW, SLA due in
 * 4 h. Links changeId + every ChangeDevice and writes INCIDENT_CREATED with
 * the change number as correlation id so the audit trail ties both records.
 */
const fromChangeSchema = z.object({
  changeId: z.string().trim().min(1).max(64),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = fromChangeSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  // Phase 19-C (audit AUTHZ-001 sweep): correlating an incident from a
  // failed change requires the "incident.create" permission; the actor is
  // the session principal.
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "incident.create");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const change = await db.changeRequest.findUnique({
    where: { id: parsed.data.changeId },
    include: {
      devices: {
        select: { deviceId: true, device: { select: { hostname: true } } },
      },
      steps: { orderBy: { order: "asc" } },
      site: { select: { id: true } },
    },
  });
  if (!change) {
    return fail("CHANGE_NOT_FOUND", "The referenced change does not exist", 404);
  }
  if (!["FAILED", "ROLLBACK_FAILED"].includes(change.status)) {
    return fail(
      "INVALID_STATE",
      `Only FAILED or ROLLBACK_FAILED changes correlate to an incident — this change is ${change.status}`,
      409
    );
  }

  const existing = await db.incident.findFirst({
    where: { changeId: change.id },
    select: { id: true, number: true },
  });
  if (existing) {
    return fail(
      "INCIDENT_EXISTS",
      `Incident ${existing.number} is already linked to this change`,
      409
    );
  }

  const maxIncident = await db.incident.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const maxSeq = Number.parseInt(maxIncident?.number.slice(-5) ?? "0", 10);
  const number = `INC-${new Date().getFullYear()}-${String(
    (Number.isFinite(maxSeq) ? maxSeq : 0) + 1
  ).padStart(5, "0")}`;

  const severity = ["HIGH", "CRITICAL"].includes(change.riskLevel) ? "SEV2" : "SEV3";
  const priority = severity === "SEV2" ? "P2" : "P3";

  const failedStep = change.steps.find((step) => step.status === "FAILED");
  const rolledBack = change.steps.some(
    (step) => step.type === "ROLLBACK" && step.status === "PASSED"
  );
  const description = [
    `Change ${change.number} ("${change.title}") failed during execution${
      rolledBack ? " and was automatically rolled back" : ""
    }.`,
    failedStep
      ? `Failed step ${failedStep.order} (${failedStep.name}): ${failedStep.error ?? failedStep.output ?? "no detail recorded"}.`
      : "No failed step detail recorded.",
    `Risk level ${change.riskLevel} (score ${change.riskScore}); devices: ${
      change.devices.map((link) => link.device.hostname).join(", ") || "none"
    }.`,
    "Correlated automatically from the change execution engine.",
  ].join("\n");

  const now = new Date();
  const slaDueAt = new Date(now.getTime() + 4 * 60 * 60 * 1000);

  const incident = await db.$transaction(
    async (tx) => {
      const created = await tx.incident.create({
        data: {
          number,
          title: `Failed change ${change.number} — ${change.title}`,
          description,
          severity,
          priority,
          status: "NEW",
          source: "FAILED_CHANGE",
          siteId: change.site?.id ?? null,
          ownerId: actor.id,
          changeId: change.id,
          slaDueAt,
        },
      });

      if (change.devices.length > 0) {
        await tx.incidentDevice.createMany({
          data: change.devices.map((link) => ({
            incidentId: created.id,
            deviceId: link.deviceId,
          })),
        });
      }

      await tx.incidentEvent.create({
        data: {
          incidentId: created.id,
          kind: "SYSTEM",
          message: `Incident created from failed change ${change.number} (${change.status}).`,
          actorId: actor.id,
        },
      });

      await tx.auditEvent.create({
        data: {
          actorId: actor.id,
          actorName: actor.name ?? "Unknown user",
          action: "INCIDENT_CREATED",
          resourceType: "Incident",
          resourceId: created.id,
          resourceLabel: `${created.number} — failed change`,
          result: "SUCCESS",
          correlationId: change.number,
          afterJson: JSON.stringify({
            changeNumber: change.number,
            severity,
            source: "FAILED_CHANGE",
            linkedDevices: change.devices.length,
          }),
        },
      });

      return created;
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok(
    {
      incident: {
        id: incident.id,
        number: incident.number,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        changeId: incident.changeId,
      },
      message: `Incident ${incident.number} created and linked to ${change.number}.`,
    },
    undefined,
    201
  );
}
