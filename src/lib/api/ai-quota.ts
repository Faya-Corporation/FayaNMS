/**
 * F-030 (batch-11) — persisted per-user daily AI quota.
 *
 * HISTORY OF THE DEFECT: the four /api/v1/ai routes were available to
 * EVERY active role with only the proxy's burst budget in front of them —
 * RATE_LIMIT_AI (10/min) is IP-keyed, pre-handler, and in-memory, so a
 * single authenticated account could burn 600 LLM round-trips per hour
 * forever, with NO per-account ceiling anywhere.
 *
 * THE FIX: a durable per-user, per-UTC-day counter (AiUsageDay — one row
 * per (user, day), atomic upsert-increment) consumed IN-HANDLER by each
 * AI route immediately before it starts an LLM round-trip. The identity
 * is known only after resolveActingUser, which is why this gate cannot
 * live in the proxy plane — the two gates are complementary:
 *
 *   proxy (rate-gate.ts, RATE_LIMIT_AI)   → 10/min per CLIENT — burst flood
 *   this module (consumeAiDailyQuota)     → N/day per USER — durable cost cap
 *
 * Semantics:
 *   - Consumption happens when a request is about to start its FIRST LLM
 *     call (query's stage-1 plan included) — requests refused earlier by
 *     validation/auth/404s never burn quota.
 *   - The slot that crosses the limit IS consumed (the counter records
 *     true attempted usage) but the request is refused: allowed = used ≤ limit.
 *   - Day key: UTC calendar date string (aiQuotaDay) — resets at 00:00 UTC,
 *     no timezone plumbing.
 *   - Limit: FAYANMS_AI_DAILY_LIMIT (default 200/user/day). Invalid values
 *     fall back to the documented default — a typo must not disable AI or
 *     zero it out silently.
 *   - Store failure (missing migration, transient DB error): FAIL-CLOSED
 *     with AI_QUOTA_STORE_UNAVAILABLE (the same posture as the shared
 *     rate store in SCALE-001-A — an unavailable enforcement store means
 *     an unenforced budget).
 *   - The role-restriction plane (which roles may use AI at all) stays a
 *     deliberate owner decision and is NOT implemented here — this cap
 *     bounds the cost of whatever access the operator grants.
 */

import { db } from "@/lib/db";

/** Default durable per-user daily cap (LLM round-trips). */
export const AI_DAILY_QUOTA_DEFAULT = 200;

/** The quota env knob — absent/invalid falls back to the documented default. */
export function getAiDailyQuotaLimit(): number {
  const raw = process.env.FAYANMS_AI_DAILY_LIMIT?.trim();
  if (raw === undefined || raw === "") return AI_DAILY_QUOTA_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return AI_DAILY_QUOTA_DEFAULT;
  return Math.floor(parsed);
}

/** The UTC calendar-day key ("YYYY-MM-DD") the counter is keyed by. */
export function aiQuotaDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type AiQuotaDecision =
  | { ok: true; used: number; limit: number; day: string }
  | {
      ok: false;
      code: "AI_DAILY_QUOTA_EXCEEDED";
      used: number;
      limit: number;
      day: string;
    }
  | { ok: false; code: "AI_QUOTA_STORE_UNAVAILABLE"; day: string };

/**
 * Consume one AI slot for the user on the current UTC day and rule on the
 * request. opts exists for tests and future callers that need an explicit
 * limit/day; production routes call it with no arguments.
 */
export async function consumeAiDailyQuota(
  userId: string,
  opts?: { limit?: number; day?: string }
): Promise<AiQuotaDecision> {
  const day = opts?.day ?? aiQuotaDay();
  const limit = opts?.limit ?? getAiDailyQuotaLimit();

  let used: number;
  try {
    const row = await db.aiUsageDay.upsert({
      where: { userId_day: { userId, day } },
      update: { count: { increment: 1 } },
      create: { userId, day, count: 1 },
      select: { count: true },
    });
    used = row.count;
  } catch (error) {
    // Fail-closed: an unavailable enforcement store is an unenforced budget.
    console.error("[ai-quota] store failure — refusing (fail-closed)", error);
    return { ok: false, code: "AI_QUOTA_STORE_UNAVAILABLE", day };
  }

  if (used > limit) {
    return { ok: false, code: "AI_DAILY_QUOTA_EXCEEDED", used, limit, day };
  }
  return { ok: true, used, limit, day };
}
