-- AlterTable
ALTER TABLE "ChangeApproval" ADD COLUMN     "quorumRequired" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "ChangeRequest" ADD COLUMN     "approvalFingerprint" TEXT;

-- CreateTable
CREATE TABLE "ChangeApprovalDecision" (
    "id" TEXT NOT NULL,
    "approvalId" TEXT NOT NULL,
    "approverId" TEXT,
    "approverName" TEXT,
    "decision" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "comment" TEXT,

    CONSTRAINT "ChangeApprovalDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeApprovalDecision_approvalId_idx" ON "ChangeApprovalDecision"("approvalId");

-- CreateIndex
CREATE INDEX "ChangeApprovalDecision_approverId_idx" ON "ChangeApprovalDecision"("approverId");

-- AddForeignKey
ALTER TABLE "ChangeApprovalDecision" ADD CONSTRAINT "ChangeApprovalDecision_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "ChangeApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeApprovalDecision" ADD CONSTRAINT "ChangeApprovalDecision_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
