-- AlterTable
-- SAFE-007: typed executable intent on ChangeRequest. GENERIC for all
-- pre-existing rows; the restore flow stamps RESTORE_SNAPSHOT (see the
-- snapshot-restore route). The change engine refuses LIVE_SSH apply for
-- restore changes until snapshot-exact restore semantics ship (SAFE-008/009).
ALTER TABLE "ChangeRequest" ADD COLUMN     "operationKind" TEXT NOT NULL DEFAULT 'GENERIC';
