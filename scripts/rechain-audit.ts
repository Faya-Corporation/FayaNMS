/**
 * Phase 19-C — audit-chain repair for the SQLite demo (AUD-101 residual).
 *
 * WHY THIS EXISTS: the audit-chain stamp runs inside interactive
 * transactions, so a business transaction that ROLLS BACK after its audit
 * create leaves a "phantom" chain head; a create inside the ≤5 s
 * revalidation window may then commit a row whose prevHash references the
 * phantom (never-persisted) hash — a dangling link the DB-level
 * @@unique([prevHash]) cannot prevent. verifyAuditChain honestly reports
 * this as INVALID (dangling links / unreachable rows).
 *
 * In production (Phase 21) this class of hole is prevented by PostgreSQL
 * advisory locks + a monotonic chain sequence. On the single-writer SQLite
 * demo, the recovery is a FULL RE-CHAIN: rows are re-hashed in canonical
 * (createdAt ASC, id ASC) order so every prevHash/hash pair is consistent
 * again. THIS REWRITES HASH HISTORY — it is an operator-maintenance tool
 * for the demo database, never a production practice (production chains
 * are anchored by externally stored checkpoints, so wholesale rehashing
 * would be detectable).
 *
 * Usage (STOP the dev server + worker first):
 *   bun scripts/rechain-audit.ts
 */
import { PrismaClient } from "@prisma/client";

import {
  computeAuditHash,
  invalidateAuditHead,
} from "../src/lib/audit/chain";

const db = new PrismaClient();

async function main(): Promise<void> {
  const rows = await db.auditEvent.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
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
    },
  });
  console.log(`[rechain] ${rows.length} audit rows loaded`);

  let changed = 0;
  let prev: string | null = null;
  for (const row of rows) {
    const hash = computeAuditHash({
      prevHash: prev,
      createdAt: row.createdAt,
      action: row.action,
      actorName: row.actorName,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      result: row.result,
      correlationId: row.correlationId,
      beforeJson: row.beforeJson,
      afterJson: row.afterJson,
    });
    if (row.prevHash !== prev || row.hash !== hash) {
      await db.auditEvent.update({
        where: { id: row.id },
        data: { prevHash: prev, hash },
      });
      changed += 1;
    }
    prev = hash;
  }
  invalidateAuditHead();
  console.log(`[rechain] done — ${changed} row(s) re-stamped; chain is whole again`);
}

main()
  .catch((error) => {
    console.error("[rechain] FAILED:", error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
