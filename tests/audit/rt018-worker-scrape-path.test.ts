import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-018 / F-023 — monitoring/prometheus.yml worker scrape path.
 *
 * BEFORE: the `fayanms-worker` job scraped `metrics_path: /metrics` from
 * worker:3030, but the worker serves ONLY `GET /api/metrics` (plus
 * `/health`) — the target 404s forever, violating the observability
 * runbook's own rule ("a Prometheus target returning no metrics is a
 * finding") and leaving every worker metric dark.
 *
 * Pinned here (config ↔ route consistency):
 *   1. the worker job scrapes /api/metrics from worker:3030;
 *   2. the /api/metrics route actually exists on the worker;
 *   3. both scrape jobs use the same /api/metrics contract;
 *   4. the prometheus self-job keeps the default path (no override).
 */

const REPO_ROOT = join(import.meta.dir, "../..");
const prometheusYml = readFileSync(join(REPO_ROOT, "monitoring/prometheus.yml"), "utf8");
const workerIndex = readFileSync(join(REPO_ROOT, "mini-services/worker/index.ts"), "utf8");

function jobBlock(jobName: string): string {
  const start = prometheusYml.indexOf(`  - job_name: ${jobName}`);
  expect(start).toBeGreaterThan(-1);
  const rest = prometheusYml.slice(start);
  const nextJob = rest.slice(1).search(/\n  - job_name:|\n  # - job_name:/);
  return nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
}

describe("RT-018: worker scrape path matches the worker route", () => {
  test("fayanms-worker job scrapes /api/metrics from worker:3030", () => {
    const block = jobBlock("fayanms-worker");
    expect(block).toContain('metrics_path: /api/metrics');
    expect(block).not.toMatch(/metrics_path:\s*\/metrics\s*$/m);
    expect(block).toContain('targets: ["worker:3030"]');
  });

  test("the scraped path exists on the worker (source pin)", () => {
    expect(workerIndex).toContain('url.pathname === "/api/metrics"');
    // And there is no /metrics alias route (one owner, one path).
    expect(workerIndex).not.toContain('url.pathname === "/metrics"');
  });

  test("both scrape jobs use the same /api/metrics contract", () => {
    expect(jobBlock("fayanms-app")).toContain("metrics_path: /api/metrics");
    expect(jobBlock("fayanms-worker")).toContain("metrics_path: /api/metrics");
  });

  test("prometheus self-job keeps the default path (no metrics_path override)", () => {
    const block = jobBlock("prometheus");
    expect(block).not.toContain("metrics_path:");
    expect(block).toContain('targets: ["prometheus:9090"]');
  });
});
