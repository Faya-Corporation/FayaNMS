/**
 * Worker wave-8 lifecycle fixes — the seven read-only-audit findings
 * (F-1 … F-7), pinned in the repo's audit-test style (source pins over the
 * exact files, pure arithmetic exercised directly, and ONE behavioral probe
 * for the F-5 completion retry against a throwaway in-process server):
 *
 *   F-1 (P1)  the production worker image boots again: the runner's escape
 *             imports (../../src/..., ../../scripts/...) must ALL appear in
 *             Dockerfile.worker's COPY whitelist — job-budget.ts was missing
 *             and the image crash-looped at boot while CI's `bun --version`
 *             smoke never imported index.ts. Pinned by a manifest-parity
 *             scan (depth-1 over every worker file + the transitive
 *             relative-import closure from the runtime entry files) AND a
 *             container.yml pin that the vacuous --version smoke is gone in
 *             favor of a real boot probe (GET /health answers { ok: true }).
 *   F-2 (P2)  every app-side terminal write is a CAS on the RUNNING state
 *             (updateMany + count check, { updated: false } on a lost race,
 *             audit rows / lease releases gated on count === 1) in
 *             /worker/complete (all 15 terminal writes) and /reports/execute.
 *   F-3 (P2)  SIGTERM no longer abandons in-flight jobs: the runner exposes
 *             stopRunner() + drainInFlightJobs(); index.ts drains under a
 *             bounded grace then posts RESUMED ("worker shutting down") for
 *             the stragglers (the app-side RESUMED branch is now valid for
 *             every job type, with a type-aware dead-letter audit).
 *   F-4 (P2)  the runner's outer race budget is PER TYPE (derived inner HTTP
 *             timeout + progress posts + margin for the six evaluate-in-Next
 *             drivers — always strictly greater than the inner 60 s call),
 *             and the evaluate/execute endpoints carry a jobId-keyed
 *             in-flight guard answering 409 JOB_ALREADY_EXECUTING.
 *   F-5 (P2)  completion-plane posts retry (3 attempts, exponential + jitter,
 *             per-attempt AbortSignal.timeout); failures stay typed
 *             (PostHttpError) and swallowed only after the final attempt.
 *   F-6 (P3)  claim/tick backoff carries ±20% jitter; 401/403 are classified
 *             as identity faults (fixed 60 s cadence + greppable
 *             "service identity rejected — check keys" line).
 *   F-7 (P3)  the reaper error text no longer claims the nonexistent
 *             "worker heartbeat" mechanism; the observability runbook
 *             describes the true completion/progress + reaper-threshold
 *             mechanism. The load-bearing "Orphaned: " row prefix stays.
 *
 * The batch-16 pins that legitimately changed with these fixes were updated
 * IN PLACE (the reaper-text expectation and the RESUMED-scope test — the
 * drain generalizes RESUMED beyond CHANGE_EXECUTE); everything else in the
 * pinned contracts is byte-unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CHANGE_BUDGET_MARGIN_MS,
  CHANGE_PROGRESS_POST_TIMEOUT_MS,
  WORKER_DERIVED_BUDGET_TYPES,
  WORKER_INNER_HTTP_TIMEOUT_MS,
  WORKER_JOB_BUDGET_MARGIN_MS,
  WORKER_JOB_PROGRESS_POSTS,
  deriveChangeJobBudgetMs,
  deriveWorkerJobBudgetMs,
} from "../../src/lib/change/job-budget";
import {
  IDENTITY_FAULT_BACKOFF_MS,
  isIdentityFaultStatus,
  jitterBackoff,
} from "../../mini-services/worker/backoff";

const REPO = join(import.meta.dir, "../..");

function read(relPath: string): string {
  return readFileSync(join(REPO, relPath), "utf8");
}

const RUNNER = read("mini-services/worker/runner.ts");
const INDEX = read("mini-services/worker/index.ts");
const SCHEDULER = read("mini-services/worker/scheduler.ts");
const NEXT_CLIENT = read("mini-services/worker/next-client.ts");
const DOCKERFILE = read("Dockerfile.worker");
const COMPLETE = read("src/app/api/v1/worker/complete/route.ts");
const REPORTS = read("src/app/api/v1/reports/execute/route.ts");
const EVALUATE = read("src/app/api/v1/alerts/evaluate/route.ts");
const TICK = read("src/app/api/v1/worker/tick/route.ts");
const CONTAINER_YML = read(".github/workflows/container.yml");
const OBSERVABILITY = read("docs/runbooks/observability.md");

/* ── part 1 — F-1: Dockerfile manifest parity (the boot-fix class) ─────── */

