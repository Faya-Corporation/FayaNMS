/**
 * Open-findings batch 1 — runtime pins for four deferred audit findings,
 * fixed together (branch GLM/open-findings-batch-1):
 *
 *   F-033 (A1-11, P3): GET /api/v1/worker/status shipped with NO auth check
 *     — any valid service JWT (or any anonymous caller) could read it.
 *     Now: bearer → 403 HUMAN_SESSION_REQUIRED, session-less → 401, and the
 *     route carries the requirePermission("job.read") human gate.
 *
 *   F-012 (A2-03, P2): a timed-out (orphaned) job body could post a late
 *     terminal over the RETRY attempt's state (the claim route increments
 *     attempts; the old body still knows nothing of the new epoch).
 *     Now: completion posts carry the claim epoch (`attempt`) and
 *     /worker/complete IGNORES terminals for non-current attempts.
 *
 *   F-051 (A3-15, P3): the per-device snapshot version (max+1) was a
 *     read-modify-write — two concurrent completion transactions for the
 *     same device could both compute N+1 and the @@unique([deviceId,
 *     version]) P2002 aborted the whole job. Now createSnapshot takes the
 *     device row lock (SELECT … FOR UPDATE) BEFORE reading max(version).
 *
 *   F-052 (A3-16, P3): the five SYSTEM singleton enqueues in the scheduler
 *     tick were check-then-create — two overlapping ticks could both pass
 *     the same dedupe read and double-enqueue. Now serialized by a
 *     transaction-scoped pg_try_advisory_xact_lock (login-guard
 *     convention): the loser enqueues NOTHING and reports 0s.
 *
 * Same rig as tests/flow-retention-api.test.ts /
 * tests/audit/protocol-queue-retention.test.ts: real route handlers,
 * minted Ed25519 service tokens, shared seeded demo database. The F-051
 * cases scope their writes to a throwaway device removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { createSnapshot, type TxClient } from "../../src/lib/config/create-snapshot";
import { newJobCorrelationId } from "../../src/app/api/v1/_lib/api";

const VENDOR_KEY = "batch1-test-vendor";
const HOSTNAME = "batch1-snapshot-race-device";

let deviceId = "";

beforeAll(async () => {
  const vendor = await db.vendor.upsert({
    where: { key: VENDOR_KEY },
    update: {},
    create: { key: VENDOR_KEY, name: "Batch 1 Test Vendor", adapterKey: "generic" },
  });
  const device = await db.device.upsert({
    where: { hostname: HOSTNAME },
    update: {},
    create: { hostname: HOSTNAME, mgmtIp: "192.0.2.199", vendorId: vendor.id },
  });
  deviceId = device.id;
  // Start every run from a clean chain so version assertions are exact.
  await db.configSnapshot.deleteMany({ where: { deviceId } });
});

afterAll(async () => {
  // The Device FK cascade reclaims its snapshots.
  await db.device.deleteMany({ where: { hostname: HOSTNAME } });
});

/* ── F-033 — worker/status is a human diagnostic, machine plane refused ── */

