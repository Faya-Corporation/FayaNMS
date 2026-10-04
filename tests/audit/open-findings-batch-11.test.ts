/**
 * Open-findings batch 11 — F-030 (P3, BACKLOG order 2):
 * LLM endpoints available to every role; no per-user daily cap.
 *
 *   History: the four /api/v1/ai routes (query, assist, change-draft,
 *   rca-draft) ran with only the proxy's burst budget in front of them —
 *   RATE_LIMIT_AI (10/min) is IP-keyed, pre-handler, and in-memory — so a
 *   single authenticated account could burn 600 LLM round-trips per hour
 *   forever with NO per-account ceiling.
 *
 *   The remediation (the BACKLOG plan's named core): a PERSISTED per-user
 *   per-UTC-day counter (AiUsageDay, userId+day unique) consumed
 *   IN-HANDLER by all four AI routes immediately before their FIRST LLM
 *   round-trip (the proxy plane cannot see the user identity — the burst
 *   gate stays untouched as the complementary layer). Over-limit requests
 *   answer 429 AI_DAILY_QUOTA_EXCEEDED; a store failure fails CLOSED with
 *   AI_QUOTA_STORE_UNAVAILABLE (the SCALE-001-A posture). The
 *   role-restriction plane (which roles may use AI at all) stays the
 *   documented owner decision — the cap bounds the cost of whatever
 *   access the operator grants.
 *
 *   The quota is consumed only when a request would actually start LLM
 *   work: validation/auth/404 refusals upstream never burn the day.
 *
 * Same certified rig as batches 2-10 (rt012/rt014 ensure-helpers, REAL
 * minted session tokens — no mock.module). The quota helper itself is
 * probed against the REAL database; the route wiring is pinned by source
 * (all four handlers call consumeAiDailyQuota BEFORE their first aiChat)
 * plus a live handler-level 429 through ai/assist with an exhausted
 * counter (no LLM key needed — the quota gate fires first by design).
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { db } from "../../src/lib/db";
import {
  AI_DAILY_QUOTA_DEFAULT,
  aiQuotaDay,
  consumeAiDailyQuota,
  getAiDailyQuotaLimit,
} from "../../src/lib/api/ai-quota";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/* ── self-contained identity (the certified rt012/rt014 pattern) ─────── */

type Batch11User = { id: string; email: string; name: string | null; role: string };
let batch11User: Batch11User | null = null;

