-- TASK-SCALE-001-B (independent audit 2026-09-15) — shared login-guard
-- state, the distributed backend for AUTH-001-A's lockout plane. One row
-- per guard key; `failures` is the bounded failure-stamp array (epoch ms).
-- Read-modify-write serializes on a per-key advisory xact lock inside one
-- transaction, so lockout state cannot race across app instances under
-- FAYANMS_RATE_STORE=postgres (same knob and atomic shape as RateLimitHit).

CREATE TABLE "LoginGuardState" (
    "key" TEXT NOT NULL,
    "failures" JSONB NOT NULL DEFAULT '[]',
    "lockoutUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockoutCount" INTEGER NOT NULL DEFAULT 0,
    "denialEmittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginGuardState_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "LoginGuardState_updatedAt_idx" ON "LoginGuardState"("updatedAt");
