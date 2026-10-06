-- GA-3 (2026-10-06 re-audit): API-client credential lifecycle + resource scope.
-- All columns are nullable: legacy rows keep their exact pre-GA-3 behavior
-- (no expiry, global resource scope) until an admin acts on them.

-- AlterTable
ALTER TABLE "ApiClient" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "rotatedAt" TIMESTAMP(3),
ADD COLUMN     "lastRotatedFromId" TEXT,
ADD COLUMN     "siteScopeJson" TEXT;
