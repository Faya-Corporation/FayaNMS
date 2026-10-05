import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import {
  authErrorToFail,
  requirePermission,
  requireSiteScope,
  sessionScopeFor,
} from "@/lib/auth/session";
import { sessionSiteScope } from "@/lib/auth/scope";
import {
  nextIncidentNumber,
  IncidentNumberConflictError,
} from "@/lib/incidents/create";
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
 *
 * F-031 wave-10 (audit 13-a F-4, mutation gate): the change's EFFECTIVE
 * site gates the mint — the change's own site, else the first linked
 * device's site. A sites-limited session answers 403 SITE_SCOPE_FORBIDDEN
 * for an out-of-scope change; an UNPLACEABLE change (no site, no device
 * sites) is FAIL-CLOSED for sites-limited sessions (they may not mint
 * fleet incidents from a change they cannot place) — wildcard sessions
 * keep the pre-F-031 behavior. The auto-description content is unchanged:
 * with the gate in place it is only ever built for in-scope changes.
 *
 * F-7 (audit 13-a, P4 — RT-014 class): the incident number is allocated
 * INSIDE the transaction through the shared `nextIncidentNumber(tx)`
 * helper (src/lib/incidents/create.ts) and a @@unique([number]) P2002
 * collision retries ONCE with a fresh read — a second consecutive loss
 * surfaces as the typed 409 INCIDENT_NUMBER_CONFLICT envelope (the manual
 * escalation route's certified pattern), never a raw Prisma 500.
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
        select: {
          deviceId: true,
          device: { select: { hostname: true, site: { select: { code: true } } } },
        },
      },
      steps: { orderBy: { order: "asc" } },
      site: { select: { id: true, code: true } },
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

  // ── F-031 wave-10 (audit 13-a F-4): the change's effective site gates ──
  // the mint — the change's own site, else the first linked device's site.
  // An UNPLACEABLE change (no site, no device sites) is FAIL-CLOSED for
  // sites-limited sessions (they may not mint fleet incidents from a change
  // they cannot place); wildcard sessions keep the pre-F-031 behavior.
  const scope = sessionSiteScope(await sessionScopeFor(request));
  if (scope.mode === "sites") {
    const changeSiteCode =
      change.site?.code ??
      change.devices
        .map((link) => link.device.site?.code ?? null)
        .find((code): code is string => code !== null) ??
      null;
    if (changeSiteCode === null) {
      return fail(
        "SITE_SCOPE_FORBIDDEN",
        "This change has no resolvable site — site-scoped sessions cannot correlate incidents from it.",
        403
      );
    }
    try {
      await requireSiteScope(request, changeSiteCode);
    } catch (error) {
      const authFail = authErrorToFail(error);
      if (!authFail) throw error;
      return authFail;
    }
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

  // F-7 (wave-10, RT-014 class): the number is allocated INSIDE the
  // transaction via the shared nextIncidentNumber(tx) helper, and a
  // @@unique([number]) collision (two concurrent creations read the same
  // max) retries ONCE with a fresh read — the certified
  // createIncidentForAlert pattern. A second consecutive conflict surfaces
  // as the typed 409 below; the failed tx rolls back atomically, so no
  // partial incident/event/audit rows remain.
  const createIncidentTx = async () =>
    db.$transaction(
      async (tx) => {
        const number = await nextIncidentNumber(tx, now);
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

  let incident: Awaited<ReturnType<typeof createIncidentTx>> | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        incident = await createIncidentTx();
        break;
      } catch (error) {
        // Unique violation on number → another create took the number:
        // retry once with a fresh in-tx read.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const target = error.meta?.target;
          const targetText = Array.isArray(target)
            ? target.join(",")
            : String(target ?? "");
          if (targetText.includes("number")) {
            if (attempt === 0) continue;
            throw new IncidentNumberConflictError();
          }
        }
        throw error;
      }
    }
  } catch (error) {
    // RT-014 — both number-retry attempts lost the @@unique race: answer a
    // typed retryable 409 instead of surfacing a raw Prisma error (the tx
    // rolled back atomically — no partial rows exist).
    if (error instanceof IncidentNumberConflictError) {
      return fail(
        "INCIDENT_NUMBER_CONFLICT",
        "Concurrent incident creation exhausted the number retry — retry the request",
        409
      );
    }
    throw error;
  }

  if (!incident) {
    // Unreachable — the loop assigns or throws on every path; defensive
    // fall-through keeps the type checker happy (mirrors create.ts).
    return fail(
      "INCIDENT_NUMBER_CONFLICT",
      "Concurrent incident creation exhausted the number retry — retry the request",
      409
    );
  }

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
