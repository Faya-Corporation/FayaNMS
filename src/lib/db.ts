import { PrismaClient } from '@prisma/client'

import { stampAuditHash } from '@/lib/audit/chain'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['query'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = basePrisma

/**
 * Audit hash chain (Task 7-b): every `auditEvent.create` — current and
 * future, including Task 7-a's sign-in audit — is stamped with
 * hash/prevHash by the extension below before the query runs. See
 * src/lib/audit/chain.ts for the canonical payload and concurrency model.
 * The revalidation read uses the BASE client (no extension) so stamping
 * can never recurse.
 */
export const db = basePrisma.$extends({
  query: {
    auditEvent: {
      async create({ args, query }) {
        await stampAuditHash(
          args as unknown as { data?: Record<string, unknown> },
          basePrisma
        );
        return query(args);
      },
    },
  },
})
