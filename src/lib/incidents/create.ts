import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { newCorrelationId } from "@/app/api/v1/_lib/api";

/**
 * The transaction client handed to interactive `db.$transaction` callbacks.
 * Deliberately EXTRACTED from the client rather than spelled
 * `Prisma.TransactionClient`: the exported `db` is an $extends-wrapped
 * client (audit hash-chain stamping), and its tx delegates carry the
 * extension's type parameters — the plain base type is not assignable
 * (same convention as approval-gate.ts).
 */
type DbTx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * Shared incident-creation module (Task 5-a) — ONE entry point used by:
 *   - the alert evaluation engine (src/lib/alerts/evaluate.ts) for
 *     auto-creation on CRITICAL/HIGH alert fires, and
 *   - POST /api/v1/alerts/[id]/create-incident (manual escalation), and
 *   - Phase 5-b incident surfaces (lifecycle work builds on the records
 *     this module produces — do not duplicate its logic).
 *
 * The change→incident path (4-b, /api/v1/incidents/from-change) predates
 * this module and keeps its own richer narrative, but uses the same number
 * format + severity/SLA conventions.
 */

/** Alert severity → incident severity/priority (design doc severity mapping). */
export const ALERT_SEVERITY_TO_INCIDENT: Record<
  string,
  { severity: string; priority: string }
> = {
  CRITICAL: { severity: "SEV1", priority: "P1" },
  HIGH: { severity: "SEV2", priority: "P2" },
  MEDIUM: { severity: "SEV3", priority: "P3" },
  LOW: { severity: "SEV4", priority: "P4" },
  INFO: { severity: "SEV4", priority: "P4" },
};

/** SLA resolution targets in hours by incident severity (SEV1 1h / SEV2 4h / SEV3 8h / SEV4 24h). */
export const SLA_HOURS_BY_INCIDENT_SEVERITY: Record<string, number> = {
  SEV1: 1,
  SEV2: 4,
  SEV3: 8,
  SEV4: 24,
};

/**
 * Next incident number (INC-<year>-NNNNN, max existing +1, padded 5).
 * RT-014: the caller's CLIENT is required — inside a transaction the tx
 * client must be passed so the max+1 read shares the tx snapshot; reading
 * via the global client let two concurrent creations compute the same
 * number (the @@unique P2002 is now retried by the caller instead).
 */
