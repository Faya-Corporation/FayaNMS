/**
 * Open-findings batch 16 — F-044 (A2-12, P3): change driver budget
 * arithmetic — the 40 × 90 s step loop raced a static 600 s worker budget.
 *
 *   History: the worker's CHANGE_EXECUTE driver looped
 *   /api/v1/worker/change-step up to 40 times, each call budgeted at 90 s
 *   (+ a 300–600 ms inter-step beat), while raceTimeout capped the WHOLE
 *   job at a hardcoded CHANGE_JOB_TIMEOUT_MS = 600_000. A slow-but-healthy
 *   plan (or a chatty LIVE_SSH device) could therefore outrun its own
 *   race: the worker reported the job FAILED and requeued it while the
 *   app-side engine kept executing steps. Device double-apply was never
 *   the risk (SAFE-004 CAS step claims + SAFE-005 DeviceWriteLocks), but
 *   the JOB's label lied and attempts burned on healthy runs.
 *
 *   The closure (the BACKLOG plan verbatim):
 *     1. The budget is DERIVED AT CLAIM TIME from the plan's own size —
 *        src/lib/change/job-budget.ts:
 *          budget = min(stepsTotal, loop bound) × (stepTimeout 90 s +
 *                   progress post 8 s + max inter-step sleep 600 ms) + margin
 *        The claim route enriches the CHANGE_EXECUTE payload with
 *        stepsTotal (the change's step count); the driver derives at claim
 *        time; a legacy/absent value falls back to the FULL loop bound
 *        (fail-safe generosity — the budget may over-cover, never race).
 *     2. In-flight DRIVER loss is RESUMABLE, not failed: a budget
 *        exhaustion (typed JobTimeoutError) is reported as outcome RESUMED
 *        — the complete route requeues the job with a "resumed" error
 *        label, progress PRESERVED and the execution lease intact
 *        (SAFE-003: a requeued retry is the same execution). Attempts stay
 *        bounded by maxAttempts; repeated driver loss past the cap
 *        dead-letters honestly (change rows untouched — recovery via
 *        jobs/[id]/retry, where the engine's orphan-step reaper owns the
 *        rollback-or-fail decision).
 *     3. The tick reaper's CHANGE_EXECUTE threshold is derived PER JOB
 *        from the SAME math (+ grace) instead of a hardcoded 15-minute
 *        ceiling that assumed the retired 10-minute budget.
 *
 *   Re-entry safety is NOT re-implemented — it is pinned: the engine's
 *   SAFE-004 CAS step claims (atomic updateMany + rowcount check), the
 *   5-minute orphan-step reap, and the next-PENDING-step pick are the
 *   mechanisms that make a resumed attempt safe; tests/audit/
 *   change-engine-invariants.test.ts must stay green beside this suite.
 *
 *   Rig notes: real route handlers (claim/complete/tick) with an
 *   in-process minted Ed25519 service identity — the worktree .env keypair
 *   is a MISMATCHED pair (mint parses, verify fails), so the ambient env
 *   is swapped for a generated one in beforeAll and restored in afterAll
 *   (the service-jwt caches are keyed on the raw env value, so the swap
 *   invalidates them). Live rows are throwaway (unique change numbers,
 *   correlationIds) and removed in afterAll. The claim-route pin refuses
 *   to run when OTHER QUEUED CHANGE_EXECUTE rows exist in the shared dev
 *   database (claiming the oldest would flip someone else's job RUNNING)
 *   and falls back to the wiring source pins instead — deterministic over
 *   operator data. Run with `env -u DATABASE_URL` (bogus shell export).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";

import {
  CHANGE_BUDGET_MARGIN_MS,
  CHANGE_INTER_STEP_SLEEP_MAX_MS,
  CHANGE_MAX_STEP_CALLS,
  CHANGE_PROGRESS_POST_TIMEOUT_MS,
  CHANGE_REAPER_GRACE_MS,
  CHANGE_STEP_CALL_TIMEOUT_MS,
  JobTimeoutError,
  MIN_CHANGE_REAPER_THRESHOLD_MS,
  changeReaperThresholdForPayload,
  deriveChangeJobBudgetMs,
  deriveChangeReaperThresholdMs,
} from "../../src/lib/change/job-budget";
import {
  DeviceWriteLockedError,
  StepClaimLostError,
  isStepClaimWon,
} from "../../src/lib/change/execution-guard";
import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { newJobCorrelationId } from "../../src/app/api/v1/_lib/api";

/* ── the derivation constants, pinned to the finding's own arithmetic ───── */

