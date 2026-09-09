import { db } from "@/lib/db";
import { createSnapshot, type TxClient } from "@/lib/config/create-snapshot";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { authenticateServiceRequest } from "@/lib/auth/service-auth";
import { renderZtpConfig } from "@/lib/ztp/templates";
import {
  ZTP_PLATFORM_BY_VENDOR,
  defaultFirmwareFor,
  projectMgmtIp,
} from "@/lib/ztp/provision";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/ztp-provision — zero-touch provisioning persistence
 * service (Phase 14-b). Evaluate-in-Next completion endpoint, called BY the
 * worker mini-service after it has walked the simulated ZTP stages (claim
 * validation → template render → config push → device registration); the
 * worker never opens SQLite. All the state mutation lives here:
 *
 *   1. Resolve the job (must exist, be a RUNNING ZTP_PROVISION job) and the
 *      claim from its payload ({ claimId, … } — written at enqueue time by
 *      POST /api/v1/ztp/claims).
 *   2. Idempotency: an already-provisioned (or already-failed) claim answers
 *      { alreadyResolved: true } without re-writing or re-auditing — a
 *      retried attempt after a partial run cannot duplicate devices/audit.
 *   3. Explicit failure: a body carrying failReason flips the claim to
 *      failed + writes the ZTP_PROVISION_FAILED audit (FAILURE row, job
 *      correlationId) and answers outcome "failed". The driver treats that
 *      as a legitimate terminal result — the job still completes SUCCEEDED.
 *   4. Otherwise, in one transaction:
 *        claim pending|provisioning → provisioning (guarded updateMany take),
 *        hostname/serial collision checks (fail the claim, never the job),
 *        Device create (ONLINE/managed per Device conventions, site from the
 *        claim, vendor + model + serial + hostname, mgmtIp projected from the
 *        site /24, firmware = vendor-authentic stable default from the
 *        lifecycle matrix, tags ["ztp"]),
 *        bootstrap ConfigSnapshot v1 via the shared createSnapshot() lib
 *        (source EVENT, configFlavor = templateId, rendered from the SAME
 *        template module the preview uses),
 *        claim → provisioned + deviceId,
 *        AuditEvent ZTP_PROVISIONED (actor system:ztp-worker) with the job
 *        correlationId.
 *
 * The job row itself is NOT touched here — the worker's regular
 * /worker/complete call marks it SUCCEEDED with the returned summary.
 */

const provisionSchema = z.object({
  jobId: z.string().trim().min(1),
  failReason: z.string().trim().min(3).max(300).optional(),
});

