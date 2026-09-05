import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../_lib/api";
import { diffLines, diffStats, type DiffStats } from "@/lib/config/diff";
import { normalizeConfig } from "@/lib/config/normalize";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/worker/drift-evaluate — drift evaluation service (Task 3-c).
 *
 * Called BY the worker mini-service after it claims a DRIFT_CHECK job; the
 * worker never touches SQLite. All the intelligence lives here:
 *
 *   1. Resolve the device from the job (payload.deviceId ?? targetId).
 *   2. Load the device's latest ConfigBaseline (join snapshot) and its
 *      latest CURRENT snapshot. Either missing → { skipped: true, reason }
 *      — the worker completes the job SUCCEEDED with a skipped result.
 *   3. Diff the NORMALIZED texts (3-b libs; normalizedText computed on the
 *      fly when not stored — mirrors the 3-b diff endpoint logic).
 *   4. Identical sha256 OR zero added/removed/changed stats → resolve every
 *      OPEN DriftRecord of the device (RESOLVED + resolvedAt + DRIFT_RESOLVED
 *      audit) and answer { drift: false }.
 *   5. Otherwise upsert: an existing OPEN record for the device is UPDATED
 *      in place (currentSnapshotId + diffSummary — detectedAt and the
 *      baseline reference stay original, so a re-check never inflates the
 *      record count); only when no OPEN record exists is a new one created
 *      together with a DRIFT_DETECTED audit event (correlation id = the
 *      job's). Answer { drift: true, recordId, stats }.
 *
 * The job row itself is NOT touched here — the worker's regular
 * /worker/complete call marks it SUCCEEDED with a result summary.
 */

const evaluateSchema = z.object({
  jobId: z.string().trim().min(1),
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

const MAX_SUMMARY_CHARS = 400;

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Concise human-readable top-3 change summary: counts prefix + up to three
 * line descriptions ("+ added", "− removed", "~ a → b"), truncated.
 */
function buildDiffSummary(rows: ReturnType<typeof diffLines>, stats: DiffStats): string {
  const changes = rows.filter((row) => row.type !== "equal").slice(0, 3);
  const parts = changes.map((row) => {
    if (row.type === "added") return `+ ${truncate(row.bText ?? "", 64)}`;
    if (row.type === "removed") return `− ${truncate(row.aText ?? "", 64)}`;
    return `~ ${truncate(row.aText ?? "", 40)} → ${truncate(row.bText ?? "", 40)}`;
  });
  const head = `+${stats.added} −${stats.removed} ~${stats.changed}`;
  return [head, ...parts].join(" · ").slice(0, MAX_SUMMARY_CHARS);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = evaluateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  const job = await db.jobExecution.findUnique({
    where: { id: parsed.data.jobId },
    select: { id: true, type: true, targetId: true, payloadJson: true, correlationId: true },
  });
  if (!job) {
    return fail("JOB_NOT_FOUND", "The referenced job does not exist", 404);
  }
  if (job.type !== "DRIFT_CHECK") {
    return fail(
      "INVALID_JOB_TYPE",
      `drift-evaluate expects a DRIFT_CHECK job (received ${job.type})`,
      400
    );
  }

  const payload = safeParseJson(job.payloadJson);
  const deviceId =
    typeof payload.deviceId === "string" && payload.deviceId
      ? payload.deviceId
      : job.targetId;
  if (!deviceId) {
    return ok({ skipped: true, reason: "job payload carries no deviceId" });
  }

  const device = await db.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      hostname: true,
      vendor: { select: { key: true } },
    },
  });
  if (!device) {
    return ok({ skipped: true, reason: "device no longer exists" });
  }
  const vendorKey = device.vendor?.key ?? "generic";

  // Latest approved baseline (join snapshot) + latest CURRENT snapshot.
  const baseline = await db.configBaseline.findFirst({
    where: { deviceId },
    orderBy: { approvedAt: "desc" },
    select: {
      id: true,
      snapshot: {
        select: {
          id: true,
          version: true,
          sha256: true,
          rawText: true,
          normalizedText: true,
        },
      },
    },
  });
  if (!baseline) {
    return ok({ skipped: true, reason: "device has no approved baseline" });
  }

  const current = await db.configSnapshot.findFirst({
    where: { deviceId, status: "CURRENT" },
    orderBy: { version: "desc" },
    select: {
      id: true,
      version: true,
      sha256: true,
      rawText: true,
      normalizedText: true,
    },
  });
  if (!current) {
    return ok({ skipped: true, reason: "device has no CURRENT snapshot" });
  }

  // Identical content → no drift, resolve any OPEN records.
  if (baseline.snapshot.id === current.id || baseline.snapshot.sha256 === current.sha256) {
    const resolvedCount = await resolveOpenDrifts(deviceId, device.hostname, job.correlationId);
    return ok({
      drift: false,
      baselineVersion: baseline.snapshot.version,
      currentVersion: current.version,
      resolved: resolvedCount,
    });
  }

  // Normalized diff (stored normalizedText preferred, computed on the fly
  // when null — same contract as the 3-b diff endpoint).
  const baselineText =
    baseline.snapshot.normalizedText ??
    normalizeConfig(baseline.snapshot.rawText, vendorKey);
  const currentText =
    current.normalizedText ?? normalizeConfig(current.rawText, vendorKey);

  const rows = diffLines(baselineText.split("\n"), currentText.split("\n"));
  const stats = diffStats(rows);
  const hasDrift = stats.added + stats.removed + stats.changed > 0;

  if (!hasDrift) {
    const resolvedCount = await resolveOpenDrifts(
      deviceId,
      device.hostname,
      job.correlationId
    );
    return ok({
      drift: false,
      baselineVersion: baseline.snapshot.version,
      currentVersion: current.version,
      resolved: resolvedCount,
    });
  }

  const diffSummary = buildDiffSummary(rows, stats);

  // Short transaction (SQLite WAL — P2028 history): upsert the OPEN record
  // + audit only when a NEW record is created.
  const result = await db.$transaction(
    async (tx) => {
      const existingOpen = await tx.driftRecord.findFirst({
        where: { deviceId, status: "OPEN" },
        orderBy: { detectedAt: "asc" },
        select: { id: true },
      });

      if (existingOpen) {
        // Update in place — original detectedAt and baseline reference are
        // kept so repeated checks never inflate the record count.
        const updated = await tx.driftRecord.update({
          where: { id: existingOpen.id },
          data: {
            currentSnapshotId: current.id,
            diffSummary,
          },
        });
        return { recordId: updated.id, created: false as const };
      }

      const created = await tx.driftRecord.create({
        data: {
          deviceId,
          baselineSnapshotId: baseline.snapshot.id,
          currentSnapshotId: current.id,
          diffSummary,
          status: "OPEN",
        },
      });

      await tx.auditEvent.create({
        data: {
          actorName: "system:drift-engine",
          action: "DRIFT_DETECTED",
          resourceType: "DriftRecord",
          resourceId: created.id,
          resourceLabel: device.hostname,
          result: "SUCCESS",
          correlationId: job.correlationId,
          afterJson: JSON.stringify({
            deviceId,
            baselineVersion: baseline.snapshot.version,
            currentVersion: current.version,
            stats,
          }),
        },
      });

      return { recordId: created.id, created: true as const };
    },
    { maxWait: 5_000, timeout: 20_000 }
  );

  return ok({
    drift: true,
    recordId: result.recordId,
    created: result.created,
    baselineVersion: baseline.snapshot.version,
    currentVersion: current.version,
    stats,
  });
}

/** Resolve every OPEN DriftRecord of a device; one audit row per record. */
async function resolveOpenDrifts(
  deviceId: string,
  hostname: string,
  correlationId: string
): Promise<number> {
  const open = await db.driftRecord.findMany({
    where: { deviceId, status: "OPEN" },
    select: { id: true },
  });
  if (open.length === 0) return 0;

  const now = new Date();
  await db.$transaction(
    async (tx) => {
      await tx.driftRecord.updateMany({
        where: { id: { in: open.map((r) => r.id) }, status: "OPEN" },
        data: { status: "RESOLVED", resolvedAt: now },
      });
      for (const record of open) {
        await tx.auditEvent.create({
          data: {
            actorName: "system:drift-engine",
            action: "DRIFT_RESOLVED",
            resourceType: "DriftRecord",
            resourceId: record.id,
            resourceLabel: hostname,
            result: "SUCCESS",
            correlationId,
            afterJson: JSON.stringify({ reason: "config matches baseline" }),
          },
        });
      }
    },
    { maxWait: 5_000, timeout: 20_000 }
  );
  return open.length;
}
