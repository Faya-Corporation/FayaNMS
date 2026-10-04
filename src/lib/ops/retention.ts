import { z } from "zod";
import { db } from "@/lib/db";
import { newCorrelationId } from "@/app/api/v1/_lib/api";

/**
 * Ops-data retention (F-047, batch-22) — the sweep that keeps the three
 * non-append-only operational tables bounded: JobExecution (terminal rows),
 * Notification (read rows) and DiscoveryObservation (aged evidence).
 *
 * ── SCOPE: AuditEvent is deliberately OUT OF SCOPE ────────────────────────
 * AuditEvent is the audit chain: append-only by design and chain-stamped
 * (RT-012 bulk stamping, RT-013 tail verification — every row's hash covers
 * the previous row's hash, so deleting any row breaks verifiability of the
 * whole trail). No retention sweep may ever touch it; there is intentionally
 * NO audit-row delete of any kind anywhere in src/ (pinned by
 * tests/audit/open-findings-batch-22.test.ts). AuditEvent growth is a
 * product-level archival decision, not a timer job.
 *
 * ── PATTERN (RT-003 queue retention / RT-016 due-ness gating) ─────────────
 *   - ONE Setting row "opsData.retention" carries the whole policy (operator
 *     visible/editable like "protocolQueue.retention"): the three windows in
 *     days, enabled, plus lastPrunedAt / lastPruneResult bookkeeping;
 *   - due-ness gate for the tick (in-memory last-run primary + persisted
 *     Setting fallback for restart safety — the isSnapshotPruneDue shape);
 *   - chunked deletes: at most 1,000 rows per statement and at most 10,000
 *     rows per table per run — a first run after enabling (or a long gap)
 *     can never hold one giant DELETE transaction; a backlog converges on
 *     the NEXT daily run;
 *   - the per-table candidate guard is REPEATED on every deleteMany (CAS
 *     spirit — a row is only ever deleted while it still matches its
 *     terminal/read/age condition);
 *   - one OPS_DATA_PRUNED summary audit row per run (never one row per
 *     deleted row) inside the SAME bounded transaction as the Setting
 *     bookkeeping upsert.
 *
 * ── FK SAFETY ─────────────────────────────────────────────────────────────
 * Both relations pointing at JobExecution are onDelete: SetNull
 * (ConfigSnapshot.jobId, DiscoveryObservation.jobId) — deleting a terminal
 * job can never cascade-delete config snapshots or discovery evidence; the
 * referencing row merely loses its provenance pointer (the schema's declared
 * behavior). Nothing references Notification or DiscoveryObservation.
 *
 * ── SEMANTICS ─────────────────────────────────────────────────────────────
 *   - JobExecution: only TERMINAL rows (SUCCEEDED / FAILED / DEAD /
 *     CANCELLED) age by finishedAt. QUEUED / RUNNING rows are never
 *     candidates regardless of age (a job must finish before it can expire).
 *   - Notification: only READ rows (readAt not null) age by readAt. Unread
 *     rows are never candidates (an operator's unread inbox is never
 *     silently drained by a timer).
 *   - DiscoveryObservation: raw wire evidence, superseded continuously —
 *     ages by observedAt (SQL NULL semantics make a missing timestamp never
 *     match, though observedAt is NOT NULL in the schema).
 */

export const OPS_DATA_RETENTION_KEY = "opsData.retention";

export const DEFAULT_OPS_DATA_RETENTION = {
  /** Terminal JobExecution rows older than this are deleted. */
  jobExecutionDays: 30,
  /** READ Notification rows older than this are deleted. */
  notificationDays: 30,
  /** DiscoveryObservation evidence older than this is deleted. */
  discoveryObservationDays: 90,
  enabled: true,
} as const;

export const OPS_DATA_CHUNK_SIZE = 1_000;
export const OPS_DATA_MAX_DELETES_PER_RUN = 10_000;

/** RT-016-style cadence: the ops tables age daily — sweep at most once/day. */
export const OPS_DATA_DEDUPE_HOURS = 24;

/** Non-terminal JobExecution rows can never be retention candidates. */
export const TERMINAL_JOB_EXECUTION_STATUSES: string[] = [
  "SUCCEEDED",
  "FAILED",
  "DEAD",
  "CANCELLED",
];