export async function nextIncidentNumber(
  client: DbTx,
  now = new Date()
): Promise<string> {
  const maxIncident = await client.incident.findFirst({
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const maxSeq = Number.parseInt(maxIncident?.number.slice(-5) ?? "0", 10);
  return `INC-${now.getFullYear()}-${String(
    (Number.isFinite(maxSeq) ? maxSeq : 0) + 1
  ).padStart(5, "0")}`;
}

/**
 * RT-014 — both number-allocation retry attempts lost the @@unique([number])
 * race. Typed so callers can answer 409 (the manual escalation route) and so
 * the alert evaluation engine's per-alert isolation treats it as a failed
 * creation for THAT alert only — the transaction rolled back atomically, no
 * partial rows exist.
 */
export class IncidentNumberConflictError extends Error {
  readonly code = "INCIDENT_NUMBER_CONFLICT";
  readonly status = 409;
  constructor() {
    super(
      "INCIDENT_NUMBER_CONFLICT: concurrent incident creation exhausted the number allocation retry — retry the request"
    );
    this.name = "IncidentNumberConflictError";
  }
}

export interface CreateIncidentForAlertInput {
  /** The triggering alert (must already exist). */
  alert: {
    id: string;
    severity: string;
    message: string;
    deviceId: string;
  };
  /** The alert's device — supplies the hostname, site link and device link. */
  device: {
    id: string;
    hostname: string;
    siteId?: string | null;
  };
  /** Incident.source token — "ALERT" for the engine, "MANUAL" for hand escalation. */
  source?: string;
  /** Audit actor; engine passes nothing (defaults to system:alert-engine). */
  actorName?: string;
  actorId?: string | null;
  /** Correlation id tying the audit trail together (defaults INC-XXXXXX). */
  correlationId?: string;
  /** Custom incident title; defaults to "<hostname>: <alert message>". */
  title?: string;
}

export interface CreateIncidentForAlertResult {
  created: boolean;
  /** null when created === false (alert was already linked). */
  incident: {
    id: string;
    number: string;
    title: string;
    severity: string;
    priority: string | null;
    status: string;
    slaDueAt: string | null;
  } | null;
  reason?: "ALERT_ALREADY_LINKED";
}

/**
 * Create (or idempotently resolve) the incident linked to an alert:
 *   - guard: alert already has incidentId → { created: false, incident: null };
 *   - severity/priority via ALERT_SEVERITY_TO_INCIDENT (unknown → SEV4);
 *   - slaDueAt = createdAt + SLA_HOURS_BY_INCIDENT_SEVERITY;
 *   - links IncidentDevice + IncidentEvent (SYSTEM) + Alert.incidentId;
 *   - audits INCIDENT_CREATED (+ ALERT_ESCALATED for manual sources);
 *   - one short interactive transaction (SQLite WAL / P2028 guard).
 */
export async function createIncidentForAlert(
  input: CreateIncidentForAlertInput
): Promise<CreateIncidentForAlertResult> {
  const correlationId = input.correlationId ?? newCorrelationId("INC");
  const actorName = input.actorName ?? "system:alert-engine";
  const now = new Date();

  const existingLink = await db.alert.findUnique({
    where: { id: input.alert.id },
    select: { incidentId: true },
  });
  if (existingLink?.incidentId) {
    const linked = await db.incident.findUnique({
      where: { id: existingLink.incidentId },
      select: {
        id: true,
        number: true,
        title: true,
        severity: true,
        priority: true,
        status: true,
        slaDueAt: true,
      },
    });
    if (linked) {
      return {
        created: false,
        incident: {
          ...linked,
          slaDueAt: linked.slaDueAt ? linked.slaDueAt.toISOString() : null,
        },
        reason: "ALERT_ALREADY_LINKED",
      };
    }
  }

  const map =
    ALERT_SEVERITY_TO_INCIDENT[input.alert.severity] ??
    ALERT_SEVERITY_TO_INCIDENT.INFO;
  const slaDueAt = new Date(
    now.getTime() +
      (SLA_HOURS_BY_INCIDENT_SEVERITY[map.severity] ?? 24) * 60 * 60 * 1000
  );

  // RT-014 — the number is allocated INSIDE the transaction via the tx
  // client, and a @@unique([number]) collision (two concurrent creations
  // read the same max) retries ONCE with a fresh read — the repo's cmdb
  // pattern. A second consecutive conflict surfaces as a typed 409 error;
  // the failed tx rolls back atomically, so no partial linkage rows remain.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const incident = await db.$transaction(
        async (tx) => {
          const number = await nextIncidentNumber(tx, now);
          const title =
            input.title ??
            `${input.device.hostname}: ${input.alert.message}`.slice(0, 160);

          const created = await tx.incident.create({
            data: {
              number,
              title,
              description: [
                `Alert: "${input.alert.message}".`,
                `Device ${input.device.hostname} raised ${input.alert.severity}-level alert${
                  input.source === "MANUAL"
                    ? " — escalated manually by an operator."
                    : " — auto-created by the alert evaluation engine."
                }`,
              ].join("\n"),
              severity: map.severity,
              priority: map.priority,
              status: "NEW",
              source: input.source ?? "ALERT",
              siteId: input.device.siteId ?? null,
              slaDueAt,
            },
          });

          await tx.incidentDevice.create({
            data: { incidentId: created.id, deviceId: input.device.id },
          });

          await tx.incidentEvent.create({
            data: {
              incidentId: created.id,
              kind: "SYSTEM",
              message: `${
                input.source === "MANUAL" ? "Escalated from alert" : "Auto-created from alert"
              } "${input.alert.message}" (severity ${input.alert.severity}).`,
              actorId: input.actorId ?? null,
            },
          });

          await tx.alert.update({
            where: { id: input.alert.id },
            data: { incidentId: created.id },
          });

          await tx.auditEvent.create({
            data: {
              actorId: input.actorId ?? null,
              actorName,
              action: "INCIDENT_CREATED",
              resourceType: "Incident",
              resourceId: created.id,
              resourceLabel: `${created.number} — ${input.device.hostname}`,
              result: "SUCCESS",
              correlationId,
              afterJson: JSON.stringify({
                alertId: input.alert.id,
                severity: map.severity,
                priority: map.priority,
                source: input.source ?? "ALERT",
                slaDueAt: slaDueAt.toISOString(),
              }),
            },
          });

          if (input.source === "MANUAL") {
            await tx.auditEvent.create({
              data: {
                actorId: input.actorId ?? null,
                actorName,
                action: "ALERT_ESCALATED",
                resourceType: "Alert",
                resourceId: input.alert.id,
                resourceLabel: input.device.hostname,
                result: "SUCCESS",
                correlationId,
                afterJson: JSON.stringify({ incidentNumber: created.number }),
              },
            });
          }

          return created;
        },
        { maxWait: 5_000, timeout: 20_000 }
      );

      return {
        created: true,
        incident: {
          id: incident.id,
          number: incident.number,
          title: incident.title,
          severity: incident.severity,
          priority: incident.priority,
          status: incident.status,
          slaDueAt: (incident.slaDueAt ?? slaDueAt).toISOString(),
        },
      };
    } catch (error) {
      // Unique violation on number → another create took the number: retry once.
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

  // Unreachable — the loop returns or throws on every path; defensive
  // fall-through keeps the type checker happy (mirrors cmdb items route).
  throw new IncidentNumberConflictError();
}