function safeParseJson(text: string | null | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  // P19 SEC-002 — machine principal only (service JWT; see service-auth.ts).
  const service = authenticateServiceRequest(request, "jobs");
  if (!service.ok) {
    return fail(service.code, service.message, 401);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = provisionSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const job = await db.jobExecution.findUnique({
    where: { id: parsed.data.jobId },
    select: {
      id: true,
      type: true,
      status: true,
      payloadJson: true,
      correlationId: true,
    },
  });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced job does not exist", 404);
  }
  if (job.type !== "ZTP_PROVISION") {
    return fail(
      "INVALID_JOB_TYPE",
      `ztp-provision expects a ZTP_PROVISION job (received ${job.type})`,
      400
    );
  }
  if (job.status !== "RUNNING") {
    return fail(
      "JOB_NOT_RUNNING",
      `ztp-provision requires a RUNNING job (status is ${job.status})`,
      409
    );
  }

  const payload = safeParseJson(job.payloadJson);
  const claimId = typeof payload.claimId === "string" ? payload.claimId : "";
  if (!claimId) {
    return fail(
      "INVALID_PAYLOAD",
      "ZTP_PROVISION job payload carries no claimId",
      400
    );
  }

  const claim = await db.ztpClaim.findUnique({ where: { id: claimId } });
  if (!claim) {
    return fail("CLAIM_NOT_FOUND", "The referenced ZTP claim no longer exists", 404);
  }

  const claimResolved = async (
    outcome: "provisioned" | "failed",
    alreadyResolved: boolean
  ) =>
    ok({
      outcome,
      claimId: claim.id,
      serial: claim.serial,
      hostname: claim.hostname,
      alreadyResolved,
      correlationId: job.correlationId,
    });

  // ── Idempotency: the claim was already resolved by a previous attempt ──
  if (claim.status === "provisioned") {
    return claimResolved("provisioned", true);
  }
  if (claim.status === "failed") {
    return claimResolved("failed", true);
  }

  // ── Explicit failure payload → claim failed + ZTP_PROVISION_FAILED ──
  if (parsed.data.failReason) {
    const reason = parsed.data.failReason;
    const taken = await db.ztpClaim.updateMany({
      where: { id: claim.id, status: { in: ["pending", "provisioning"] } },
      data: { status: "failed" },
    });
    if (taken.count === 0) {
      return claimResolved("failed", true);
    }
    await db.$transaction(
      async (tx) => {
        await tx.auditEvent.create({
          data: {
            actorName: "system:ztp-worker",
            action: "ZTP_PROVISION_FAILED",
            resourceType: "ZtpClaim",
            resourceId: claim.id,
            resourceLabel: `${claim.hostname} (${claim.serial})`,
            result: "FAILURE",
            correlationId: job.correlationId,
            afterJson: JSON.stringify({
              claimId: claim.id,
              serial: claim.serial,
              hostname: claim.hostname,
              vendorKey: claim.vendorKey,
              templateId: claim.templateId,
              reason,
            }),
          },
        });
      },
      { maxWait: 5_000, timeout: 20_000 }
    );
    return ok({
      outcome: "failed" as const,
      claimId: claim.id,
      serial: claim.serial,
      hostname: claim.hostname,
      reason,
      alreadyResolved: false,
      correlationId: job.correlationId,
    });
  }

  // ── Pre-flight the collision checks BEFORE opening the write transaction
  // (mgmtIp projection + vendor lookup are reads; keep the tx short). ──
  const vendor = await db.vendor.findUnique({
    where: { key: claim.vendorKey },
    select: { id: true, name: true },
  });
  if (!vendor) {
    return failWithClaimFailure(claim.id, claim.serial, claim.hostname, "UNKNOWN_VENDOR", job.correlationId);
  }

  const [hostnameTaken, serialTaken, site] = await Promise.all([
    db.device.findUnique({ where: { hostname: claim.hostname }, select: { id: true } }),
    db.device.findFirst({ where: { serialNumber: claim.serial }, select: { id: true } }),
    claim.siteId
      ? db.site.findUnique({ where: { id: claim.siteId }, select: { id: true, code: true } })
      : Promise.resolve(null),
  ]);
  if (hostnameTaken) {
    return failWithClaimFailure(
      claim.id,
      claim.serial,
      claim.hostname,
      "HOSTNAME_TAKEN",
      job.correlationId
    );
  }
  if (serialTaken) {
    return failWithClaimFailure(
      claim.id,
      claim.serial,
      claim.hostname,
      "SERIAL_ALREADY_REGISTERED",
      job.correlationId
    );
  }

  const mgmtIp = await projectMgmtIp(claim.siteId);
  const firmware = defaultFirmwareFor(claim.vendorKey);
  const platform = ZTP_PLATFORM_BY_VENDOR[claim.vendorKey] ?? null;
  const siteCode = site?.code ?? null;
  const provisionedAt = new Date();

  const result = await db.$transaction(
    async (tx) => {
      // Guarded take — only a pending/provisioning claim can be provisioned;
      // a concurrent resolution answers idempotently.
      const take = await tx.ztpClaim.updateMany({
        where: { id: claim.id, status: { in: ["pending", "provisioning"] } },
        data: { status: "provisioning" },
      });
      if (take.count === 0) {
        return { resolvedElsewhere: true as const };
      }

      const device = await tx.device.create({
        data: {
          hostname: claim.hostname,
          displayName: claim.hostname.replace(/-/g, " "),
          mgmtIp,
          vendorId: vendor.id,
          platform,
          model: claim.model,
          serialNumber: claim.serial,
          firmware,
          siteId: claim.siteId,
          status: "ONLINE",
          criticality: "MEDIUM",
          healthScore: 95,
          uptimeSeconds: BigInt(300),
          lastSeen: provisionedAt,
          backupCompliance: "COMPLIANT",
          tagsJson: JSON.stringify(["ztp"]),
          notes: `Zero-touch provisioned from claim ${claim.serial} (${claim.templateId}).`,
        },
        select: { id: true, hostname: true, mgmtIp: true },
      });

      const rendered = renderZtpConfig(claim.templateId, {
        hostname: claim.hostname,
        siteCode: siteCode ?? "UNASSIGNED",
        mgmtIp,
      });
      let snapshotVersion: number | null = null;
      if (rendered) {
        const snapshot = await createSnapshot(
          tx as unknown as TxClient,
          {
            deviceId: device.id,
            rawText: rendered,
            source: "EVENT",
            vendorKey: claim.vendorKey,
            jobId: job.id,
            correlationId: job.correlationId,
            configFlavor: claim.templateId,
            actorName: "system:ztp-worker",
            bumpLastConfigChangeAt: true,
          },
          provisionedAt
        );
        if (snapshot.ok) {
          snapshotVersion = snapshot.version;
        }
      }

      await tx.ztpClaim.update({
        where: { id: claim.id },
        data: { status: "provisioned", deviceId: device.id },
      });

      await tx.auditEvent.create({
        data: {
          actorName: "system:ztp-worker",
          action: "ZTP_PROVISIONED",
          resourceType: "ZtpClaim",
          resourceId: claim.id,
          resourceLabel: `${claim.hostname} (${claim.serial})`,
          result: "SUCCESS",
          correlationId: job.correlationId,
          afterJson: JSON.stringify({
            claimId: claim.id,
            deviceId: device.id,
            hostname: device.hostname,
            serial: claim.serial,
            vendorKey: claim.vendorKey,
            model: claim.model,
            templateId: claim.templateId,
            mgmtIp: device.mgmtIp,
            firmware,
            snapshotVersion,
          }),
        },
      });

      return {
        resolvedElsewhere: false as const,
        deviceId: device.id,
        hostname: device.hostname,
        mgmtIp: device.mgmtIp,
        snapshotVersion,
      };
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  if (result.resolvedElsewhere) {
    return claimResolved(claim.status === "provisioned" ? "provisioned" : "failed", true);
  }

  return ok({
    outcome: "provisioned" as const,
    claimId: claim.id,
    serial: claim.serial,
    hostname: result.hostname,
    deviceId: result.deviceId,
    mgmtIp: result.mgmtIp,
    snapshotVersion: result.snapshotVersion,
    provisionedAt: provisionedAt.toISOString(),
    alreadyResolved: false,
    correlationId: job.correlationId,
  });
}

/**
 * Collision/vendor failures are LEGITIMATE terminal outcomes (the claim
 * cannot be provisioned — retrying would fail the same way). The claim is
 * flipped to failed with a ZTP_PROVISION_FAILED audit and the endpoint
 * answers outcome "failed" so the worker job completes SUCCEEDED.
 */
async function failWithClaimFailure(
  claimId: string,
  serial: string,
  hostname: string,
  reason: string,
  correlationId: string
) {
  const taken = await db.ztpClaim.updateMany({
    where: { id: claimId, status: { in: ["pending", "provisioning"] } },
    data: { status: "failed" },
  });
  if (taken.count > 0) {
    await db.auditEvent.create({
      data: {
        actorName: "system:ztp-worker",
        action: "ZTP_PROVISION_FAILED",
        resourceType: "ZtpClaim",
        resourceId: claimId,
        resourceLabel: `${hostname} (${serial})`,
        result: "FAILURE",
        correlationId,
        afterJson: JSON.stringify({ claimId, serial, hostname, reason }),
      },
    });
  }
  return ok({
    outcome: "failed" as const,
    claimId,
    serial,
    hostname,
    reason,
    alreadyResolved: taken.count === 0,
    correlationId,
  });
}
