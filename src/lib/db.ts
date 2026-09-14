import { PrismaClient } from '@prisma/client'

import { invalidateAuditHead, stampAuditHash } from '@/lib/audit/chain'
import { prismaLogLevels } from '@/lib/db-log'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// P2-1 (external ULTRA audit): log levels come from the policy in
// src/lib/db-log.ts — production defaults to errors+warnings only; the
// unconditional query-level log that shipped every SQL statement to
// production stdout is gone (FAYANMS_DB_QUERY_LOG=true is the explicit
// ops escape hatch).
const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: prismaLogLevels(),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma

/** Max attempts when the prevHash unique index rejects a concurrent stamp. */
const CHAIN_CONFLICT_RETRIES = 3

function isPrevHashConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002' &&
    JSON.stringify((error as { meta?: { target?: unknown } }).meta?.target ?? '').includes(
      'prevHash'
    )
  )
}

/**
 * Audit hash chain (Task 7-b + Phase 19 AUD-001): every `auditEvent.create`
 * — current and future, including Task 7-a's sign-in audit — is stamped with
 * hash/prevHash by the extension below before the query runs. See
 * src/lib/audit/chain.ts for the canonical payload and concurrency model.
 * The revalidation read uses the BASE client (no extension) so stamping
 * can never recurse.
 *
 * DB-LEVEL FORK PROTECTION (P19): the @@unique([prevHash]) index makes a
 * chain fork physically impossible. When two writers stamp onto the same
 * tail concurrently, exactly one INSERT commits; the loser's create fails
 * with P2002 and is retried here: the head cache is invalidated, the row is
 * re-stamped onto the NEW tail and the create runs again — the chain always
 * converges to a single linear sequence, even across processes.
 */
export const db = basePrisma.$extends({
  query: {
    auditEvent: {
      async create({ args, query }) {
        const stampArgs = args as unknown as { data?: Record<string, unknown> };
        for (let attempt = 0; ; attempt += 1) {
          await stampAuditHash(stampArgs, basePrisma);
          try {
            return await query(args);
          } catch (error) {
            if (attempt < CHAIN_CONFLICT_RETRIES && isPrevHashConflict(error)) {
              // Another writer took the tail — re-read it and re-stamp.
              invalidateAuditHead();
              delete stampArgs.data?.prevHash;
              delete stampArgs.data?.hash;
              continue;
            }
            throw error;
          }
        }
      },
    },
  },
})
