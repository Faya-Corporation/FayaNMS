/**
 * Wave 6 — post-register audit fixes (three-agent parallel audit of the
 * batch-fix planes that never rode a module audit).
 *
 * Audit results fixed here (see docs/review/STATE.md, wave-6 entry):
 *
 *   P1 (6-c)  — the F-046 20 000 sample cap was FLEET-WIDE on the single
 *               aggregate load: whenever 20 000 < fleet rows but the recent
 *               window alone fit, the previous window arrived partially
 *               truncated and window averages were biased (proven false
 *               RESOLVE and MISSED FIRE by the audit probe). The load is
 *               now a per-series window function — pinned live below.
 *   P3 (6-a)  — stepsTotal never reached the STORED change-job payload, so
 *               the tick reaper's per-job threshold was dead code (always
 *               the ~71 min legacy fallback); the budget did not cover the
 *               4 appended rollback/observe step calls; reportProgress
 *               hardcoded the 8 000 ms progress-post factor; POST
 *               /jobs/[id]/retry had no terminal-status guard (a clone of
 *               a RUNNING job bypassed the SAFE-003 single-flight lease).
 *   P3 (6-b)  — network-lab.md still described the pre-F-036
 *               hostname-first attribution; the SNMPv3 secret cache could
 *               re-insert a resolved value one in-flight window past stop().
 *   P3 (6-c)  — the AI-quota 503 fail-closed branch had no behavioral pin
 *               (pinned in batch-11 now); the AiUsageDay comment equated a
 *               slot with an LLM round-trip (the enforced unit is one
 *               request; /ai/query may start two round-trips internally).
 *
 * Same certified rig as the other audit suites: real database, real minted
 * session tokens, no mock.module.
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

import { db } from "../../src/lib/db";
import {
  CHANGE_ROLLBACK_STEP_PAD,
  deriveChangeJobBudgetMs,
} from "../../src/lib/change/job-budget";
import {
  CANCELLABLE_JOB_STATUSES,
  RETRYABLE_JOB_STATUSES,
} from "../../src/lib/jobs/lifecycle";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import { MAX_SAMPLES_PER_QUERY } from "../../src/lib/alerts/evaluate";

/* ── 1. P1: the per-series sample cap (F-046, wave-6 correction) ──────── */