describe("F-033: GET /api/v1/worker/status auth gate", () => {
  test("anonymous (no session, no bearer) → 401 UNAUTHENTICATED envelope", async () => {
    const { GET } = await import("../../src/app/api/v1/worker/status/route");
    const res = await GET(new Request("http://localhost/api/v1/worker/status"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("valid service JWT → 403 HUMAN_SESSION_REQUIRED (explicit refusal)", async () => {
    const { GET } = await import("../../src/app/api/v1/worker/status/route");
    const token = mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:status-guard-test",
      scopes: ["jobs"],
    });
    const res = await GET(
      new Request("http://localhost/api/v1/worker/status", {
        headers: { Authorization: `Bearer ${token}` },
      })
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("HUMAN_SESSION_REQUIRED");
  });

  test("source contract: the route gates humans on job.read", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/api/v1/worker/status/route.ts", "utf8");
    expect(src).toContain('requirePermission(req, "job.read")');
    expect(src).toContain("HUMAN_SESSION_REQUIRED");
  });
});

/* ── F-012 — stale-attempt guard on POST /api/v1/worker/complete ── */

describe("F-012: /worker/complete ignores terminals for non-current attempts", () => {
  async function makeJob(overrides: Partial<{ attempts: number; maxAttempts: number; status: string }> = {}) {
    const job = await db.jobExecution.create({
      data: {
        type: "FLOW_RETENTION",
        targetType: "SYSTEM",
        status: overrides.status ?? "RUNNING",
        progress: 40,
        priority: 7,
        attempts: overrides.attempts ?? 2,
        maxAttempts: overrides.maxAttempts ?? 3,
        startedAt: new Date(),
        payloadJson: JSON.stringify({ triggeredBy: "TEST" }),
        correlationId: newJobCorrelationId(),
      },
    });
    return job;
  }

  test("SUCCEEDED from an ORPHANED attempt (1) while the retry (2) is RUNNING → ignored", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    const job = await makeJob({ attempts: 2 });
    const auth = {
      Authorization: `Bearer ${mintServiceToken({ issuer: "fayanms:worker", subject: "worker:attempt-guard-test", scopes: ["jobs"] })}`,
    };
    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          jobId: job.id,
          outcome: "SUCCEEDED",
          attempt: 1, // the pre-retry epoch — orphaned body
          result: { pruned: 0 },
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { updated?: boolean; reason?: string } };
    expect(body.data?.updated).toBe(false);
    expect(String(body.data?.reason)).toContain("stale attempt 1");

    const after = await db.jobExecution.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe("RUNNING"); // untouched — the retry still owns it
    expect(after?.resultJson).toBeNull();
    await db.jobExecution.delete({ where: { id: job.id } });
  });

  test("current-epoch terminal is still processed (no regression on the happy path)", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    const job = await makeJob({ attempts: 2, maxAttempts: 1 }); // maxAttempts=1 → terminal FAILED
    const auth = {
      Authorization: `Bearer ${mintServiceToken({ issuer: "fayanms:worker", subject: "worker:attempt-guard-test", scopes: ["jobs"] })}`,
    };
    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          jobId: job.id,
          outcome: "FAILED",
          attempt: 2, // the CURRENT epoch
          error: "deliberate test failure",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { updated?: boolean } };
    expect(body.data?.updated).toBe(true);

    const after = await db.jobExecution.findUnique({ where: { id: job.id } });
    expect(after?.status).toBe("FAILED");
    await db.jobExecution.delete({ where: { id: job.id } });
  });

  test("worker source contract: every completion post carries the claim epoch", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("mini-services/worker/runner.ts", "utf8");
    expect(src).toContain("function completePost(");
    // No completion post may bypass the helper (the only raw path string
    // left must be the helper itself + doc comments).
    const rawPosts = src.split("\n").filter((l) => l.includes('"/api/v1/worker/complete"')).length;
    expect(rawPosts).toBe(1);
  });
});

/* ── F-051 — concurrent createSnapshot txs get DISTINCT versions ── */

describe("F-051: snapshot version race serialized by the device row lock", () => {
  test("4 concurrent completion transactions → versions are a distinct 1..4 chain", async () => {
    const texts = [
      `hostname ${HOSTNAME}\ninterface eth0\n ip address 10.0.0.1/24\n`,
      `hostname ${HOSTNAME}\ninterface eth0\n ip address 10.0.0.2/24\n`,
      `hostname ${HOSTNAME}\ninterface eth0\n ip address 10.0.0.3/24\n`,
      `hostname ${HOSTNAME}\ninterface eth0\n ip address 10.0.0.4/24\n`,
    ];
    const results = await Promise.all(
      texts.map((rawText, i) =>
        db.$transaction(async (tx) =>
          createSnapshot(tx as unknown as TxClient, {
            deviceId,
            rawText,
            source: "SCHEDULED",
            correlationId: `BATCH1-RACE-${i}`,
          })
        )
      )
    );

    // Every transaction succeeded (no P2002 abort) and every version is unique.
    const versions = results.map((r) => (r.ok ? r.version : -1));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(versions).size).toBe(versions.length);

    // The stored chain is exactly those versions (1..N, no gaps, no dupes).
    const stored = await db.configSnapshot.findMany({
      where: { deviceId },
      select: { version: true },
      orderBy: { version: "asc" },
    });
    expect(stored.map((s) => s.version)).toEqual(
      [...new Set(versions)].sort((a, b) => a - b)
    );
  });
});

/* ── F-052 — overlapping ticks can no longer double-enqueue SYSTEM jobs ── */

describe("F-052: overlapping tick enqueues are advisory-locked", () => {
  test("two concurrent ticks: each SYSTEM singleton enqueues at most ONE job across both", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/tick/route");
    const auth = {
      Authorization: `Bearer ${mintServiceToken({ issuer: "fayanms:worker", subject: "worker:tick-overlap-test", scopes: ["jobs"] })}`,
    };
    const call = () =>
      POST(
        new Request("http://localhost/api/v1/worker/tick", {
          method: "POST",
          headers: { "content-type": "application/json", ...auth },
          body: JSON.stringify({}),
        })
      );

    const [r1, r2] = await Promise.all([call(), call()]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { data?: Record<string, number> };
    const b2 = (await r2.json()) as { data?: Record<string, number> };

    const singletonKeys = [
      "alertEvalEnqueued",
      "metricRetentionEnqueued",
      "rollupEnqueued",
      "flowRetentionEnqueued",
      "protocolQueueRetentionEnqueued",
    ] as const;

    for (const key of singletonKeys) {
      const total = (b1.data?.[key] ?? 0) + (b2.data?.[key] ?? 0);
      expect(total).toBeLessThanOrEqual(1);
    }
  });
});
