import { createHash } from "node:crypto";
import type { AuditEvent, PrismaClient } from "@prisma/client";

/**
 * Audit hash chain (Task 7-b).
 *
 * Every AuditEvent row is part of a tamper-evident, append-only chain:
 *
 *   hash = sha256( (prevHash ?? "GENESIS")
 *                + "|" + createdAt.toISOString()
 *                + "|" + action
 *                + "|" + actorName
 *                + "|" + resourceType
 *                + "|" + (resourceId ?? "")
 *                + "|" + result
 *                + "|" + (correlationId ?? "")
 *                + "|" + (beforeJson ?? "")
 *                + "|" + (afterJson ?? "") )
 *
 *   prevHash = hash of the previous event in chain order
 *              (createdAt ASC, id ASC — the order the verifier walks);
 *              the very first event chains onto the literal "GENESIS" marker.
 *
 * HOW CHAINING HAPPENS AUTOMATICALLY: `src/lib/db.ts` wraps the Prisma
 * client in a `$extends` query interceptor for `auditEvent.create`. The
 * interceptor calls `stampAuditHash(args, …)` below, which:
 *   1. re-validates the in-memory chain head against the DB at most once
 *      per REVALIDATE_MS (cheap SELECT of the newest hashed row),
 *   2. computes hash/prevHash from the row payload (also stamping
 *      `createdAt` so the stored value matches the signed value exactly),
 *   3. mutates the create args before the query runs.
 * Routes never call this file directly — they keep writing plain
 * `db.auditEvent.create(...)` and inherit the chain (including Task 7-a's
 * sign-in audit in src/lib/auth/options.ts).
 *
 * EVENTS WRITTEN BEFORE THE CHAIN EXISTED (all rows created before Task 7-b
 * carry hash = null) stay unhashed until POST
 * /api/v1/admin/audit-chain/backfill processes them oldest→newest. While no
 * hashed predecessor exists anywhere, the stamp is a no-op so new rows are
 * also left for the backfill (otherwise they would root themselves at
 * "GENESIS" mid-chain). Once at least one hashed row exists, every new
 * event chains automatically.
 *
 * CONCURRENCY MODEL (a single Next.js process writes every audit row):
 *   - Hot path (head validated < REVALIDATE_MS ago) is a pure-synchronous
 *     read-compute-assign — atomic under the JS event loop, no await, so
 *     two creates can never interleave mid-stamp.
 *   - Head (re)validation takes a module-level promise mutex so the
 *     cold-read → compute → assign section stays atomic; the DB write
 *     itself runs AFTER the mutex releases (reads never block writers).
 *   - Backfill holds the same mutex for its whole run so concurrent
 *     creates queue behind it instead of chaining onto a head the backfill
 *     is about to extend.
 *   - A business transaction that rolls back after its audit create can
 *     leave a "phantom" head for up to REVALIDATE_MS — the next
 *     revalidation re-reads the DB and self-heals. The verifier
 *     (verifyAuditChain) is always authoritative.
 */

/** Milliseconds before the in-memory chain head must be re-read from the DB. */
const REVALIDATE_MS = 5_000;

/** Genesis marker used as the first canonical field when prevHash is null. */
export const GENESIS = "GENESIS";

interface AuditHead {
  /** Hash of the most recently known chained event (null = none exists). */
  hash: string | null;
  /** Date.now() of the last DB validation. */
  validatedAt: number;
}

interface GlobalState {
  __fayaAuditHead?: AuditHead;
  __fayaAuditMutex?: Promise<void>;
  __fayaAuditBackfill?: boolean;
}

const globalState = globalThis as unknown as GlobalState;

function getHead(): AuditHead {
  return (globalState.__fayaAuditHead ??= { hash: null, validatedAt: 0 });
}

function setHead(head: AuditHead): void {
  globalState.__fayaAuditHead = head;
}

/** Force the next audit create to re-read the chain head from the DB. */
export function invalidateAuditHead(): void {
  globalState.__fayaAuditHead = { hash: getHead().hash, validatedAt: 0 };
}