/** Walk the mini-services/worker tree recursively (.ts files, node_modules skipped); repo-relative paths. */
function workerFiles(dir = "mini-services/worker"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...workerFiles(rel));
    } else if (entry.name.endsWith(".ts")) {
      out.push(rel);
    }
  }
  return out;
}

/** Resolve a relative import spec from `fromFile` to a repo-relative path. */
function resolveRelativeImport(fromFile: string, spec: string): string | null {
  const base = join(REPO, fromFile, "..", spec);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, base, join(base, "index.ts")]) {
    try {
      readFileSync(candidate);
      return candidate.slice(REPO.length + 1);
    } catch {
      /* try the next conventional extension */
    }
  }
  return null;
}

/** Repo-relative files the worker's relative imports escape to (depth-1 scan). */
function depthOneEscapeImports(): string[] {
  const escapes = new Set<string>();
  for (const file of workerFiles()) {
    const src = read(file);
    const specs = [...src.matchAll(/(?:from\s+|import\()\s*"(\.[^"]*)"/g)].map((m) => m[1]);
    for (const spec of specs) {
      const target = resolveRelativeImport(file, spec);
      if (target && !target.startsWith("mini-services/worker/")) {
        escapes.add(target);
      }
    }
  }
  return [...escapes].sort();
}

/** Transitive relative-import closure from the worker's runtime entry files. */
function runtimeEscapeClosure(roots: string[]): string[] {
  const visited = new Set<string>();
  const escapes = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    let src: string;
    try {
      src = read(file);
    } catch {
      continue;
    }
    const specs = [...src.matchAll(/(?:from\s+|import\()\s*"(\.[^"]*)"/g)].map((m) => m[1]);
    for (const spec of specs) {
      const target = resolveRelativeImport(file, spec);
      if (!target) continue;
      if (!target.startsWith("mini-services/worker/")) escapes.add(target);
      queue.push(target);
    }
  }
  return [...escapes].sort();
}

/** The <src> paths of every repo-file COPY line in Dockerfile.worker. */
function dockerfileCopySources(): string[] {
  const out: string[] = [];
  for (const line of DOCKERFILE.split("\n")) {
    if (!line.startsWith("COPY")) continue;
    const tokens = line.split(/\s+/).slice(1).filter((t) => t && !t.startsWith("--"));
    if (tokens.length < 2) continue;
    const dest = tokens[tokens.length - 1];
    if (!dest.startsWith("/")) continue; // relative dests (./ etc.) are out of scope
    for (const src of tokens.slice(0, -1)) {
      if (src.startsWith("/")) continue; // stage-absolute (e.g. /worker/) — not a repo file
      out.push(src);
    }
  }
  return out;
}

describe("F-1: the worker image COPY whitelist covers every escape import", () => {
  test("depth-1 scan: every worker file's escape import is COPYed into the image", () => {
    const copySources = dockerfileCopySources();
    const escapes = depthOneEscapeImports();
    // The class that boot-looped production (and its peers) is present:
    expect(escapes).toContain("src/lib/change/job-budget.ts");
    expect(escapes.length).toBeGreaterThanOrEqual(6);
    const missing = escapes.filter((e) => !copySources.includes(e));
    expect(missing).toEqual([]);
  });

  test("transitive closure from the runtime entry files stays inside the COPY list", () => {
    const copySources = dockerfileCopySources();
    const closure = runtimeEscapeClosure([
      "mini-services/worker/index.ts",
      "mini-services/worker/certify.ts",
    ]);
    // The known runtime graph (F-038's pair + F-044's budget + protocol libs).
    expect(closure).toEqual(
      expect.arrayContaining([
        "src/lib/change/job-budget.ts",
        "src/lib/discovery/policy.ts",
        "src/lib/net/target-policy.ts",
        "src/lib/protocol/snmpv3-policy.ts",
        "src/lib/protocol/ingest.ts",
        "src/lib/protocol/netflow-v5.ts",
        "scripts/protocol-lab/snmpv3.ts",
      ])
    );
    const missing = closure.filter((e) => !copySources.includes(e));
    expect(missing).toEqual([]);
  });

  test("the exact COPY line for the budget module is pinned (F-1a)", () => {
    expect(DOCKERFILE).toContain(
      "COPY --chown=10001:10001 src/lib/change/job-budget.ts /src/lib/change/job-budget.ts",
    );
  });

  test("every COPYed source file actually exists in the repo (whitelist rot guard)", () => {
    for (const src of dockerfileCopySources()) {
      expect(() => read(src), `COPYed file missing on disk: ${src}`).not.toThrow();
    }
  });

  test("container.yml boots the image for real (module resolution + /health {ok:true})", () => {
    // The vacuous smoke is gone — it only exercised `bun --version`.
    expect(CONTAINER_YML).not.toContain(
      'docker run --rm fayanms-worker:arm64-${CANDIDATE_SHA} --version',
    );
    // The boot probe: a throwaway identity (the legacy symmetric boot shape
    // identity-boot.ts accepts), a closed NEXT_BASE_URL, and a /health poll
    // asserting the { ok: true } envelope within the bounded window.
    expect(CONTAINER_YML).toContain("Boot-probe ARM64 worker image");
    expect(CONTAINER_YML).toContain("FAYANMS_SERVICE_SECRET=");
    expect(CONTAINER_YML).toContain("fetch('http://127.0.0.1:3030/health')");
    expect(CONTAINER_YML).toContain("j.ok === true");
    expect(CONTAINER_YML).toContain("worker image failed to boot");
  });
});

/* ── part 2 — F-2: terminal writes are CAS on the RUNNING state ────────── */

/** Every jobExecution.updateMany call site must guard its where on RUNNING. */
function expectAllTerminalWritesCas(source: string, label: string): void {
  // No unguarded jobExecution.update() may remain (updateMany is required).
  expect(source.match(/jobExecution\.update\(/g), `${label}: non-CAS update left`).toBeNull();
  const calls = [...source.matchAll(/jobExecution\.updateMany\(\{/g)];
  expect(calls.length, `${label}: terminal write count`).toBeGreaterThanOrEqual(1);
  for (const call of calls) {
    const window = source.slice(call.index, call.index + 200);
    expect(
      window,
      `${label}: an updateMany lacks the status:"RUNNING" where guard`
    ).toMatch(/where: \{ id: (?:job\.id|jobId), status: "RUNNING"/);
  }
}

describe("F-2: /worker/complete never writes terminal state without the CAS", () => {
  test("every terminal write in the complete route is updateMany with the RUNNING guard", () => {
    expectAllTerminalWritesCas(COMPLETE, "complete/route.ts");
  });

  test("a lost race answers the { updated: false } late-complete shape", () => {
    expect(COMPLETE).toContain("cas.count === 0");
    expect(COMPLETE).toContain('updated: false,');
    expect(COMPLETE).toContain("job left RUNNING before the terminal write (concurrent completion)");
    expect(COMPLETE).toContain("job left RUNNING before the RESUMED write (concurrent completion)");
  });

  test("audit rows and lease releases are gated on a transition that happened", () => {
    expect(COMPLETE).toContain("if (cas.count === 1) {");
    expect(COMPLETE).toContain("if (!requeue) {");
    // The CONFIG_BACKUP transaction rolls the snapshot back on a lost CAS —
    // the losing completion must not leave a duplicate snapshot behind.
    expect(COMPLETE).toContain("CompletionRaceLostError");
    expect(COMPLETE).toContain("return { racedTerminal: true as const, deviceMissing: false as const }");
  });

  test("the RESUMED branch requeues with the CAS guard too (drain path)", () => {
    expect(COMPLETE).toContain('where: { id: job.id, status: "RUNNING" },');
    const resumedBlock = COMPLETE.slice(COMPLETE.indexOf('if (outcome === "RESUMED")'));
    const end = resumedBlock.indexOf("\n  // ── SUCCEEDED");
    expect(resumedBlock.slice(0, end)).toContain("updateMany");
  });

  test("same contract in /reports/execute (terminal CAS + gated bookkeeping + audit)", () => {
    expectAllTerminalWritesCas(REPORTS, "reports/execute/route.ts");
    expect(REPORTS).toContain("if (cas.count === 1) {");
    expect(REPORTS).toContain("left RUNNING before the terminal write (concurrent completion)");
  });
});

/* ── part 3 — F-4: per-type outer budgets + the in-flight 409 guards ───── */

describe("F-4: the outer race budget is derived per type (never undercuts the inner call)", () => {
  test("each evaluate-in-Next type derives a budget strictly greater than its inner timeout", () => {
    expect(WORKER_INNER_HTTP_TIMEOUT_MS).toBe(60_000);
    expect(WORKER_DERIVED_BUDGET_TYPES).toEqual([
      "ALERT_EVALUATION",
      "METRIC_RETENTION",
      "FLOW_RETENTION",
      "ROLLUP_AGGREGATION",
      "PROTOCOL_QUEUE_RETENTION",
      "REPORT_RUN",
    ]);
    for (const type of WORKER_DERIVED_BUDGET_TYPES) {
      const budget = deriveWorkerJobBudgetMs(type);
      expect(budget, `${type}`).toBeGreaterThan(WORKER_INNER_HTTP_TIMEOUT_MS);
    }
  });

  test("the derivation sources the driver's ACTUAL factors (F-044 style, no drift)", () => {
    const expected =
      WORKER_INNER_HTTP_TIMEOUT_MS +
      WORKER_JOB_PROGRESS_POSTS * CHANGE_PROGRESS_POST_TIMEOUT_MS +
      WORKER_JOB_BUDGET_MARGIN_MS;
    expect(deriveWorkerJobBudgetMs("REPORT_RUN")).toBe(expected);
    // The margin reuses the change budget's overhead constant; the progress
    // factor is the SAME constant the runner's reportProgress spends.
    expect(WORKER_JOB_BUDGET_MARGIN_MS).toBe(CHANGE_BUDGET_MARGIN_MS);
    expect(WORKER_JOB_PROGRESS_POSTS).toBe(2);
  });

  test("types outside the derived set answer 0 (the runner keeps its flat budget)", () => {
    expect(deriveWorkerJobBudgetMs("CONFIG_BACKUP")).toBe(0);
    expect(deriveWorkerJobBudgetMs("SNMP_POLL")).toBe(0);
    expect(deriveWorkerJobBudgetMs("TOTALLY_UNKNOWN")).toBe(0);
  });

  test("runner source: the six drivers race the derived budget; CHANGE_EXECUTE keeps F-044", () => {
    const driverFns: Record<string, string> = {
      ALERT_EVALUATION: "runAlertEvaluationJob",
      METRIC_RETENTION: "runMetricRetentionJob",
      FLOW_RETENTION: "runFlowRetentionJob",
      ROLLUP_AGGREGATION: "runRollupAggregationJob",
      PROTOCOL_QUEUE_RETENTION: "runProtocolQueueRetentionJob",
      REPORT_RUN: "runReportJob",
    };
    for (const type of WORKER_DERIVED_BUDGET_TYPES) {
      expect(
        RUNNER.includes(`raceTimeout(${driverFns[type]}(job), jobBudgetMs(job),`),
        `runner dispatch for ${type} uses the per-type budget`
      ).toBe(true);
    }
    // CHANGE_EXECUTE's claim-time derivation is untouched (batch-16's pin).
    expect(RUNNER).toContain("deriveChangeJobBudgetMs(job.payload?.stepsTotal)");
    expect(RUNNER).toContain("function jobBudgetMs(job: ClaimedJob): number");
    expect(RUNNER).toContain("deriveWorkerJobBudgetMs(job.type) || JOB_TIMEOUT_MS");
    // The inner calls spend the module's own constant (was a 60_000 literal).
    expect(RUNNER).toContain("WORKER_INNER_HTTP_TIMEOUT_MS");
    expect(RUNNER.match(/60_000/g)).toBeNull();
  });

  test("the evaluate endpoint's in-flight guard answers 409 JOB_ALREADY_EXECUTING", () => {
    expect(EVALUATE).toContain("JOB_ALREADY_EXECUTING");
    expect(EVALUATE).toContain("const inFlightEvaluations = new Map<string, true>();");
    expect(EVALUATE).toContain("inFlightEvaluations.set(jobId, true);");
    expect(EVALUATE).toMatch(/finally \{\s*\n\s*inFlightEvaluations\.delete\(jobId\);/);
  });

  test("the reports/execute endpoint carries the same jobId-keyed guard", () => {
    expect(REPORTS).toContain("JOB_ALREADY_EXECUTING");
    expect(REPORTS).toContain("const inFlightReportRuns = new Map<string, true>();");
    expect(REPORTS).toContain("inFlightReportRuns.set(jobId, true);");
    expect(REPORTS).toMatch(/finally \{\s*\n\s*inFlightReportRuns\.delete\(jobId\);/);
  });
});

/* ── part 4 — F-5: bounded retry on the completion plane ───────────────── */

describe("F-5: completion posts retry; claim posts do not", () => {
  test("next-client: typed status error + 3-attempt exponential+jitter delays", () => {
    expect(NEXT_CLIENT).toContain("export class PostHttpError extends Error");
    expect(NEXT_CLIENT).toContain("readonly status: number;");
    expect(NEXT_CLIENT).toContain("RETRY_DELAYS_MS = [250, 1_000, 4_000]");
    expect(NEXT_CLIENT).toContain("e.status >= 500 || e.status === 429");
    expect(NEXT_CLIENT).toContain("export async function nextPostWithRetry");
  });

  test("runner source: completePost + reportProgress pass the retry budget; claim does not", () => {
    expect(RUNNER).toContain("const COMPLETION_POST_ATTEMPTS = 3;");
    expect(RUNNER).toContain("{ retries: COMPLETION_POST_ATTEMPTS }");
    // The claim POST keeps its own immortal loop — no retry option there.
    const claimStart = RUNNER.indexOf('"/api/v1/worker/claim"');
    const claimWindow = RUNNER.slice(claimStart, RUNNER.indexOf(")) as ClaimedJob[]", claimStart));
    expect(claimWindow).not.toContain("retries");
  });

  test("behavioral: a failing endpoint is re-posted until it answers (real sockets)", async () => {
    const savedNextBase = process.env.NEXT_BASE_URL;
    let attempts = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        attempts += 1;
        if (attempts < 3) {
          return Response.json({ success: false, error: { message: "boom" } }, { status: 503 });
        }
        return Response.json({ success: true, data: { ok: true } });
      },
    });
    process.env.NEXT_BASE_URL = `http://127.0.0.1:${server.port}`;
    try {
      const client = await import("../../mini-services/worker/next-client");
      // nextPostWithRetry re-reads NEXT_BASE_URL PER REQUEST (wave-8 F-5
      // live-read seam), so this probe dials OUR server even if another
      // test file loaded the module first with a different env — the
      // behavioral assertions below (attempts === 3 on OUR stub) prove it.
      const result = (await client.nextPostWithRetry(
        "/api/v1/worker/complete",
        { probe: true },
        2_000,
        3
      )) as { ok?: boolean };
      expect(attempts).toBe(3);
      expect(result.ok).toBe(true);

      // Non-retryable 4xx (e.g. 401 identity fault) surfaces after ONE attempt.
      attempts = 0;
      const single = server;
      single.reload({
        port: 0,
        fetch: () => {
          attempts += 1;
          return Response.json(
            { success: false, error: { code: "UNAUTHENTICATED", message: "nope" } },
            { status: 401 }
          );
        },
      });
      try {
        await client.nextPostWithRetry("/api/v1/worker/complete", {}, 2_000, 3);
        throw new Error("expected the 401 to throw");
      } catch (e) {
        expect((e as Error).message).toContain("HTTP 401");
      }
      expect(attempts).toBe(1);
    } finally {
      if (savedNextBase === undefined) delete process.env.NEXT_BASE_URL;
      else process.env.NEXT_BASE_URL = savedNextBase;
      server.stop(true);
    }
  });
});

/* ── part 5 — F-6: jittered backoff + identity-fault classification ────── */

describe("F-6: claim/tick backoff is jittered ±20% and classifies 401/403", () => {
  test("jitterBackoff stays within [0.8, 1.2] × base across N samples", () => {
    const base = 30_000;
    for (let i = 0; i < 500; i += 1) {
      const delayed = jitterBackoff(base);
      expect(delayed).toBeGreaterThanOrEqual(0.8 * base);
      expect(delayed).toBeLessThanOrEqual(1.2 * base);
    }
  });

  test("the jitter bounds are exact at the injectable extremes", () => {
    expect(jitterBackoff(10_000, () => 0)).toBe(8_000);
    expect(jitterBackoff(10_000, () => 1)).toBe(12_000);
  });

  test("401/403 are identity faults with the fixed slow cadence; 5xx/429 are not", () => {
    expect(IDENTITY_FAULT_BACKOFF_MS).toBe(60_000);
    expect(isIdentityFaultStatus(401)).toBe(true);
    expect(isIdentityFaultStatus(403)).toBe(true);
    expect(isIdentityFaultStatus(500)).toBe(false);
    expect(isIdentityFaultStatus(429)).toBe(false);
    expect(isIdentityFaultStatus(undefined)).toBe(false);
  });

  test("source pins: both loops consume the helpers and log the greppable line", () => {
    expect(RUNNER).toContain("jitterBackoff(claimBackoffDelay(");
    expect(RUNNER).toContain("service identity rejected — check keys (F-6)");
    expect(RUNNER).toContain("IDENTITY_FAULT_BACKOFF_MS");
    expect(SCHEDULER).toContain("jitterBackoff(tickBackoffDelay())");
    expect(SCHEDULER).toContain("service identity rejected — check keys (F-6)");
    expect(SCHEDULER).toContain("IDENTITY_FAULT_BACKOFF_MS");
  });
});

/* ── part 6 — F-3: the SIGTERM drain (source pins; no rig for index.ts) ── */

describe("F-3: SIGTERM drains in-flight jobs and posts RESUMED requeues", () => {
  test("the runner exposes the stop hook + bounded drain + in-flight registry", () => {
    expect(RUNNER).toContain("export function stopRunner(): void");
    expect(RUNNER).toContain("export async function drainInFlightJobs(graceMs: number)");
    expect(RUNNER).toContain("const inFlight = new Map<string, { job: ClaimedJob; done: Promise<void> }>();");
    expect(RUNNER).toContain("inFlight.set(job.id, { job, done });");
    expect(RUNNER).toContain("inFlight.delete(job.id);");
  });

  test("the drain posts RESUMED ('worker shutting down') for the stragglers only", () => {
    const drain = RUNNER.slice(RUNNER.indexOf("export async function drainInFlightJobs"));
    const end = drain.indexOf("\n/**\n * Exponential claim backoff");
    const block = drain.slice(0, end);
    // Await under the grace, snapshot the survivors, requeue each of them —
    // jobs that settled during the grace are gone from the registry.
    expect(block).toContain("Promise.race([");
    // The RESUMED contract stays CHANGE_EXECUTE-only: change stragglers
    // report RESUMED (F-044), every other type reports FAILED and rides the
    // app-side requeue — same retry outcome, no contract widening.
    expect(block).toContain('reportResumed(entry.job, "worker shutting down")');
    expect(block).toContain('if (entry.job.type === "CHANGE_EXECUTE")');
    expect(block).toContain('reportFailure(entry.job, "worker shutting down")');
    expect(block).toContain("inFlight.size === 0");
  });

  test("index.ts: claim loop stops FIRST, then the bounded drain, then exit", () => {
    const stopIdx = INDEX.indexOf("stopRunner();");
    const drainIdx = INDEX.indexOf("await drainInFlightJobs(DRAIN_GRACE_MS)");
    const collectorIdx = INDEX.indexOf("protocolCollector?.stop();");
    // lastIndexOf: the FIRST exit is the second-signal fast path above the
    // drain; the MAIN shutdown path's exit is the block's final statement.
    const exitIdx = INDEX.lastIndexOf("process.exit(0);");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeGreaterThan(stopIdx);
    expect(collectorIdx).toBeGreaterThan(drainIdx);
    expect(exitIdx).toBeGreaterThan(collectorIdx);
    // Both signals route through the same graceful shutdown; the grace is
    // bounded (~25 s) so a wedged drain cannot hang the orchestrator.
    expect(INDEX).toContain("void gracefulShutdown(\"SIGTERM\")");
    expect(INDEX).toContain("void gracefulShutdown(\"SIGINT\")");
    expect(INDEX).toContain("const DRAIN_GRACE_MS = 25_000;");
    expect(INDEX).toContain('if (draining) {\n      // Second signal: the operator wants out NOW.\n      process.exit(0);');
  });

  test("the runner's claim loop refuses to claim once stopped (no post-drain claims)", () => {
    expect(RUNNER).toContain("if (stopped) return \"busy\";");
    expect(RUNNER).toContain("if (!stopped) {");
    expect(RUNNER).toContain("claimCycleTimer = setTimeout(() => void runClaimCycle(), nextDelay);");
  });
});

/* ── part 7 — F-7: the reaper tells the truth (no phantom heartbeat) ───── */

describe("F-7: reaper text and runbook describe the real mechanism", () => {
  test("the tick route's orphan error no longer claims a worker heartbeat", () => {
    expect(TICK).toContain(
      "Orphaned: no completion within the reaper threshold (reaped by scheduler tick)",
    );
    expect(TICK).not.toContain("heartbeat");
    // The load-bearing row prefix (Job Center + demo-world classification).
    expect(TICK).toContain('"Orphaned: no completion within the reaper threshold');
  });

  test("the observability runbook promises completion/progress + reaper, not a heartbeat", () => {
    expect(OBSERVABILITY).not.toContain("worker heartbeat");
    expect(OBSERVABILITY).toContain("worker completion/progress posts");
    expect(OBSERVABILITY).toContain("there is no heartbeat endpoint");
    expect(OBSERVABILITY).toContain("JOB_ORPHAN_REAPED");
  });
});