const PER_ITERATION_MS =
  CHANGE_STEP_CALL_TIMEOUT_MS + CHANGE_PROGRESS_POST_TIMEOUT_MS + CHANGE_INTER_STEP_SLEEP_MAX_MS;

/* ── in-process service identity (mint + verify agree; ambient restored) ── */

const SERVICE_ENV_KEYS = [
  "FAYANMS_SERVICE_PRIVATE_KEY",
  "FAYANMS_SERVICE_PUBLIC_KEYS",
  "FAYANMS_SERVICE_SECRET",
  "FAYANMS_SERVICE_SECRETS",
] as const;

const savedServiceEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of SERVICE_ENV_KEYS) savedServiceEnv[key] = process.env[key];
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const pkcs8Pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  process.env.FAYANMS_SERVICE_PUBLIC_KEYS = spki;
  process.env.FAYANMS_SERVICE_PRIVATE_KEY = pkcs8Pem;
  delete process.env.FAYANMS_SERVICE_SECRET;
  delete process.env.FAYANMS_SERVICE_SECRETS;
});

afterAll(async () => {
  for (const key of SERVICE_ENV_KEYS) {
    if (savedServiceEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedServiceEnv[key];
  }
  await cleanup();
});

/* ── throwaway live rows ─────────────────────────────────────────────────── */

const CHANGE_NUMBER_PREFIX = "CHG-2099-B16";
const createdChangeIds: string[] = [];
const createdJobIds: string[] = [];

async function cleanup(): Promise<void> {
  if (createdChangeIds.length > 0) {
    // ChangeStep + ChangeExecutionLease + ChangeDevice cascade with the change.
    await db.changeRequest.deleteMany({ where: { id: { in: createdChangeIds } } });
  }
  if (createdJobIds.length > 0) {
    await db.jobExecution.deleteMany({ where: { id: { in: createdJobIds } } });
  }
}

let changeCounter = 0;

/** A throwaway change with `stepCount` steps + a RUNNING CHANGE_EXECUTE job. */
async function makeChangeJob(options: {
  stepCount: number;
  status?: string;
  progress?: number;
  attempts?: number;
  maxAttempts?: number;
  startedAt?: Date | null;
  payloadExtras?: Record<string, unknown>;
  withLease?: boolean;
}): Promise<{ changeId: string; jobId: string }> {
  changeCounter += 1;
  const number = `${CHANGE_NUMBER_PREFIX}-${String(changeCounter).padStart(5, "0")}-${Math.floor(
    Math.random() * 1_000_000
  )}`;
  // requesterId is a required relation — point it at ANY seeded user
  // (read-only reference; the change is deleted in afterAll and the
  // user row is never touched).
  const requester = await db.user.findFirst({ select: { id: true } });
  if (!requester) throw new Error("no seeded user found for the throwaway change requester");
  const change = await db.changeRequest.create({
    data: {
      number,
      title: `F-044 pin change ${changeCounter}`,
      status: "EXECUTING",
      riskLevel: "LOW",
      operationKind: "GENERIC",
      requesterId: requester.id,
    },
  });
  createdChangeIds.push(change.id);
  await db.changeStep.createMany({
    data: Array.from({ length: options.stepCount }, (_, index) => ({
      changeId: change.id,
      order: index + 1,
      name: `Step ${index + 1}`,
      type: "APPLY",
      status: "PENDING",
    })),
  });
  const job = await db.jobExecution.create({
    data: {
      type: "CHANGE_EXECUTE",
      targetType: "CHANGE",
      targetId: change.id,
      status: options.status ?? "RUNNING",
      progress: options.progress ?? 40,
      priority: 3,
      attempts: options.attempts ?? 1,
      maxAttempts: options.maxAttempts ?? 3,
      startedAt: options.startedAt ?? new Date(),
      payloadJson: JSON.stringify({
        changeNumber: number,
        stepsTotal: options.stepCount,
        ...options.payloadExtras,
      }),
      correlationId: newJobCorrelationId(),
    },
  });
  createdJobIds.push(job.id);
  if (options.withLease ?? true) {
    await db.changeExecutionLease.create({
      data: {
        changeId: change.id,
        jobId: job.id,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
      },
    });
  }
  return { changeId: change.id, jobId: job.id };
}

function serviceAuthHeader(): Record<string, string> {
  const token = mintServiceToken({
    issuer: "fayanms:worker",
    subject: "worker:batch16-f044-pins",
    scopes: ["jobs"],
  });
  return { "content-type": "application/json", Authorization: `Bearer ${token}` };
}

/* ── 1. the claim-time budget derivation (the finding's named math) ─────── */

describe("deriveChangeJobBudgetMs (F-044 claim-time math)", () => {
  test("budget = iterations × (stepTimeout + progress post + max sleep) + margin", () => {
    expect(CHANGE_STEP_CALL_TIMEOUT_MS).toBe(90_000);
    expect(CHANGE_PROGRESS_POST_TIMEOUT_MS).toBe(8_000);
    expect(CHANGE_INTER_STEP_SLEEP_MAX_MS).toBe(600);
    expect(CHANGE_MAX_STEP_CALLS).toBe(40);
    expect(PER_ITERATION_MS).toBe(98_600);

    // Exact arithmetic for a 1-step plan, the seeded 5-step plans, and the
    // 40-call loop bound:
    expect(deriveChangeJobBudgetMs(1)).toBe(98_600 + CHANGE_BUDGET_MARGIN_MS);
    expect(deriveChangeJobBudgetMs(5)).toBe(5 * 98_600 + CHANGE_BUDGET_MARGIN_MS);
    expect(deriveChangeJobBudgetMs(40)).toBe(40 * 98_600 + CHANGE_BUDGET_MARGIN_MS);
    expect(CHANGE_BUDGET_MARGIN_MS).toBe(30_000);
  });

  test("the old 600 s race is gone: a 40 × 90 s job fits its derived budget", () => {
    // The finding's exact scenario — 40 step calls at 90 s (+ sleeps) could
    // never fit the static 600_000 budget. The derivation covers the whole
    // worst-case loop for EVERY plan size 1..40:
    for (let stepsTotal = 1; stepsTotal <= CHANGE_MAX_STEP_CALLS; stepsTotal += 1) {
      const budget = deriveChangeJobBudgetMs(stepsTotal);
      // Every step call at its full HTTP budget, every inter-step beat at
      // its upper bound, plus the fixed margin:
      expect(budget).toBeGreaterThanOrEqual(stepsTotal * (90_000 + 600) + 30_000);
    }
    // …and the full 40 × 90 s loop no longer races a 600 s ceiling:
    expect(deriveChangeJobBudgetMs(40)).toBeGreaterThan(600_000);
    expect(deriveChangeJobBudgetMs(40)).toBe(3_974_000);
  });

  test("monotonic in stepsTotal, clamped to the driver's loop bound", () => {
    let previous = 0;
    for (let stepsTotal = 1; stepsTotal <= CHANGE_MAX_STEP_CALLS; stepsTotal += 1) {
      const budget = deriveChangeJobBudgetMs(stepsTotal);
      expect(budget).toBeGreaterThan(previous);
      previous = budget;
    }
    // A 200-step plan cannot make the loop exceed its 40-call bound — the
    // budget stops growing exactly there (the loop throws its honest
    // "did not finish within 40 step iterations" exhaustion instead).
    expect(deriveChangeJobBudgetMs(200)).toBe(deriveChangeJobBudgetMs(40));
    expect(deriveChangeJobBudgetMs(41)).toBe(deriveChangeJobBudgetMs(40));
  });

  test("legacy/absent/malformed stepsTotal falls back to the FULL loop bound (never a premature race)", () => {
    const fullBound = deriveChangeJobBudgetMs(CHANGE_MAX_STEP_CALLS);
    for (const bad of [undefined, null, 0, -3, 1.5, Number.NaN, "5", {}]) {
      expect(deriveChangeJobBudgetMs(bad as unknown as number)).toBe(fullBound);
    }
    // The fallback is the LARGEST possible budget — an un-enriched payload
    // is covered, not raced.
    expect(fullBound).toBe(3_974_000);
  });

  test("reaper thresholds: derived budget + grace, parsed per payload, with a monotonic floor", () => {
    expect(CHANGE_REAPER_GRACE_MS).toBe(300_000);
    expect(deriveChangeReaperThresholdMs(5)).toBe(deriveChangeJobBudgetMs(5) + CHANGE_REAPER_GRACE_MS);
    // The reaper NEVER races a live driver: threshold > budget, always.
    for (let stepsTotal = 1; stepsTotal <= CHANGE_MAX_STEP_CALLS; stepsTotal += 1) {
      expect(deriveChangeReaperThresholdMs(stepsTotal)).toBeGreaterThan(
        deriveChangeJobBudgetMs(stepsTotal)
      );
    }
    expect(MIN_CHANGE_REAPER_THRESHOLD_MS).toBe(deriveChangeReaperThresholdMs(1));

    // Per-payload parsing (the stored JobExecution row's payloadJson):
    expect(changeReaperThresholdForPayload(JSON.stringify({ stepsTotal: 5 }))).toBe(
      deriveChangeReaperThresholdMs(5)
    );
    // Malformed JSON / absent field → full-loop-bound fallback (generous):
    expect(changeReaperThresholdForPayload("not json{")).toBe(
      deriveChangeReaperThresholdMs(undefined)
    );
    expect(changeReaperThresholdForPayload(JSON.stringify({ changeNumber: "CHG-X" }))).toBe(
      deriveChangeReaperThresholdMs(undefined)
    );
    expect(changeReaperThresholdForPayload(null)).toBe(deriveChangeReaperThresholdMs(undefined));
    // An array payload is not an object — ignored, same fallback:
    expect(changeReaperThresholdForPayload(JSON.stringify([{ stepsTotal: 1 }]))).toBe(
      deriveChangeReaperThresholdMs(undefined)
    );
  });
});

/* ── 2. driver-loss classification: resumed, not FAILED ─────────────────── */

describe("JobTimeoutError + driver wiring (F-044 resumed semantics)", () => {
  test("the typed timeout keeps the historical message shape and carries the budget", () => {
    const err = new JobTimeoutError("job abc", 523_000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("JobTimeoutError");
    expect(err.message).toBe("job abc timed out after 523000 ms");
    expect(err.label).toBe("job abc");
    expect(err.budgetMs).toBe(523_000);
  });

  test("runner source: a CHANGE_EXECUTE budget exhaustion is classified as driver loss and reported RESUMED", () => {
    const src = readFileSync("mini-services/worker/runner.ts", "utf8");
    // The classification is on the TYPED error, only for the change driver:
    expect(src).toContain(
      'const isDriverLoss = job.type === "CHANGE_EXECUTE" && e instanceof JobTimeoutError;'
    );
    expect(src).toContain("await reportResumed(job, message);");
    // The resume report posts the RESUMED outcome (never FAILED) and does
    // NOT bump the failed counter:
    expect(src).toContain('outcome: "RESUMED"');
    expect(src).toContain("counters.resumed += 1;");
    const resumedBody = src.slice(src.indexOf("async function reportResumed"));
    expect(resumedBody).not.toContain("counters.failed");
    // Every other job type (and every non-timeout error) keeps the generic
    // failure path:
    expect(src).toContain("await reportFailure(job, message);");
  });

  test("runner source: the budget is derived at claim time from the enriched payload; the static race is gone", () => {
    const src = readFileSync("mini-services/worker/runner.ts", "utf8");
    // Claim-time derivation from the claim route's stepsTotal enrichment:
    expect(src).toContain("deriveChangeJobBudgetMs(job.payload?.stepsTotal)");
    // The loop bound + per-step HTTP budget + sleep bounds come from the
    // budget module (the math and the loop cannot drift apart):
    expect(src).toContain('from "../../src/lib/change/job-budget"');
    expect(src).toContain("CHANGE_MAX_STEP_CALLS; iteration += 1");
    expect(src).toContain("CHANGE_STEP_CALL_TIMEOUT_MS\n    )) as ChangeStepResponse");
    expect(src).toContain(
      "randInt(CHANGE_INTER_STEP_SLEEP_MIN_MS, CHANGE_INTER_STEP_SLEEP_MAX_MS)"
    );
    // The static constant and its inline per-step literal are gone:
    expect(src).not.toContain("CHANGE_JOB_TIMEOUT_MS");
    expect(src).not.toContain("90_000");
  });
});

/* ── 3. the claim route enriches CHANGE_EXECUTE with stepsTotal (live) ──── */

describe("claim-time enrichment (POST /api/v1/worker/claim)", () => {
  test("a claimed CHANGE_EXECUTE job carries the plan's stepsTotal budget input", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/claim/route");

    // SAFETY: the claim route flips the OLDEST QUEUED job of the requested
    // type — if the shared dev DB holds OTHER queued change jobs (operator
    // data), refuse to run live and pin the wiring by source instead.
    const otherQueued = await db.jobExecution.count({
      where: { type: "CHANGE_EXECUTE", status: "QUEUED" },
    });

    if (otherQueued === 0) {
      // The live worker polls every 3 s; if it steals the row between
      // create and claim (ms window), retry with a fresh job. After two
      // unlucky tries, fall back to the source pin — never flake.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { changeId, jobId } = await makeChangeJob({ stepCount: 5, status: "QUEUED" });
        const res = await POST(
          new Request("http://localhost/api/v1/worker/claim", {
            method: "POST",
            headers: serviceAuthHeader(),
            body: JSON.stringify({ types: ["CHANGE_EXECUTE"], limit: 1 }),
          })
        );
        if (res.status !== 200) {
          throw new Error(`claim route answered ${res.status}`);
        }
        const body = (await res.json()) as {
          data?: Array<Record<string, unknown>>;
        };
        const claimed = (body.data ?? []).find((job) => job.id === jobId);
        if (claimed) {
          const payload = claimed.payload as Record<string, unknown>;
          expect(payload.stepsTotal).toBe(5);
          // The worker's exact derivation over the CLAIMED payload covers
          // the plan's worst case:
          const budget = deriveChangeJobBudgetMs(payload.stepsTotal);
          expect(budget).toBeGreaterThanOrEqual(5 * (90_000 + 600) + 30_000);
          expect(budget).toBe(deriveChangeJobBudgetMs(5));
          // Claim-side bookkeeping: the flip + attempt increment happened.
          // The LIVE dev worker may also have claimed/failed/requeued this
          // throwaway row between create and claim (it polls every 3 s and
          // legitimately races this pin) — the claim-time ENRICHMENT is
          // what this test pins, not the pre-existing flip bookkeeping:
          expect((claimed.attempts as number)).toBeGreaterThanOrEqual(1);
          const row = await db.jobExecution.findUnique({ where: { id: jobId } });
          expect(row?.status).toBe("RUNNING");
          expect(row?.attempts).toBeGreaterThanOrEqual(1);
          return;
        }
        // Stolen by the live worker (or lost the flip): clean up and retry.
        await db.jobExecution.delete({ where: { id: jobId } }).catch(() => {});
        await db.changeRequest.delete({ where: { id: changeId } }).catch(() => {});
      }
    }

    // Deterministic fallback: the wiring source pins (the enrichment code
    // the live path above would have exercised).
    const src = readFileSync("src/app/api/v1/worker/claim/route.ts", "utf8");
    expect(src).toContain('tx.changeStep.count({\n          where: { changeId: job.targetId },');
    expect(src).toContain("stepsTotal,\n          };");
    expect(src).toContain("F-044 — claim-time budget input");
  });
});

