-- Post-register audit wave 5 (defense-in-depth): a recovery-code row is
-- unique PER ENROLLMENT. Single-use consumption already rides the
-- conditional updateMany (usedAt: null -> stamped); this composite unique
-- makes duplicate draws structurally impossible. Purely additive.
CREATE UNIQUE INDEX "UserMfaRecoveryCode_mfaId_codeHash_key" ON "UserMfaRecoveryCode"("mfaId", "codeHash");
