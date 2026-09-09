import type { Prisma } from "@prisma/client";

import { normalizeConfig } from "@/lib/config/normalize";
import { prepareSnapshotColumns, sha256Plaintext } from "@/lib/config/crypto";

/**
 * Shared ConfigSnapshot creation (Task 4-b).
 *
 * Extracted verbatim from POST /api/v1/worker/complete so the change-step
 * executor and the backup completion path share ONE implementation:
 *
 *   1. next per-device snapshot version = max(version)+1
 *   2. demote the device's previous CURRENT snapshot to HISTORICAL
 *   3. create ConfigSnapshot (sha256 over rawText, sizeBytes, source,
 *      status CURRENT, changeId/jobId/userId links)
 *   4. device lastBackupAt/lastSeen = now, backupCompliance = COMPLIANT
 *      (+ lastConfigChangeAt when the caller marks a real config push)
 *   5. AuditEvent CONFIG_BACKUP with the caller's correlation id
 *
 * Runs INSIDE the caller's transaction (client passed in) — the callers own
 * the transaction boundaries and never hold one across an HTTP call.
 *
 * `normalizedText` may be provided by the worker adapters; when omitted it
 * is computed with the vendor-aware normalizer (same output the Phase 3
 * diff engine sees).
 *
 * ENCRYPTION (P19 / audit SEC-003): sha256/sizeBytes are computed over the
 * PLAINTEXT (integrity reference), then both texts are encrypted with the
 * per-snapshot DEK envelope (src/lib/config/crypto.ts) — the database row
 * only ever holds base64 ciphertext. FAYANMS_CONFIG_ENC_KEY must be set or
 * the write throws (fail closed).
 */

/** Transaction client type used by every db.$transaction(async (tx) => …). */
export type TxClient = Prisma.TransactionClient;

export interface CreateSnapshotInput {
  deviceId: string;
  rawText: string;
  /** SCHEDULED | MANUAL | PRE_CHANGE | POST_CHANGE | EVENT */
  source: string;
  /** RUNNING (default) | STARTUP */
  configType?: string;
  /** Worker-computed normalized text; computed here when omitted. */
  normalizedText?: string | null;
  /** Vendor key (Device.vendor.key) for the normalizer fallback. */
  vendorKey?: string | null;
  userId?: string | null;
  changeId?: string | null;
  jobId?: string | null;
  /** Audit correlation id (defaults to null — plain backup trail). */
  correlationId?: string | null;
  /** Audit actor label (default "system:backup-worker"). */
  actorName?: string;
  /** Extra audit payload (e.g. adapter configFlavor). */
  configFlavor?: string | null;
  /** APPLY-style pushes also stamp Device.lastConfigChangeAt. */
  bumpLastConfigChangeAt?: boolean;
}

export type CreateSnapshotResult =
  | {
      ok: true;
      id: string;
      version: number;
      sha256: string;
      sizeBytes: number;
      normalizedText: string;
      hostname: string;
    }
  | { ok: false; reason: "DEVICE_NOT_FOUND" };

export async function createSnapshot(
  tx: TxClient,
  input: CreateSnapshotInput,
  at: Date = new Date()
): Promise<CreateSnapshotResult> {
  const device = await tx.device.findUnique({
    where: { id: input.deviceId },
    select: {
      id: true,
      hostname: true,
      vendor: { select: { key: true } },
    },
  });
  if (!device) {
    return { ok: false, reason: "DEVICE_NOT_FOUND" };
  }

  const sha256 = sha256Plaintext(input.rawText);
  const sizeBytes = Buffer.byteLength(input.rawText, "utf8");
  const normalizedText =
    input.normalizedText ?? normalizeConfig(input.rawText, input.vendorKey ?? device.vendor.key);

  const prev = await tx.configSnapshot.findFirst({
    where: { deviceId: input.deviceId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const version = (prev?.version ?? 0) + 1;

  // Demote the previous CURRENT snapshot. "SUPERSEDED" is not part of the
  // schema's documented status domain (CURRENT | HISTORICAL | BASELINE),
  // so HISTORICAL is used — consistent with the seeded chains.
  await tx.configSnapshot.updateMany({
    where: { deviceId: input.deviceId, status: "CURRENT" },
    data: { status: "HISTORICAL" },
  });

  const snapshot = await tx.configSnapshot.create({
    data: {
      deviceId: input.deviceId,
      version,
      source: input.source,
      configType: input.configType ?? "RUNNING",
      // AES-256-GCM envelope — the DB never sees the plaintext (P19 SEC-003).
      ...prepareSnapshotColumns(input.rawText, normalizedText),
      sha256,
      sizeBytes,
      userId: input.userId ?? null,
      changeId: input.changeId ?? null,
      jobId: input.jobId ?? null,
      status: "CURRENT",
    },
  });

  await tx.device.update({
    where: { id: input.deviceId },
    data: {
      lastBackupAt: at,
      lastSeen: at,
      backupCompliance: "COMPLIANT",
      ...(input.bumpLastConfigChangeAt ? { lastConfigChangeAt: at } : {}),
    },
  });

  await tx.auditEvent.create({
    data: {
      actorName: input.actorName ?? "system:backup-worker",
      action: "CONFIG_BACKUP",
      resourceType: "ConfigSnapshot",
      resourceId: input.deviceId,
      resourceLabel: device.hostname,
      result: "SUCCESS",
      correlationId: input.correlationId ?? null,
      afterJson: JSON.stringify({
        snapshotId: snapshot.id,
        version,
        sha256,
        sizeBytes,
        source: input.source,
        configFlavor: input.configFlavor ?? null,
      }),
    },
  });

  return {
    ok: true,
    id: snapshot.id,
    version,
    sha256,
    sizeBytes,
    normalizedText,
    hostname: device.hostname,
  };
}

/** Abbreviated sha for step outputs and UI chips (first 8 hex chars). */
export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
