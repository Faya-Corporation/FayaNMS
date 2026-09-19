/**
 * R72 — CI bring-up iteration 3: seed-KEK + gitleaks triage.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §8):
 * dispatch #6 (run 35416148348 @ 18c1a28) produced the FIRST GREEN GATE JOB in
 * repo history (lint, typecheck, full 1031-test suite, SSH certification,
 * brand, schema/migration/drift, seed smoke, i18n parity, production build —
 * all success on the real runner). The three downstream jobs then executed
 * for the FIRST time ever:
 *   - e2e + browser: harness seed failed with "FAYANMS_CONFIG_ENC_KEY is
 *     missing or not 64 hex chars" — the harness seed subprocess inherited
 *     ambient env for the config KEK (sandbox masked it via bun auto-load of
 *     the dev .env; CI's sparse job env has none). FIX: the seed env now
 *     carries the run's fresh RUN_SECRET (+ key id) — the same KEK the app
 *     boots with, so seeded ciphertext is decryptable by the server under
 *     test. Replicated deterministically: empty key → exit 1 with the exact
 *     refusing error; valid 64-hex → "Seed complete."
 *   - scan: first real gitleaks run exited 2 with findings that are ALL
 *     committed, audit-trialed throwaway fixtures. FIX: committed
 *     .gitleaks.toml keeps the FULL default ruleset and scopes a minimal
 *     path allowlist (tests/, docs/audits/, docs/ci/, worklog.md,
 *     mini-services/worker/harness/, ci.yml itself, .env.example) with the
 *     triage rationale inline. Verified with checksum-verified gitleaks
 *     8.24.3: baseline 10 findings → allowlist v1 → 7 → final: "no leaks
 *     found" (exit 0) across 193 commits.
 *
 * These pins freeze the allowlist shape (against silent widening), the
 * seed-KEK fix, and the run record. They never execute the harness.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const GITLEAKS = read(".gitleaks.toml");
const E2E = read("tests/e2e/e2e-server.ts");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R72-A: the gitleaks allowlist keeps the default ruleset and stays narrow", () => {
  test("default rules are extended, never replaced or muted", () => {
    expect(GITLEAKS).toContain("[extend]");
    expect(GITLEAKS).toContain("useDefault = true");
    expect(GITLEAKS).not.toContain("useDefault = false");
  });

  test("the allowlist is scoped to exactly the seven triaged paths", () => {
    const block = GITLEAKS.slice(GITLEAKS.indexOf("[allowlist]"));
    const expected = [
      "'''^tests/'''",
      "'''^docs/audits/'''",
      "'''^docs/ci/'''",
      "'''^worklog\\.md$'''",
      "'''^mini-services/worker/harness/'''",
      "'''^\\.github/workflows/ci\\.yml$'''",
      "'''^\\.env\\.example$'''",
    ];
    for (const p of expected) expect(block.includes(p), p).toBeTrue();
    // no regex-based value allowlists or fingerprint nukes — path scope only
    expect(block).not.toContain("regexes");
    expect(block).not.toContain("commits");
    // and nothing beyond the seven entries
    const listed = block.split("\n").filter((l) => l.trim().startsWith("'''")).length;
    expect(listed).toBe(7);
  });

  test("the triage record is inline (run id + P1-019 rationale + widening discipline)", () => {
    expect(GITLEAKS).toContain("35416148348");
    expect(GITLEAKS).toContain("P1-019");
    expect(GITLEAKS).toContain("Widening this allowlist requires a new");
  });
});

describe("R72-B: the e2e harness seed carries the run's config KEK explicitly", () => {
  test("seed subprocess env includes FAYANMS_CONFIG_ENC_KEY: RUN_SECRET (+ key id)", () => {
    const seedAt = E2E.indexOf("bun\", \"prisma/seed.ts\"");
    expect(seedAt).toBeGreaterThan(-1);
    const envBlock = E2E.slice(seedAt, E2E.indexOf("});", seedAt));
    expect(envBlock).toContain("FAYANMS_CONFIG_ENC_KEY: RUN_SECRET");
    expect(envBlock).toContain('FAYANMS_CONFIG_ENC_KEY_ID: "k1"');
    expect(envBlock).toContain('FAYANMS_DEMO_MODE: "true"');
  });

  test("the R72 finding + deterministic replication are recorded in the harness header", () => {
    expect(E2E).toContain("35416148348");
    expect(E2E).toContain("FAYANMS_CONFIG_ENC_KEY is missing or not 64 hex chars");
  });
});

describe("R72-C: the run record is frozen in the audit doc", () => {
  test("first green gate + downstream first executions + triage recorded", () => {
    expect(DOC).toContain("FIRST GREEN GATE");
    expect(DOC).toContain("1018/18/0");
    expect(DOC).toContain("§8");
    expect(DOC).toContain("no leaks found");
    expect(DOC).toContain("8.24.3");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [["gitleaks.toml", GITLEAKS], ["e2e-server", E2E], ["doc", DOC]] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