describe("wave-6 P1: the F-046 sample cap is PER-SERIES, not fleet-wide", () => {
  /**
   * Live-DB proof of the window-function semantics the engine now uses:
   * series A carries MAX_SAMPLES_PER_QUERY + 1 rows, series B carries 5 —
   * the OLD fleet-wide take kept the newest 20 000 rows GLOBALLY, which is
   * series A's newest rows and would have dropped ALL of series B; the
   * per-series cap keeps A's newest 20 000 AND all 5 of B's rows.
   */
  test("live DB: the cap keeps the newest rows of EVERY series — a small sibling series survives a capped one", async () => {
    const matrixEntry = ROLE_MATRIX.find((role) => role.name === "admin");
    if (!matrixEntry) throw new Error("role admin missing from ROLE_MATRIX");
    const vendor = await db.vendor.upsert({
      where: { key: "wave6" },
      update: {},
      create: { key: "wave6", name: "Wave6 Vendor", adapterKey: "wave6" },
      select: { id: true },
    });
    const device = await db.device.upsert({
      where: { hostname: "wave6-cap-device" },
      update: { vendorId: vendor.id },
      create: {
        hostname: "wave6-cap-device",
        mgmtIp: "10.255.61.1",
        vendorId: vendor.id,
      },
      select: { id: true },
    });

    const baseTs = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));
    // Series A: cap + 1 rows of CPU (1-second cadence). Series B: 5 rows of
    // MEMORY, all OLDER than every A row — the discriminating arrangement.
    const seriesA = Array.from({ length: MAX_SAMPLES_PER_QUERY + 1 }, (_, i) => ({
      deviceId: device.id,
      metric: "CPU",
      value: i,
      ts: new Date(baseTs.getTime() + i * 1_000),
    }));
    const seriesB = Array.from({ length: 5 }, (_, i) => ({
      deviceId: device.id,
      metric: "MEMORY",
      value: 40 + i,
      ts: new Date(baseTs.getTime() - (10_000 + (4 - i) * 1_000)), // older than A
    }));
    for (const batch of [seriesA.slice(0, 10_000), seriesA.slice(10_000), seriesB]) {
      await db.metricSample.createMany({ data: batch });
    }

    try {
      // The EXACT window-function shape the engine's load uses (evaluate.ts,
      // source-pinned in batch-17) — per-series rn <= cap, global ts DESC.
      const rows = await db.$queryRaw<
        Array<{ deviceId: string; metric: string; value: number; ts: Date }>
      >(
        Prisma.sql`
          SELECT ranked."deviceId", ranked."metric", ranked."value", ranked."ts"
          FROM (
            SELECT s."deviceId", s."metric", s."value", s."ts",
                   row_number() OVER (
                     PARTITION BY s."deviceId", s."metric"
                     ORDER BY s."ts" DESC
                   ) AS rn
            FROM "MetricSample" s
            WHERE s."deviceId" IN (${device.id})
              AND s."metric" IN ('CPU', 'MEMORY')
              AND s."ts" >= ${new Date(baseTs.getTime() - 60_000)}
          ) ranked
          WHERE ranked.rn <= ${MAX_SAMPLES_PER_QUERY}
          ORDER BY ranked."ts" DESC
        `
      );

      const cpu = rows.filter((r) => r.metric === "CPU");
      const memory = rows.filter((r) => r.metric === "MEMORY");
      // Series A: capped to the newest MAX rows (the single oldest row dropped).
      expect(cpu).toHaveLength(MAX_SAMPLES_PER_QUERY);
      const cpuValues = cpu.map((r) => r.value);
      expect(Math.min(...cpuValues)).toBe(1); // row 0 (oldest) dropped
      expect(Math.max(...cpuValues)).toBe(MAX_SAMPLES_PER_QUERY); // newest kept
      // Series B: ALL 5 rows survive — the old fleet-wide take would have
      // dropped every one of them (they are older than all 20 001 A rows).
      expect(memory).toHaveLength(5);
      expect(memory.map((r) => r.value).sort((a, b) => a - b)).toEqual([40, 41, 42, 43, 44]);
      // Global ts DESC order preserved (indexSamples' ascending-restore contract).
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i - 1]!.ts.getTime()).toBeGreaterThanOrEqual(rows[i]!.ts.getTime());
      }
    } finally {
      await db.metricSample.deleteMany({ where: { deviceId: device.id } });
      await db.device.delete({ where: { id: device.id } }).catch(() => undefined);
      await db.vendor.delete({ where: { id: vendor.id } }).catch(() => undefined);
    }
  }, 60_000);

  test("budget pad property: the derived budget covers stepsTotal + 4 appended step calls", () => {
    // The engine appends 3 rollback steps + the closing observe call, so a
    // healthy attempt can legally make stepsTotal + 4 step calls (bounded
    // by the driver's 40-call loop). The budget must over-cover that.
    expect(CHANGE_ROLLBACK_STEP_PAD).toBe(4);
    for (const stepsTotal of [1, 3, 5, 10, 30, 36, 40, 41, 200]) {
      const effective = Math.min(
        Math.min(stepsTotal, 40) + CHANGE_ROLLBACK_STEP_PAD,
        40
      );
      expect(deriveChangeJobBudgetMs(stepsTotal)).toBe(
        effective * 98_600 + 30_000
      );
      // Never smaller than the unpadded plan cost (the pre-wave-6 floor):
      expect(deriveChangeJobBudgetMs(stepsTotal)).toBeGreaterThanOrEqual(
        Math.min(stepsTotal, 40) * 98_600 + 30_000
      );
    }
    // The fallback (absent/legacy payload) still derives the full loop bound:
    expect(deriveChangeJobBudgetMs(undefined)).toBe(40 * 98_600 + 30_000);
  });
});

/* ── 2. P3: the change-job wave-6 fixes ────────────────────────────────── */

