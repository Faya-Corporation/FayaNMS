-- CreateTable
CREATE TABLE "RateLimitHit" (
    "id" SERIAL NOT NULL,
    "bucketKey" TEXT NOT NULL,
    "hitAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitHit_bucketKey_hitAt_idx" ON "RateLimitHit"("bucketKey", "hitAt");

-- CreateIndex
CREATE INDEX "RateLimitHit_hitAt_idx" ON "RateLimitHit"("hitAt");