/* ── 4. the complete route's RESUMED branch (live DB) ───────────────────── */

describe("POST /api/v1/worker/complete — RESUMED (driver loss is resumable)", () => {
  test("a resumed job is REQUEUED with the resumed label, progress preserved, lease intact, no failure audit", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    const { changeId, jobId } = await makeChangeJob({ stepCount: 5, progress: 40, attempts: 1 });
    const auditsBefore = await db.auditEvent.count({
      where: { action: "CHANGE_EXECUTION_FAILED", resourceId: changeId },
    });

    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: serviceAuthHeader(),
        body: JSON.stringify({
          jobId,
          outcome: "RESUMED",
          attempt: 1,
          error: "job " + jobId + " timed out after 523000 ms",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    expect(body.data?.updated).toBe(true);
    expect(body.data?.status).toBe("QUEUED");
    expect(body.data?.resumed).toBe(true); // NOT a FAILED terminal

    const row = await db.jobExecution.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe("QUEUED"); // resumable — the status is NOT FAILED
    expect(row?.error ?? "").toContain("resumed (attempt 1):");
    expect(row?.error ?? "").toContain("timed out after 523000 ms");
    expect(row?.progress).toBe(40); // PRESERVED — the run resumes where it left off
    expect(row?.finishedAt).toBeNull(); // not terminal
    expect(row?.resultJson).toBeNull();
    // Same backoff family as the generic requeue (30 s × attempts):
    expect(row?.scheduledAt).not.toBeNull();
    expect(row!.scheduledAt!.getTime()).toBeGreaterThan(Date.now() + 20_000);

    // SAFE-003 — a requeued resume is the SAME execution: the lease STAYS.
    const lease = await db.changeExecutionLease.findUnique({ where: { changeId } });
    expect(lease?.jobId).toBe(jobId);

    // No CHANGE_EXECUTION_FAILED audit for a resume (retries stay visible
    // via attempts/scheduledAt + the resumed error label):
    const auditsAfter = await db.auditEvent.count({
      where: { action: "CHANGE_EXECUTION_FAILED", resourceId: changeId },
    });
    expect(auditsAfter).toBe(auditsBefore);
  });

  test("repeated driver loss past maxAttempts dead-letters honestly — lease released, resumed audit, change rows untouched", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    const { changeId, jobId } = await makeChangeJob({ stepCount: 3, attempts: 3, maxAttempts: 3 });

    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: serviceAuthHeader(),
        body: JSON.stringify({
          jobId,
          outcome: "RESUMED",
          attempt: 3,
          error: "job " + jobId + " timed out after 128600 ms",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    expect(body.data?.status).toBe("FAILED");
    expect(body.data?.resumed).toBe(false);

    const row = await db.jobExecution.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe("FAILED");
    expect(row?.error ?? "").toContain("resumed 3× then dead-lettered");
    expect(row?.error ?? "").toContain("recover via job retry");
    expect(row?.finishedAt).not.toBeNull();

    // Terminal → the execution lease is released (SAFE-003 mirror of the
    // FAILED path), so the operator's retry/re-execute path is open.
    const lease = await db.changeExecutionLease.findUnique({ where: { changeId } });
    expect(lease).toBeNull();

    // The terminal IS audited — with the resumed truth (resumed: true),
    // never a plain device-failure lie.
    const audit = await db.auditEvent.findFirst({
      where: { action: "CHANGE_EXECUTION_FAILED", resourceId: changeId },
    });
    expect(audit).not.toBeNull();
    const after = JSON.parse(audit!.afterJson ?? "{}") as Record<string, unknown>;
    expect(after.resumed).toBe(true);
    expect(String(after.error)).toContain("resumed 3× then dead-lettered");
  });

  test("RESUMED is CHANGE_EXECUTE-only — any other job type is refused 400", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    const job = await db.jobExecution.create({
      data: {
        type: "FLOW_RETENTION",
        targetType: "SYSTEM",
        status: "RUNNING",
        progress: 10,
        priority: 7,
        attempts: 1,
        maxAttempts: 3,
        startedAt: new Date(),
        payloadJson: JSON.stringify({ triggeredBy: "TEST" }),
        correlationId: newJobCorrelationId(),
      },
    });
    createdJobIds.push(job.id);

    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: serviceAuthHeader(),
        body: JSON.stringify({ jobId: job.id, outcome: "RESUMED", attempt: 1, error: "nope" }),
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("INVALID_OUTCOME");

    const row = await db.jobExecution.findUnique({ where: { id: job.id } });
    expect(row?.status).toBe("RUNNING"); // untouched
  });

  test("a RESUMED post from an ORPHANED epoch is ignored (F-012 stale-attempt guard interplay)", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    // attempts = 2: the current body's epoch is 2; a RESUMED from epoch 1
    // (the body whose budget fired BEFORE the requeue+re-claim) must never
    // write.
    const { changeId, jobId } = await makeChangeJob({ stepCount: 2, attempts: 2 });

    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: serviceAuthHeader(),
        body: JSON.stringify({
          jobId,
          outcome: "RESUMED",
          attempt: 1, // stale epoch
          error: "late resume from the orphaned body",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    expect(body.data?.updated).toBe(false);
    expect(String(body.data?.reason)).toContain("stale attempt 1");

    const row = await db.jobExecution.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe("RUNNING"); // untouched — the replacement owns it
    expect(row?.error).toBeNull();
    expect(await db.changeExecutionLease.findUnique({ where: { changeId } })).not.toBeNull();
  });

  test("a RESUMED post for a non-RUNNING job is acknowledged, never written (late duplicate)", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    const { changeId, jobId } = await makeChangeJob({ stepCount: 2, status: "QUEUED" });

    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: serviceAuthHeader(),
        body: JSON.stringify({ jobId, outcome: "RESUMED", attempt: 1, error: "duplicate" }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    expect(body.data?.updated).toBe(false);
    expect(String(body.data?.reason)).toContain("job status is QUEUED");

    const row = await db.jobExecution.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe("QUEUED");
    expect(row?.error).toBeNull();
    expect(await db.changeExecutionLease.findUnique({ where: { changeId } })).not.toBeNull();
  });

  test("no regression: the generic FAILED path for CHANGE_EXECUTE keeps its requeue semantics (RESUMED is the special case)", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/complete/route");
    const { changeId, jobId } = await makeChangeJob({ stepCount: 2, progress: 66, attempts: 1 });

    const res = await POST(
      new Request("http://localhost/api/v1/worker/complete", {
        method: "POST",
        headers: serviceAuthHeader(),
        body: JSON.stringify({
          jobId,
          outcome: "FAILED",
          attempt: 1,
          error: "Step 2 (Apply changes) failed",
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: Record<string, unknown> };
    expect(body.data?.status).toBe("QUEUED"); // attempts 1 < max 3 → requeue
    expect(body.data?.resumed).toBeUndefined(); // the plain FAILED shape

    const row = await db.jobExecution.findUnique({ where: { id: jobId } });
    expect(row?.status).toBe("QUEUED");
    expect(row?.error).toBe("Step 2 (Apply changes) failed"); // NO resumed prefix
    expect(row?.progress).toBe(0); // generic requeue resets progress
    // Lease stays (same SAFE-003 same-execution retry contract):
    expect(await db.changeExecutionLease.findUnique({ where: { changeId } })).not.toBeNull();
  });
});

/* ── 5. the tick reaper aligns with the derived budget (live + source) ──── */

describe("scheduler tick reaper (per-job derived thresholds)", () => {
  test("a 1-step orphan is reaped while a 40-step orphan of the same age is NOT (no 15-minute ceiling)", async () => {
    const { POST } = await import("../../src/app/api/v1/worker/tick/route");
    // Both started 8.5 min ago: above the 1-step threshold (~7.1 min =
    // budget 128.6 s + 5 min grace), far below the 40-step one (~71 min).
    const staleStart = new Date(Date.now() - 8.5 * 60_000);
    const small = await makeChangeJob({
      stepCount: 1,
      startedAt: staleStart,
      withLease: false,
    });
    const large = await makeChangeJob({
      stepCount: 40,
      startedAt: staleStart,
      withLease: false,
    });

    const res = await POST(
      new Request("http://localhost/api/v1/worker/tick", {
        method: "POST",
        headers: serviceAuthHeader(),
        body: JSON.stringify({}),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data?: { reapedOrphans?: number } };
    expect(body.data?.reapedOrphans ?? 0).toBeGreaterThanOrEqual(1);

    const smallRow = await db.jobExecution.findUnique({ where: { id: small.jobId } });
    const largeRow = await db.jobExecution.findUnique({ where: { id: large.jobId } });
    // The truth-telling reap for a driver that is provably gone keeps its
    // documented shape:
    expect(smallRow?.status).toBe("FAILED");
    expect(smallRow?.error ?? "").toContain("Orphaned: no worker heartbeat");
    // The long-plan job is INSIDE its own derived budget — a live driver:
    expect(largeRow?.status).toBe("RUNNING");
    expect(largeRow?.finishedAt).toBeNull();
  });

  test("reaper source: the per-job derivation replaced the hardcoded 15-minute ceiling", () => {
    const src = readFileSync("src/app/api/v1/worker/tick/route.ts", "utf8");
    expect(src).toContain('from "@/lib/change/job-budget"');
    expect(src).toContain("MIN_CHANGE_REAPER_THRESHOLD_MS");
    expect(src).toContain("changeReaperThresholdForPayload(job.payloadJson)");
    expect(src).not.toContain("STALE_CHANGE_MS");
    // The worker budget and the reaper threshold come from the SAME module:
    const budgetSrc = readFileSync("src/lib/change/job-budget.ts", "utf8");
    expect(budgetSrc).toContain("deriveChangeReaperThresholdMs");
    expect(budgetSrc).toContain("CHANGE_REAPER_GRACE_MS");
  });
});

/* ── 6. re-entry safety: the CAS step-claim invariants are untouched ────── */

describe("re-entry safety (CAS step claims — no regression)", () => {
  test("the SAFE-004 claim semantics a resumed attempt relies on are unchanged", () => {
    // A won CAS claim is EXACTLY one row; anything else is a lost claim:
    expect(isStepClaimWon(1)).toBe(true);
    expect(isStepClaimWon(0)).toBe(false);
    expect(isStepClaimWon(2)).toBe(false);
    // Lost claims answer 409 STEP_IN_FLIGHT (the driver's requeue-resumable
    // set); device lock conflicts answer 409 DEVICE_WRITE_LOCKED:
    const stepClaimLost = new StepClaimLostError(2, "Apply changes");
    const deviceLocked = new DeviceWriteLockedError();
    expect(stepClaimLost.code).toBe("STEP_IN_FLIGHT");
    expect(stepClaimLost.httpStatus).toBe(409);
    expect(deviceLocked.code).toBe("DEVICE_WRITE_LOCKED");
    expect(deviceLocked.httpStatus).toBe(409);
  });

  test("change-step engine source: the CAS claim, next-PENDING pick and orphan reap a resumed attempt re-enters through are untouched", () => {
    const src = readFileSync("src/app/api/v1/worker/change-step/route.ts", "utf8");
    // The atomic step claim (conditional updateMany + rowcount check):
    expect(src).toContain("isStepClaimWon(claimed.count)");
    expect(src).toContain('status: "PENDING"');
    // The replacement driver's re-entry point — the next PENDING step:
    expect(src).toContain('change.steps.find((step) => step.status === "PENDING")');
    // The orphan-step reaper still owns the rollback-or-fail decision for
    // an app-side death (a DIFFERENT failure class from driver loss):
    expect(src).toContain("ORPHAN_THRESHOLD_MS = 5 * 60 * 1000");
    expect(src).toContain("Orphaned step reaped — rollback engaged");
    // The NOT_RUNNING guard keeps rejecting step calls for a requeued
    // (QUEUED) job — the orphaned body's late calls cannot double-execute:
    expect(src).toContain("`change-step requires a RUNNING job");
  });

  test("documentation: the budget module carries the derivation and the resumable semantics", () => {
    const budgetSrc = readFileSync("src/lib/change/job-budget.ts", "utf8");
    expect(budgetSrc).toContain("F-044");
    expect(budgetSrc).toContain("(stepTimeout + progressPost + maxSleep) + margin");
    expect(budgetSrc).toContain("min(stepsTotal, CHANGE_MAX_STEP_CALLS)");
    const runnerSrc = readFileSync("mini-services/worker/runner.ts", "utf8");
    expect(runnerSrc).toContain("RESUMED");
    const claimSrc = readFileSync("src/app/api/v1/worker/claim/route.ts", "utf8");
    expect(claimSrc).toContain("claim-time budget input");
  });
});
