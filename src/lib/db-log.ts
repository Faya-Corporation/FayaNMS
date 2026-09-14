/**
 * Prisma log-level policy (P2-1, external ULTRA audit).
 *
 * The audit finding: `new PrismaClient({ log: ['query'] })` shipped EVERY
 * SQL statement to stdout in production — query text can carry tenant
 * identifiers and device payloads into aggregate logs, and the volume
 * burns I/O for zero operational value by default.
 *
 * Policy (fail-safe default + explicit ops escape hatch):
 *   - production  → ["error", "warn"]  — query logging OFF
 *   - non-prod    → ["query", "error", "warn"] — full dev visibility
 *   - FAYANMS_DB_QUERY_LOG=true|1|yes → query logging ON in ANY mode,
 *     for time-boxed incident debugging (documented in the deploy note;
 *     the operator, not the default, owns that exposure).
 *
 * Pure function on the environment so the policy is unit-pinnable
 * (tests/audit/config-hygiene.test.ts) — src/lib/db.ts only delegates.
 */

export const DB_QUERY_LOG_ENV = "FAYANMS_DB_QUERY_LOG";

export type PrismaLogLevel = "query" | "error" | "warn";

const TRUTHY = /^(1|true|yes)$/i;

export function prismaLogLevels(
  env: NodeJS.ProcessEnv = process.env
): PrismaLogLevel[] {
  if (TRUTHY.test((env[DB_QUERY_LOG_ENV] ?? "").trim())) {
    return ["query", "error", "warn"];
  }
  if (env.NODE_ENV === "production") {
    return ["error", "warn"];
  }
  return ["query", "error", "warn"];
}