/** Serialize a critical section against head revalidation and the backfill. */
async function withAuditMutex<T>(fn: () => Promise<T>): Promise<T> {
  const previous = globalState.__fayaAuditMutex ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalState.__fayaAuditMutex = gate;
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/* ───────────────────────── canonical hashing ───────────────────────── */

export interface AuditChainFields {
  prevHash: string | null;
  createdAt: Date | string;
  action: string;
  actorName: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  correlationId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
}

/** Canonical sha256 over the documented field order. */
export function computeAuditHash(fields: AuditChainFields): string {
  const canonical = [
    fields.prevHash ?? GENESIS,
    new Date(fields.createdAt).toISOString(),
    fields.action,
    fields.actorName,
    fields.resourceType,
    fields.resourceId ?? "",
    fields.result,
    fields.correlationId ?? "",
    fields.beforeJson ?? "",
    fields.afterJson ?? "",
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** The row projection every chain operation needs. */
const CHAIN_SELECT = {
  id: true,
  createdAt: true,
  action: true,
  actorName: true,
  resourceType: true,
  resourceId: true,
  result: true,
  correlationId: true,
  beforeJson: true,
  afterJson: true,
  hash: true,
  prevHash: true,
} as const;

type ChainRow = Pick<AuditEvent, keyof typeof CHAIN_SELECT>;

function rowFields(row: ChainRow, prevHash: string | null): AuditChainFields {
  return {
    prevHash,
    createdAt: row.createdAt,
    action: row.action,
    actorName: row.actorName,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    result: row.result,
    correlationId: row.correlationId,
    beforeJson: row.beforeJson,
    afterJson: row.afterJson,
  };
}

/* ───────────────────────── write-path stamping ───────────────────────── */

/**
 * Prisma `$extends` interceptor payload — deliberately loose so the same
 * helper stamps every create-args shape the routes use.
 */
interface CreateArgs {
  data?: Record<string, unknown>;
}

/**
 * Stamp hash/prevHash onto an `auditEvent.create` args object. No-op when
 * the caller already controls the hash (backfill paths write via `update`)
 * or when no hashed predecessor exists (rows stay null → backfill).
 */
export async function stampAuditHash(
  args: CreateArgs,
  readClient: PrismaClient
): Promise<void> {
  const data = args?.data;
  if (!data || typeof data !== "object") return;
  if (data.hash !== undefined || data.prevHash !== undefined) return;

  // The canonical payload signs createdAt — pin it here so the stored
  // column always matches the signed value (Prisma's default(now()) would
  // otherwise be invisible to this stamp).
  if (data.createdAt === undefined) data.createdAt = new Date();

  const head = getHead();
  const fresh = Date.now() - head.validatedAt <= REVALIDATE_MS;

  let prevHash: string | null;
  if (fresh) {
    prevHash = head.hash;
  } else {
    prevHash = await withAuditMutex(async () => {
      const current = getHead();
      if (Date.now() - current.validatedAt <= REVALIDATE_MS) {
        return current.hash;
      }
      const latest = await readClient.auditEvent.findFirst({
        where: { hash: { not: null } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { hash: true },
      });
      const next: AuditHead = { hash: latest?.hash ?? null, validatedAt: Date.now() };
      setHead(next);
      return next.hash;
    });
  }

  // No hashed predecessor anywhere → leave the row for the backfill
  // (hashing it now would root it at GENESIS in the middle of the chain).
  if (prevHash === null) return;

  const fields = rowFields(data as unknown as ChainRow, prevHash);
  const hash = computeAuditHash(fields);
  data.prevHash = prevHash;
  data.hash = hash;
  // Optimistically advance the head; a rolled-back surrounding transaction
  // is repaired by the next revalidation (≤ REVALIDATE_MS).
  setHead({ hash, validatedAt: getHead().validatedAt });
}

/* ───────────────────────── verification ───────────────────────── */

export interface ChainBreak {
  id: string;
  index: number;
  reason: "unhashed" | "prev-hash-mismatch" | "hash-mismatch";
}

export interface ChainVerifyResult {
  valid: boolean;
  checked: number;
  brokenAt?: ChainBreak;
}

/**
 * Walk the whole chain in canonical order (createdAt ASC, id ASC),
 * recomputing every hash. Stops at the first break.
 */
export async function verifyAuditChain(
  client: PrismaClient,
  maxRows = 5_000
): Promise<ChainVerifyResult> {
  const rows = await client.auditEvent.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: maxRows,
    select: CHAIN_SELECT,
  });

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.hash) {
      return {
        valid: false,
        checked: index + 1,
        brokenAt: { id: row.id, index, reason: "unhashed" },
      };
    }
    const expectedPrev = index === 0 ? null : rows[index - 1].hash;
    if ((row.prevHash ?? null) !== expectedPrev) {
      return {
        valid: false,
        checked: index + 1,
        brokenAt: { id: row.id, index, reason: "prev-hash-mismatch" },
      };
    }
    const recomputed = computeAuditHash(rowFields(row, row.prevHash ?? null));
    if (recomputed !== row.hash) {
      return {
        valid: false,
        checked: index + 1,
        brokenAt: { id: row.id, index, reason: "hash-mismatch" },
      };
    }
  }

  return { valid: true, checked: rows.length };
}

/* ───────────────────────── backfill ───────────────────────── */

export interface ChainBackfillResult {
  filled: number;
  remaining: number;
}

/**
 * Hash every null-hash event oldest→newest, in batches, chaining each onto
 * the previous row in canonical order. Holds the audit mutex for the whole
 * run so concurrent live creates queue behind it (they revalidate and chain
 * onto the freshly backfilled tail afterwards). Rows created while the
 * backfill held the mutex are picked up by the next loop iteration; the
 * loop terminates when no null-hash rows remain (capped for safety).
 */
export async function backfillAuditChain(
  client: PrismaClient,
  maxRows = 2_000,
  batchSize = 100
): Promise<ChainBackfillResult> {
  const filled = await withAuditMutex(async () => {
    globalState.__fayaAuditBackfill = true;
    let count = 0;
    try {
      while (count < maxRows) {
        const rows = await client.auditEvent.findMany({
          where: { hash: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: Math.min(batchSize, maxRows - count),
          select: CHAIN_SELECT,
        });
        if (rows.length === 0) break;

        for (const row of rows) {
          const latest = await client.auditEvent.findFirst({
            where: { hash: { not: null } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { hash: true },
          });
          const prevHash = latest?.hash ?? null;
          const hash = computeAuditHash(rowFields(row, prevHash));
          await client.auditEvent.update({
            where: { id: row.id },
            data: { prevHash, hash },
          });
          count += 1;
        }
      }
      return count;
    } finally {
      globalState.__fayaAuditBackfill = false;
    }
  });

  // Live creates queued behind the backfill must re-read the head instead
  // of trusting a pre-backfill cache.
  invalidateAuditHead();
  const remaining = await client.auditEvent.count({ where: { hash: null } });
  return { filled, remaining };
}
