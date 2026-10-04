-- F-030 (batch-11): persisted per-user daily AI quota.
CREATE TABLE "AiUsageDay" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiUsageDay_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiUsageDay_userId_day_key" ON "AiUsageDay"("userId", "day");

ALTER TABLE "AiUsageDay"
    ADD CONSTRAINT "AiUsageDay_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