export const opsDataRetentionSchema = z.object({
  jobExecutionDays: z.number().int().min(1).max(3650),
  notificationDays: z.number().int().min(1).max(3650),
  discoveryObservationDays: z.number().int().min(1).max(3650),
  enabled: z.boolean(),
}).strict();

const storedOpsDataRetentionSchema = opsDataRetentionSchema.extend({
  lastPrunedAt: z.string().datetime().nullable().optional(),
  lastPruneResult: z.record(z.string(), z.unknown()).nullable().optional(),
}).strict();

export interface OpsDataRetentionPolicy {
  jobExecutionDays: number;
  notificationDays: number;
  discoveryObservationDays: number;
  enabled: boolean;
}

export interface OpsDataRetentionView extends OpsDataRetentionPolicy {
  lastPrunedAt: string | null;
  lastPruneResult: Record<string, unknown> | null;
}

export interface OpsDataPruneResult {
  outcome: "pruned" | "disabled";
  jobExecutionsDeleted: number;
  notificationsDeleted: number;
  discoveryObservationsDeleted: number;
  durationMs: number;
  jobExecutionDays: number;
  notificationDays: number;
  discoveryObservationDays: number;
  correlationId: string;
  triggeredBy: string;
  prunedAt: string;
}

/** Parse the stored Setting into a fully-defaulted view. Never throws. */
export function parseStoredOpsDataRetention(
  valueJson: string | null | undefined
): OpsDataRetentionView {
  const fallback: OpsDataRetentionView = {
    ...DEFAULT_OPS_DATA_RETENTION,
    lastPrunedAt: null,
    lastPruneResult: null,
  };
  if (!valueJson) return fallback;
  try {
    const parsed = storedOpsDataRetentionSchema.safeParse(JSON.parse(valueJson));
    if (!parsed.success) return fallback;
    return {
      jobExecutionDays: parsed.data.jobExecutionDays,
      notificationDays: parsed.data.notificationDays,
      discoveryObservationDays: parsed.data.discoveryObservationDays,
      enabled: parsed.data.enabled,
      lastPrunedAt: parsed.data.lastPrunedAt ?? null,
      lastPruneResult: parsed.data.lastPruneResult ?? null,
    };
  } catch {
    return fallback;
  }
}

export function readOpsDataRetentionSetting() {
  return db.setting.findUnique({ where: { key: OPS_DATA_RETENTION_KEY } });
}

/** Pure cutoff helper (pinned by the regression suite). */
export function opsDataCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

/**
 * Pure expiry rule for ONE JobExecution (pinned by the regression suite):
 * only terminal statuses age by finishedAt; QUEUED/RUNNING rows and rows
 * without a finish timestamp are never candidates.
 */
export function isJobExecutionExpired(
  status: string,
  finishedAt: Date | null,
  days: number,
  now: Date
): boolean {
  if (!TERMINAL_JOB_EXECUTION_STATUSES.includes(status)) return false;
  if (!finishedAt) return false;
  return finishedAt.getTime() < opsDataCutoff(now, days).getTime();
}

/* ── RT-016-style due-ness gate (in-memory primary + Setting fallback) ──── */

let opsDataPruneLastRunMs: number | null = null;

/** Test seam — clears the in-memory half of the gate (fresh-process state). */
export function resetOpsDataPruneGateForTests(): void {
  opsDataPruneLastRunMs = null;
}

