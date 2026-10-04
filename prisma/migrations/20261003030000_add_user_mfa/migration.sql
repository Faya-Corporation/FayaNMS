-- F-034 (batch-24): TOTP second factor for privileged roles (admin/operator).
-- Additive only: two new tables + indexes; no existing column is touched.
-- The TOTP secret lives in UserMfa.totpSecretEnc as an enc1: AES-256-GCM
-- at-rest envelope (src/lib/config/crypto.ts, FAYANMS_CONFIG_ENC_KEY master
-- key) — plaintext secrets never reach the database.

CREATE TABLE "UserMfa" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "totpSecretEnc" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastTotpStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserMfa_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserMfaRecoveryCode" (
    "id" TEXT NOT NULL,
    "mfaId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "UserMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserMfa_userId_key" ON "UserMfa"("userId");
CREATE INDEX "UserMfa_enabled_idx" ON "UserMfa"("enabled");
CREATE INDEX "UserMfaRecoveryCode_mfaId_idx" ON "UserMfaRecoveryCode"("mfaId");

ALTER TABLE "UserMfa"
    ADD CONSTRAINT "UserMfa_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserMfaRecoveryCode"
    ADD CONSTRAINT "UserMfaRecoveryCode_mfaId_fkey"
    FOREIGN KEY ("mfaId") REFERENCES "UserMfa"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