async function ensureBatch11User(): Promise<Batch11User> {
  if (batch11User) return batch11User;
  const matrixEntry = ROLE_MATRIX.find((role) => role.name === "operator");
  if (!matrixEntry) throw new Error("role operator missing from ROLE_MATRIX");
  await db.role.upsert({
    where: { name: "operator" },
    update: {},
    create: {
      name: "operator",
      description: matrixEntry.description,
      permissionsJson: JSON.stringify([...matrixEntry.permissions]),
    },
  });
  const email = "batch11-quota@faya.local";
  batch11User = await db.user.upsert({
    where: { email },
    update: { isActive: true },
    create: { email, name: "Batch11 Quota", role: "operator", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });
  return batch11User;
}

describe("F-030 (batch 11): persisted per-user daily AI quota", () => {
  test("aiQuotaDay returns the UTC YYYY-MM-DD key", () => {
    expect(aiQuotaDay(new Date("2026-10-02T03:04:05.678Z"))).toBe("2026-10-02");
    expect(aiQuotaDay(new Date("2026-12-31T23:59:59.000Z"))).toBe("2026-12-31");
    // A non-UTC instant whose local date differs still keys by UTC date.
    expect(aiQuotaDay(new Date("2026-01-01T00:30:00.000Z"))).toBe("2026-01-01");
  });

  test("getAiDailyQuotaLimit: default, env override, invalid → default (never 0)", () => {
    expect(AI_DAILY_QUOTA_DEFAULT).toBe(200);
    const saved = process.env.FAYANMS_AI_DAILY_LIMIT;
    try {
      delete process.env.FAYANMS_AI_DAILY_LIMIT;
      expect(getAiDailyQuotaLimit()).toBe(200);
      process.env.FAYANMS_AI_DAILY_LIMIT = "7";
      expect(getAiDailyQuotaLimit()).toBe(7);
      process.env.FAYANMS_AI_DAILY_LIMIT = "0";
      expect(getAiDailyQuotaLimit()).toBe(200);
      process.env.FAYANMS_AI_DAILY_LIMIT = "abc";
      expect(getAiDailyQuotaLimit()).toBe(200);
      process.env.FAYANMS_AI_DAILY_LIMIT = "-5";
      expect(getAiDailyQuotaLimit()).toBe(200);
    } finally {
      if (saved === undefined) delete process.env.FAYANMS_AI_DAILY_LIMIT;
      else process.env.FAYANMS_AI_DAILY_LIMIT = saved;
    }
  });

  test("the counter persists, increments, and refuses AT the limit (allowed = used ≤ limit)", async () => {
    const user = await ensureBatch11User();
    const day = `batch11-${aiQuotaDay()}`; // unique-per-run day key: real column, isolated counter
    // Rerun-idempotent: drop any row a previous run left on this key.
    await db.aiUsageDay.deleteMany({ where: { userId: user.id, day } });
    // Fresh key → first consumption allowed (used 1 of 3).
    const first = await consumeAiDailyQuota(user.id, { limit: 3, day });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.used).toBe(1);
    expect(first.limit).toBe(3);
    // Second + third consume.
    const second = await consumeAiDailyQuota(user.id, { limit: 3, day });
    expect(second.ok).toBe(true);
    const third = await consumeAiDailyQuota(user.id, { limit: 3, day });
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error("unreachable");
    expect(third.used).toBe(3);
    // The crossing slot is CONSUMED (counter records true usage) but refused.
    const fourth = await consumeAiDailyQuota(user.id, { limit: 3, day });
    expect(fourth.ok).toBe(false);
    if (fourth.ok || fourth.code !== "AI_DAILY_QUOTA_EXCEEDED") {
      throw new Error(`expected AI_DAILY_QUOTA_EXCEEDED, got: ${JSON.stringify(fourth)}`);
    }
    expect(fourth.used).toBe(4);
    expect(fourth.limit).toBe(3);
    // And it stays refused.
    const fifth = await consumeAiDailyQuota(user.id, { limit: 3, day });
    expect(fifth.ok).toBe(false);
    // Persisted row: one per (user, day), count = true consumption.
    const row = await db.aiUsageDay.findUnique({
      where: { userId_day: { userId: user.id, day } },
      select: { count: true },
    });
    expect(row?.count).toBe(5);
  });

  test("per-user isolation: another account's exhaustion never leaks", async () => {
    const user = await ensureBatch11User();
    const other = await db.user.create({
      data: {
        email: `batch11-quota-other-${Date.now()}@faya.local`,
        name: "Batch11 Quota Other",
        role: "operator",
        isActive: true,
        passwordHash: "batch11-test-no-login",
      },
      select: { id: true, email: true, name: true, role: true },
    });
    try {
      const day = aiQuotaDay();
      // Exhaust the primary user's day key directly.
      await consumeAiDailyQuota(user.id, { limit: 1, day: `batch11-iso-${day}` });
      // The other user starts fresh on the SAME key.
      const fresh = await consumeAiDailyQuota(other.id, { limit: 1, day: `batch11-iso-${day}` });
      expect(fresh.ok).toBe(true);
    } finally {
      await db.aiUsageDay.deleteMany({ where: { userId: other.id } });
      await db.user.delete({ where: { id: other.id } });
    }
  });

  test("day rollover: a different UTC day key starts a fresh budget", async () => {
    const user = await ensureBatch11User();
    // Rerun-idempotent: drop any rows previous runs left on these keys.
    await db.aiUsageDay.deleteMany({
      where: { userId: user.id, day: { in: ["batch11-rollover-day1", "batch11-rollover-day2"] } },
    });
    const exhausted = await consumeAiDailyQuota(user.id, {
      limit: 1,
      day: "batch11-rollover-day1",
    });
    expect(exhausted.ok).toBe(true);
    const refused = await consumeAiDailyQuota(user.id, {
      limit: 1,
      day: "batch11-rollover-day1",
    });
    expect(refused.ok).toBe(false);
    const nextDay = await consumeAiDailyQuota(user.id, {
      limit: 1,
      day: "batch11-rollover-day2",
    });
    expect(nextDay.ok).toBe(true);
  });

  test("SOURCE PIN: all four AI routes consume the quota BEFORE their first aiChat call", () => {
    for (const route of ["query", "assist", "change-draft", "rca-draft"]) {
      const source = readFileSync(
        join("src", "app", "api", "v1", "ai", route, "route.ts"),
        "utf8"
      );
      expect(source.includes("consumeAiDailyQuota(actor.id)"), route).toBe(true);
      expect(source.includes("AI_DAILY_QUOTA_EXCEEDED"), route).toBe(true);
      const quotaAt = source.indexOf("consumeAiDailyQuota(actor.id)");
      const chatAt = source.indexOf("await aiChat(");
      expect(quotaAt, `${route}: quota gate precedes aiChat`).toBeGreaterThan(-1);
      expect(chatAt, `${route}: has an aiChat call`).toBeGreaterThan(-1);
      expect(quotaAt < chatAt, `${route}: quota BEFORE aiChat`).toBe(true);
    }
    // The complementary burst gate is untouched in the proxy plane.
    const rateGate = readFileSync("src/lib/api/rate-gate.ts", "utf8");
    expect(rateGate).toContain("RATE_LIMIT_AI = 10");
    expect(rateGate).toContain('family: "ai"');
  });

  test("LIVE HANDLER PIN: ai/assist answers 429 AI_DAILY_QUOTA_EXCEEDED with meta (quota fires before any LLM work)", async () => {
    const user = await ensureBatch11User();
    // Minimal REAL target entity: the quota gate sits after context
    // assembly by design (validation/404 refusals never burn quota), so
    // the live 429 needs a device the context builder can find.
    const vendor = await db.vendor.upsert({
      where: { key: "batch11" },
      update: {},
      create: { key: "batch11", name: "Batch11 Vendor", adapterKey: "batch11" },
      select: { id: true },
    });
    const device = await db.device.upsert({
      where: { hostname: "batch11-quota-device" },
      update: { vendorId: vendor.id },
      create: {
        hostname: "batch11-quota-device",
        mgmtIp: "10.255.11.1",
        vendorId: vendor.id,
      },
      select: { id: true },
    });
    const { encode } = await import("next-auth/jwt");
    const token = await encode({
      token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    // Exhaust the user's REAL today counter (limit-independent: set used to
    // the limit; the handler's own consumption then crosses it).
    const today = aiQuotaDay();
    await db.aiUsageDay.upsert({
      where: { userId_day: { userId: user.id, day: today } },
      update: { count: { set: AI_DAILY_QUOTA_DEFAULT } },
      create: { userId: user.id, day: today, count: AI_DAILY_QUOTA_DEFAULT },
    });
    const mod = await import("../../src/app/api/v1/ai/assist/route");
    const res = await mod.POST(
      new NextRequest("http://app.local/api/v1/ai/assist", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `next-auth.session-token=${token}`,
        },
        body: JSON.stringify({ scope: "device", id: device.id, question: "ping", locale: "en" }),
      })
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      error?: { code?: string };
      meta?: { used?: number; limit?: number; day?: string };
    };
    expect(body.error?.code).toBe("AI_DAILY_QUOTA_EXCEEDED");
    expect(body.meta?.used).toBe(AI_DAILY_QUOTA_DEFAULT + 1);
    expect(body.meta?.limit).toBe(AI_DAILY_QUOTA_DEFAULT);
    expect(body.meta?.day).toBe(today);
    // Restore the real-day counter so other suites/users are unaffected.
    await db.aiUsageDay.deleteMany({ where: { userId: user.id, day: today } });
  });
});
