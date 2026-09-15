/**
 * Bun test preload (runs ONCE per test process, BEFORE any test module).
 *
 * WHY THIS EXISTS: the sandbox shell exports a stale SQLite-era
 * DATABASE_URL (file:...) that overrides .env, while the repository's
 * schema provider is postgresql (prisma/schema.prisma) and CI exports a
 * real postgres URL (ci.yml). Prisma resolves env("DATABASE_URL") when the
 * client is CONSTRUCTED — inside the first test file's import graph — so a
 * per-test-file fix is too late whenever another file built the client
 * first. This preload aligns the URL before ANY module loads.
 *
 * The documented sandbox dev DB is the embedded PostgreSQL 16 on port 5433
 * (.env / .env.example). A real postgres:// URL (CI's) is NEVER overridden.
 */

if (
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.startsWith("file:")
) {
  process.env.DATABASE_URL =
    "postgresql://fayanms:fayanms@localhost:5433/fayanms";
}
