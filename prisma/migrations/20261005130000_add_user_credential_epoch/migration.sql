-- AlterTable
-- Wave-9 credential epoch (audit 9-a F-3): incremented inside the SAME
-- transaction whenever an admin SETS the password; minted into the session
-- JWT at sign-in ONLY and re-checked per-request in requireUser. Default 0
-- keeps every pre-existing token valid.
ALTER TABLE "User" ADD COLUMN     "credentialEpoch" INTEGER NOT NULL DEFAULT 0;