function readStoredLastPrunedAtMs(valueJson: string | null | undefined): number | null {
  if (!valueJson) return null;
  try {
    const parsed: unknown = JSON.parse(valueJson);
    if (!parsed || typeof parsed !== "object") return null;
    const lastPrunedAt = (parsed as { lastPrunedAt?: unknown }).lastPrunedAt;
    if (typeof lastPrunedAt !== "string") return null;
    const ms = Date.parse(lastPrunedAt);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/**
 * True when an ops-data sweep may run NOW: in-memory last-run older than the
 * 24 h window (primary), or — in a fresh process — the persisted Setting
 * "opsData.retention" { lastPrunedAt } (restart-safe fallback). Missing or
 * corrupt state on either layer means due (a corrupt timestamp must never
 * wedge the gate closed).
 */
export async function isOpsDataPruneDue(now: Date): Promise<boolean> {
  if (opsDataPruneLastRunMs !== null) {
    return now.getTime() - opsDataPruneLastRunMs >= OPS_DATA_DEDUPE_HOURS * 3_600_000;
  }
  const row = await db.setting.findUnique({
    where: { key: OPS_DATA_RETENTION_KEY },
    select: { valueJson: true },
  });
  if (!row) return true;
  const ms = readStoredLastPrunedAtMs(row.valueJson);
  return ms === null || now.getTime() - ms >= OPS_DATA_DEDUPE_HOURS * 3_600_000;
}

/**
 * Stamp the cadence gate at the END of a sweep run that actually executed
 * (even a zero-delete or disabled run — the gate is about CADENCE, not work
 * done). Writes BOTH layers: in-memory (this process) and the Setting row
 * (every other process / restart). The Setting value is MERGED — the
 * operator's policy knobs survive the stamp (unlike snapshots.retention,
 * this row carries policy AND bookkeeping).
 */
export async function markOpsDataPruned(now: Date): Promise<void> {
  opsDataPruneLastRunMs = now.getTime();
  const current = await db.setting.findUnique({
    where: { key: OPS_DATA_RETENTION_KEY },
    select: { valueJson: true },
  });
  const merged = {
    ...parseStoredOpsDataRetention(current?.valueJson),
    lastPrunedAt: now.toISOString(),
  };
  await db.setting.upsert({
    where: { key: OPS_DATA_RETENTION_KEY },
    update: { valueJson: JSON.stringify(merged) },
    create: { key: OPS_DATA_RETENTION_KEY, valueJson: JSON.stringify(merged) },
  });
}

/* ── chunked per-table deletes (exported for deterministic direct tests) ── */

/**
 * Chunked delete of TERMINAL JobExecution rows older than cutoff
 * (≤ CHUNK per statement, ≤ MAX per run). The terminal + age guard is
 * repeated on the deleteMany (CAS spirit). QUEUED/RUNNING rows can never
 * leave this table through retention.
 */
export async function deleteTerminalJobExecutionsChunked(cutoff: Date): Promise<number> {
  const batches = OPS_DATA_MAX_DELETES_PER_RUN / OPS_DATA_CHUNK_SIZE;
  let deleted = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const expired = await db.jobExecution.findMany({
      where: {
        status: { in: TERMINAL_JOB_EXECUTION_STATUSES },
        finishedAt: { lt: cutoff },
      },
      orderBy: [{ finishedAt: "asc" }, { id: "asc" }],
      take: OPS_DATA_CHUNK_SIZE,
      select: { id: true },
    });
    if (expired.length === 0) break;
    deleted += (
      await db.jobExecution.deleteMany({
        where: {
          id: { in: expired.map((row) => row.id) },
          status: { in: TERMINAL_JOB_EXECUTION_STATUSES },
          finishedAt: { lt: cutoff },
        },
      })
    ).count;
  }
  return deleted;
}

/**
 * Chunked delete of READ Notification rows older than cutoff. SQL
 * three-valued logic makes `readAt < cutoff` false for NULL readAt, so an
 * unread row can never match — in the scan AND in the guarded delete.
 */
export async function deleteReadNotificationsChunked(cutoff: Date): Promise<number> {
  const batches = OPS_DATA_MAX_DELETES_PER_RUN / OPS_DATA_CHUNK_SIZE;
  let deleted = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const expired = await db.notification.findMany({
      where: { readAt: { lt: cutoff } },
      orderBy: [{ readAt: "asc" }, { id: "asc" }],
      take: OPS_DATA_CHUNK_SIZE,
      select: { id: true },
    });
    if (expired.length === 0) break;
    deleted += (
      await db.notification.deleteMany({
        where: { id: { in: expired.map((row) => row.id) }, readAt: { lt: cutoff } },
      })
    ).count;
  }
  return deleted;
}

/**
 * Chunked delete of DiscoveryObservation evidence older than cutoff
 * (jobId/deviceId references are onDelete: SetNull — no cascade risk).
 */
