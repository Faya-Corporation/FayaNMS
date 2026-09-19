/**
 * R70 — merge-to-main execution + first REAL CI gate execution + DB-bootstrap fix.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md):
 *   - The operator instructed a direct merge of z_ai_v2 → main; executed as a
 *     pure fast-forward 27e0eea..6538d46 (39 commits, 213 files, +16,377−1,990),
 *     linear history preserved, all four refs identical post-push.
 *   - Dispatch probe #4 (204) created run 35414649589 @ main/6538d46 — the FIRST
 *     real gate execution after the CI-001 infra-blocked era (every earlier run
 *     died 0-step on runner capacity). The gate ran deep (deps/lint/tsc ✅) and
 *     failed at Tests with `The table public.User does not exist` — the suite
 *     ran BEFORE the migration history was replayed onto the fresh CI service
 *     container. Latent ordering defect masked for months by (a) the long-lived
 *     pre-migrated sandbox database and (b) the runner block that never let a
 *     real run reach the step.
 *   - Fix: `prisma migrate deploy` moved ABOVE Tests (idempotent, T7 provisioning
 *     path); the duplicate post-Tests step retired; stale "runner-blocked"
 *     governance comments corrected; proven on a byte-fresh replica database
 *     (fayanms_gatecheck → migrate deploy → suite 997/18/0).
 *   - gov-verify on merged main re-classified honestly: exit 2 GOV-PLAN-BLOCKER
 *     (GitHub Free plan gate on branch protection/rulesets) — GOV-001 remains
 *     plan-gated regardless of the merge.
 *
 * These pins freeze the ordering, the single-bootstrap invariant, the four-job
 * shape, and the audit record. They NEVER execute the workflow or the network.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const readRepoFile = (p: string): string =>
  readFileSync(join(REPO, p), "utf8");

const CI = readRepoFile(".github/workflows/ci.yml");
const DOC = readRepoFile(
  "docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md",
);

describe("R70-A: migration history replays BEFORE the test step (run 35414649589 fix)", () => {
  test("the migrate-deploy step precedes the Tests step in the gate job", () => {
    const migrate = CI.indexOf("Migration history applies to a fresh PostgreSQL (service container)");
    const tests = CI.indexOf("name: Tests (role matrix, authorization contract, service auth, crypto, audit chain)");
    expect(migrate).toBeGreaterThan(-1);
    expect(tests).toBeGreaterThan(-1);
    expect(migrate).toBeLessThan(tests);
  });

  test("the migrate-deploy run command sits between setup-bun deps and Tests (same job block)", () => {
    const anchor = CI.indexOf("      - name: Migration history applies to a fresh PostgreSQL (service container)");
    const after = CI.slice(anchor, anchor + 400);
    expect(after).toContain("run: bunx prisma migrate deploy");
    expect(CI.indexOf("name: Tests (role matrix", anchor)).toBeGreaterThan(anchor);
  });
});

describe("R70-B: single-source bootstrap — exactly one migrate deploy in the workflow", () => {
  test("exactly one `bunx prisma migrate deploy` occurrence in ci.yml", () => {
    const occurrences = CI.split("run: bunx prisma migrate deploy").length - 1;
    expect(occurrences).toBe(1);
  });

  test("the retired post-Tests position carries the R70 pointer comment", () => {
    expect(CI).toContain("R70 moved the\n      # migrate-deploy step ABOVE \"Tests\"");
  });
});

describe("R70-C: the four-job CI shape is untouched by the bootstrap fix (r66/r69 preserved)", () => {
  test("ci.yml still defines exactly gate/e2e/browser/scan as bare job ids", () => {
    const body = CI.slice(CI.indexOf("\njobs:"));
    const jobIds = [...body.matchAll(/^  ([a-z0-9-]+):\s*$/gm)].map((m) => m[1]);
    expect(jobIds).toEqual(["gate", "e2e", "browser", "scan"]);
  });

  test("no `name:` override on any job (check name must equal job id)", () => {
    const body = CI.slice(CI.indexOf("\njobs:"));
    for (const id of ["gate", "e2e", "browser", "scan"]) {
      const at = body.indexOf(`  ${id}:`);
      expect(body.slice(at, at + 200)).not.toMatch(new RegExp(`^  ${id}:\\s*\\n\\s+name:`, "m"));
    }
  });

  test("R47 four-check header marker and workflow_dispatch trigger intact", () => {
    expect(CI).toContain("# required-checks: gate, scan, e2e, browser");
    expect(CI).toContain("workflow_dispatch:");
  });
});

describe("R70-D: stale CI-001 runner-block claims retired from ci.yml comments", () => {
  test("no 'infrastructure-blocked — no runner assigned' claim remains", () => {
    expect(CI).not.toContain("no runner assigned");
  });
  test("no 'runner-blocked (CI-001)' claim remains in the browser job comment", () => {
    expect(CI).not.toContain("runner-blocked (CI-001)");
  });
  test("the header records the R70 truth (first real gate execution)", () => {
    expect(CI).toContain("R70 update: the");
    expect(CI).toContain("the FIRST real gate execution");
  });
});

describe("R70-E: the audit record freezes the merge + run + root-cause + replica facts", () => {
  test("merge facts recorded", () => {
    expect(DOC).toContain("fast-forward `27e0eea..6538d46`");
    expect(DOC).toContain("213 files changed");
    expect(DOC).toContain("Linear history preserved");
  });

  test("first-real-run facts recorded", () => {
    expect(DOC).toContain("35414649589");
    expect(DOC).toContain("FIRST real gate execution");
    expect(DOC).toContain("The table `public.User` does not exist");
  });

  test("byte-fresh replica methodology + result recorded", () => {
    expect(DOC).toContain("fayanms_gatecheck");
    expect(DOC).toContain("997 pass / 18 skip / 0 fail");
  });

  test("plan-gate classification on merged main recorded honestly", () => {
    expect(DOC).toContain("exit 2, `GOV-PLAN-BLOCKER`");
    expect(DOC).toContain("NOT yet governance-verified");
  });

  test("residual risk register records the never-executed e2e/browser/scan jobs", () => {
    expect(DOC).toContain("`e2e`, `browser`, `scan` jobs have **never really executed**");
  });
});

describe("R70-F: PAT hygiene on the new round artifacts", () => {
  test("no credential material in ci.yml or the R70 audit doc", () => {
    for (const [name, text] of [["ci.yml", CI], ["doc", DOC]] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
      expect(/Bearer\s+[A-Za-z0-9_\-]{30,}/.test(text), name).toBeFalse();
    }
  });
});