describe("wave-6 6-a: change-job fixes", () => {
  test("source pin: the ENQUEUE payload carries stepsTotal (the reaper's per-job threshold engages)", () => {
    // The reaper reads the STORED payloadJson (changeReaperThresholdForPayload)
    // — before this fix no writer ever put stepsTotal there, so every real
    // CHANGE_EXECUTE row took the ~71-minute legacy fallback and the
    // batch-16 reaper pin's fixture was the only stepsTotal-bearing payload
    // in the system.
    const src = readFileSync("src/app/api/v1/changes/[id]/execute/route.ts", "utf8");
    expect(src).toContain("stepsTotal: change._count.steps === 0 ? 5 : change._count.steps");
  });

  test("source pin: reportProgress spends the budget module's OWN progress-post factor", () => {
    // The derivation's progress-post factor and the loop's actual spend
    // cannot drift apart — the runner now imports the same constant.
    const src = readFileSync("mini-services/worker/runner.ts", "utf8");
    expect(src).toContain("CHANGE_PROGRESS_POST_TIMEOUT_MS,");
    const start = src.indexOf("async function reportProgress");
    const end = src.indexOf("\n}", start); // the function's closing brace
    const block = src.slice(start, end);
    expect(block).toContain("CHANGE_PROGRESS_POST_TIMEOUT_MS");
    expect(block).not.toContain("8_000");
  });

  test("source pin: the retryable/cancellable status sets are single-sourced", () => {
    expect([...RETRYABLE_JOB_STATUSES].sort()).toEqual(["DEAD", "FAILED"]);
    expect([...CANCELLABLE_JOB_STATUSES].sort()).toEqual(["QUEUED", "RUNNING"]);
    const routeSrc = readFileSync("src/app/api/v1/jobs/[id]/retry/route.ts", "utf8");
    expect(routeSrc).toContain('from "@/lib/jobs/lifecycle"');
    expect(routeSrc).toContain("RETRYABLE_JOB_STATUSES.has(source.status)");
    expect(routeSrc).toContain('"JOB_NOT_RETRYABLE"');
    const uiSrc = readFileSync("src/components/shell/job-center.tsx", "utf8");
    expect(uiSrc).toContain('from "@/lib/jobs/lifecycle"');
    // The hand-copied sets are gone from both planes:
    expect(uiSrc).not.toContain('new Set(["FAILED", "DEAD"])');
  });

  test("LIVE HANDLER PIN: POST /jobs/[id]/retry refuses a QUEUED job with 409 JOB_NOT_RETRYABLE (SAFE-003 lease bypass closed)", async () => {
    const user = await ensureWave6Admin();
    const job = await db.jobExecution.create({
      data: {
        type: "VALIDATION",
        targetType: "DEVICE",
        targetId: null,
        status: "QUEUED",
        attempts: 0,
        maxAttempts: 3,
        payloadJson: "{}",
        correlationId: "JOB-wave6-queued",
      },
    });
    try {
      const mod = await import("../../src/app/api/v1/jobs/[id]/retry/route");
      const res = await mod.POST(
        await wave6RetryRequest(user, job.id),
        { params: Promise.resolve({ id: job.id }) }
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe("JOB_NOT_RETRYABLE");
      // Nothing cloned:
      const clones = await db.jobExecution.findMany({
        where: { payloadJson: { contains: job.id } },
      });
      expect(clones).toHaveLength(0);
    } finally {
      await db.jobExecution.delete({ where: { id: job.id } }).catch(() => undefined);
    }
  });

  test("LIVE HANDLER PIN: POST /jobs/[id]/retry still clones a terminal DEAD job (the documented recovery)", async () => {
    const user = await ensureWave6Admin();
    const job = await db.jobExecution.create({
      data: {
        type: "VALIDATION",
        targetType: "DEVICE",
        targetId: null,
        status: "DEAD",
        attempts: 3,
        maxAttempts: 3,
        error: "Orphaned: worker lost mid-run",
        payloadJson: JSON.stringify({ wave6: true }),
        correlationId: "JOB-wave6-dead",
      },
    });
    try {
      const mod = await import("../../src/app/api/v1/jobs/[id]/retry/route");
      const res = await mod.POST(
        await wave6RetryRequest(user, job.id),
        { params: Promise.resolve({ id: job.id }) }
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        data?: { job?: { id: string; status?: string } };
      };
      expect(body.data?.job?.status).toBe("QUEUED");
      const clone = await db.jobExecution.findUnique({ where: { id: body.data!.job!.id } });
      expect(clone).not.toBeNull();
      expect(clone!.attempts).toBe(0);
      expect(JSON.parse(clone!.payloadJson ?? "{}").retryOf).toBe(job.id);
      await db.jobExecution.delete({ where: { id: clone!.id } });
    } finally {
      await db.jobExecution.delete({ where: { id: job.id } }).catch(() => undefined);
    }
  });
});

/* ── 3. P3: the protocol-plane wave-6 fixes ───────────────────────────── */

describe("wave-6 6-b: protocol-plane fixes", () => {
  test("source pin: the SNMPv3 secret cache cannot re-insert past a reset (stop() generation guard)", () => {
    const src = readFileSync("mini-services/worker/protocol-collector.ts", "utf8");
    expect(src).toContain("let snmpV3SecretCacheGeneration = 0;");
    // reset() bumps the generation FIRST:
    const resetStart = src.indexOf("export function resetSnmpV3SecretCache");
    const resetBlock = src.slice(resetStart, src.indexOf("}", resetStart) + 1);
    expect(resetBlock).toContain("snmpV3SecretCacheGeneration += 1;");
    // A resolution that started before the reset skips its insert when it
    // settles after it (the resolved VALUE cannot outlive the collector):
    const resolveStart = src.indexOf("const generationAtStart = snmpV3SecretCacheGeneration;");
    expect(resolveStart).toBeGreaterThan(-1);
    const insertBlock = src.slice(resolveStart, src.indexOf("return resolution;", resolveStart));
    expect(insertBlock).toContain("if (generationAtStart === snmpV3SecretCacheGeneration) {");
    expect(insertBlock).toContain("snmpV3SecretCache.set(key,");
  });

  test("source pin: the runbooks carry the corrected F-036 attribution + the governed-class hatch", () => {
    const lab = readFileSync("docs/runbooks/network-lab.md", "utf8");
    expect(lab).toContain("anchored on the UDP source IP (F-036)");
    // The retired pre-F-036 ordering claim is gone:
    expect(lab).not.toContain("exact hostname hint first, exact management IP second");
    const discovery = readFileSync("docs/runbooks/network-discovery.md", "utf8");
    expect(discovery).toContain("Governed target classes");
    expect(discovery).toContain("FAYANMS_PROBE_ALLOW_SPECIAL=true");
  });
});

/* ── 4. P3: the schema-honesty fix ─────────────────────────────────────── */

describe("wave-6 6-c: AiUsageDay slot-unit comment", () => {
  test("source pin: the schema states the enforced unit is REQUESTS, not LLM round-trips", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    expect(schema).toContain("the enforced unit is requests, not round-trips");
    expect(schema).not.toContain("LLM round-trips\n// the 4 /api/v1/ai routes would have started");
  });
});

/* ── self-contained identity (the certified rt012/rt014 pattern) ──────── */

type Wave6User = { id: string; email: string; name: string | null; role: string };
let wave6User: Wave6User | null = null;

async function ensureWave6Admin(): Promise<Wave6User> {
  if (wave6User) return wave6User;
  const matrixEntry = ROLE_MATRIX.find((role) => role.name === "admin");
  if (!matrixEntry) throw new Error("role admin missing from ROLE_MATRIX");
  await db.role.upsert({
    where: { name: "admin" },
    update: {},
    create: {
      name: "admin",
      description: matrixEntry.description,
      permissionsJson: JSON.stringify([...matrixEntry.permissions]),
    },
  });
  const email = "wave6-audit@faya.local";
  wave6User = await db.user.upsert({
    where: { email },
    update: { isActive: true },
    create: { email, name: "Wave6 Audit", role: "admin", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });
  return wave6User;
}

/** A real minted-session POST request for the retry route (admin carries job.run). */
async function wave6RetryRequest(user: Wave6User, jobId: string): Promise<NextRequest> {
  const { encode } = await import("next-auth/jwt");
  const token = await encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
  return new NextRequest(`http://app.local/api/v1/jobs/${jobId}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `next-auth.session-token=${token}` },
  });
}