export async function deleteDiscoveryObservationsChunked(cutoff: Date): Promise<number> {
  const batches = OPS_DATA_MAX_DELETES_PER_RUN / OPS_DATA_CHUNK_SIZE;
  let deleted = 0;
  for (let batch = 0; batch < batches; batch += 1) {
    const expired = await db.discoveryObservation.findMany({
      where: { observedAt: { lt: cutoff } },
      orderBy: [{ observedAt: "asc" }, { id: "asc" }],
      take: OPS_DATA_CHUNK_SIZE,
      select: { id: true },
    });
    if (expired.length === 0) break;
    deleted += (
      await db.discoveryObservation.deleteMany({
        where: { id: { in: expired.map((row) => row.id) }, observedAt: { lt: cutoff } },
      })
    ).count;
  }
  return deleted;
}

/**
 * Run ONE bounded ops-data retention sweep (three chunked deletes +
 * bookkeeping). Called by the worker tick when the due-ness gate says due;
 * direct callers (future admin route/tests) may invoke it without the gate —
 * the gate is about CADENCE, this engine is about CORRECTNESS.
 */
export async function pruneOpsData(
  opts: { now?: Date; triggeredBy?: string } = {}
): Promise<OpsDataPruneResult> {
  const now = opts.now ?? new Date();
  const triggeredBy = opts.triggeredBy ?? "SCHEDULE";
  const policy = parseStoredOpsDataRetention(
    (await readOpsDataRetentionSetting())?.valueJson
  );
  const correlationId = newCorrelationId("RET");
  const startedAt = Date.now();
  const jobCut = opsDataCutoff(now, policy.jobExecutionDays);
  const notifCut = opsDataCutoff(now, policy.notificationDays);
  const obsCut = opsDataCutoff(now, policy.discoveryObservationDays);

  let jobExecutionsDeleted = 0;
  let notificationsDeleted = 0;
  let discoveryObservationsDeleted = 0;
  if (policy.enabled) {
    jobExecutionsDeleted = await deleteTerminalJobExecutionsChunked(jobCut);
    notificationsDeleted = await deleteReadNotificationsChunked(notifCut);
    discoveryObservationsDeleted = await deleteDiscoveryObservationsChunked(obsCut);
  }

  const durationMs = Date.now() - startedAt;
  const prunedAt = now.toISOString();
  const outcome: OpsDataPruneResult["outcome"] = policy.enabled ? "pruned" : "disabled";
  const result: OpsDataPruneResult = {
    outcome,
    jobExecutionsDeleted,
    notificationsDeleted,
    discoveryObservationsDeleted,
    durationMs,
    jobExecutionDays: policy.jobExecutionDays,
    notificationDays: policy.notificationDays,
    discoveryObservationDays: policy.discoveryObservationDays,
    correlationId,
    triggeredBy,
    prunedAt,
  };

  // Bookkeeping + ONE summary audit row, atomic together (queue-retention
  // shape). The deletes above run as separate bounded statements on purpose:
  // three tables × ten chunks must never hold one long transaction.
  const updatedPolicy = {
    jobExecutionDays: policy.jobExecutionDays,
    notificationDays: policy.notificationDays,
    discoveryObservationDays: policy.discoveryObservationDays,
    enabled: policy.enabled,
    lastPrunedAt: prunedAt,
    lastPruneResult: {
      outcome,
      jobExecutionsDeleted,
      notificationsDeleted,
      discoveryObservationsDeleted,
      durationMs,
      cutoffs: {
        jobExecutions: jobCut.toISOString(),
        notifications: notifCut.toISOString(),
        discoveryObservations: obsCut.toISOString(),
      },
      triggeredBy,
      prunedAt,
      correlationId,
    },
  };
  await db.$transaction(
    async (tx) => {
      await tx.setting.upsert({
        where: { key: OPS_DATA_RETENTION_KEY },
        update: { valueJson: JSON.stringify(updatedPolicy) },
        create: { key: OPS_DATA_RETENTION_KEY, valueJson: JSON.stringify(updatedPolicy) },
      });
      await tx.auditEvent.create({
        data: {
          actorName: "system:ops-retention-worker",
          action: "OPS_DATA_PRUNED",
          resourceType: "Setting",
          resourceId: OPS_DATA_RETENTION_KEY,
          resourceLabel: "Ops data retention sweep",
          result: "SUCCESS",
          correlationId,
          afterJson: JSON.stringify(result),
        },
      });
    },
    { maxWait: 5_000, timeout: 30_000 }
  );

  return result;
}
