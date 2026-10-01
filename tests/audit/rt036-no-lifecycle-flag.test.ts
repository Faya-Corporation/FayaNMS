import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-036 (F-066) — the Prometheus container must not expose the lifecycle
 * admin API.
 *
 * The finding: `deploy/oci/compose.monitoring.yml` ran prometheus with
 * `--web.enable-lifecycle` on the internal network with NO basic auth —
 * unauthenticated `/-/reload` and `/-/quit` were reachable from the
 * backend/monitoring networks (a compromised app/worker container could
 * shut Prometheus down at will). The flag was bring-up convenience with no
 * compensating control; the alternative (keep flag + --web.config.file
 * basic auth) was rejected — no credential infrastructure exists on that
 * network.
 *
 * Landed here: the flag is gone; config reloads are a container restart
 * (`docker compose restart prometheus`) — the TSDB persists in the
 * prometheus-data named volume, which is exactly why that mount must
 * survive. No operational doc referenced the lifecycle endpoints (the only
 * hits were the audit record itself under docs/review/, which is
 * point-in-time history and is never rewritten), so no doc wording changed.
 *
 * Pinned here (config police, style of tests/audit/monitoring-compose.test.ts):
 *   1. lifecycle flag absent — the prometheus command carries exactly
 *      --config.file and --storage.tsdb.path;
 *   2. no doc references remain in docs/ (minus the docs/review audit
 *      record), deploy/, monitoring/;
 *   3. TSDB volume + storage flag preserved (restart-based reload relies
 *      on it);
 *   4. monitoring profile otherwise unchanged (images, mounts, networks).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const COMPOSE = readFileSync(path.join(REPO_ROOT, "deploy/oci/compose.monitoring.yml"), "utf8");
const COMPOSE_LINES = COMPOSE.split("\n");

function serviceBlock(service: string): string {
  const start = COMPOSE_LINES.indexOf(`  ${service}:`);
  expect(start).toBeGreaterThan(-1);
  let end = COMPOSE_LINES.length;
  for (let i = start + 1; i < COMPOSE_LINES.length; i++) {
    if (/^  [A-Za-z0-9_-]+:$/.test(COMPOSE_LINES[i])) {
      end = i;
      break;
    }
  }
  return COMPOSE_LINES.slice(start, end).join("\n");
}

/** The service block without comment lines (code = what compose executes). */
function serviceCode(service: string): string[] {
  return serviceBlock(service)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"));
}

/** Walk a directory tree collecting file paths (skips unreadables). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("RT-036: prometheus lifecycle flag removed", () => {
  test("lifecycle flag absent — command is exactly config.file + storage.tsdb.path", () => {
    const code = serviceCode("prometheus");
    const codeText = code.join("\n");
    expect(codeText).not.toContain("--web.enable-lifecycle");
    // No lifecycle/authz-related web flags snuck back in.
    expect(codeText).not.toMatch(/--web\.enable-/);
    expect(codeText).not.toMatch(/--web\.config\.file/);
    // The executed command list is EXACTLY the two legitimate flags.
    const flags = code.filter((line) => line.trim().startsWith("- --")).map((l) => l.trim());
    expect(flags).toEqual([
      "- --config.file=/etc/prometheus/prometheus.yml",
      "- --storage.tsdb.path=/prometheus",
    ]);
    // The compensating ops note documents the restart-based reload.
    expect(serviceBlock("prometheus")).toContain("docker compose restart prometheus");
  });

  test("no doc references to the lifecycle endpoints remain", () => {
    // Scope: operational docs and deploy/monitoring config. The audit
    // record (docs/review/) is point-in-time history — it KEEPS its
    // mentions of /-/reload (truth-first applies forward, not
    // retroactively).
    const scanRoots = [
      "deploy",
      "monitoring",
      "docs/adr",
      "docs/runbooks",
      "docs/deploy",
      "docs/ci",
      "docs/security",
      "docs/certification",
      "docs/implementation",
    ].map((p) => path.join(REPO_ROOT, p));
    const offenders: string[] = [];
    for (const root of scanRoots) {
      for (const file of walk(root)) {
        if (!/\.(yml|yaml|md|sh|ts|txt)$/.test(file)) continue;
        const text = readFileSync(file, "utf8");
        // Comment lines are exempt within deploy/monitoring configs: the
        // RT-036 ops note names the flag it removed. The ENDPOINT strings
        // themselves must not appear at all outside the audit record.
        const codeLines = text.split("\n").filter((l) => !l.trimStart().startsWith("#"));
        const code = codeLines.join("\n");
        if (code.includes("/-/reload") || code.includes("/-/quit") || code.includes("--web.enable-lifecycle")) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }
    expect(
      offenders,
      `lifecycle endpoints referenced outside the audit record: ${offenders.join(", ")}`
    ).toEqual([]);
  });

  test("TSDB volume preserved (restart-based reload relies on it)", () => {
    const prometheus = serviceBlock("prometheus");
    expect(prometheus).toContain("prometheus-data:/prometheus");
    // The named volume is declared at the top level.
    expect(COMPOSE).toMatch(/^  prometheus-data:\s*$/m);
  });

  test("monitoring profile otherwise unchanged (images, mounts, networks)", () => {
    // Image pins unchanged (monitoring-compose pins the exact digests; this
    // guards the structure this RT touched).
    const prometheus = serviceBlock("prometheus");
    expect(prometheus).toContain("prom/prometheus:v3.5.0@sha256:");
    expect(prometheus).toContain("./monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro");
    expect(prometheus).toContain("- backend");
    expect(prometheus).toContain("- monitoring");
    expect(prometheus).toContain('expose:\n      - "9090"');
    // Hardening keys untouched: the ONLY diff of this RT is the removed
    // flag + its comment.
    const codeText = serviceCode("prometheus").join("\n");
    for (const key of ["security_opt:", "cap_drop:", "read_only:", "tmpfs:", "pids_limit:", "mem_limit:"]) {
      expect(codeText).toContain(key);
    }
    expect(codeText).toContain("no-new-privileges:true");
  });
});
