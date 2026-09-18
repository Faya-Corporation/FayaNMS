import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * R60 — R52 re-audit INFO notes (optional polish) zeroed out.
 *
 * The R52 full re-audit (2026-09-18) closed with four INFO notes explicitly
 * labeled optional polish:
 *   1. ci.yml service-container postgres is tag-pinned (CI-only, ephemeral);
 *   2. .gitignore CERT-006 comment path imprecision;
 *   3. README "Bun ≥ 1.1" loose floor vs CI 1.3.14;
 *   4. no dependabot/renovate — codified as roadmap item HC-5 (LANDED R57).
 *
 * This round closes 1–3, making the INFO list EMPTY. Pinned here:
 *   - pin 1: EVERY container image line in ci.yml carries an @sha256 digest;
 *     all three postgres service containers use the byte-strict SUPPLY-001-A
 *     registry resolution (same digest as compose.yml — no new resolution
 *     introduced, one image, one truth);
 *   - pin 2: the .gitignore CERT-006 exemption comment references the FULL
 *     unambiguous path (mini-services/worker/harness/tls/README.md) and that
 *     file actually exists (comment ↔ reality cross-check);
 *   - pin 3: the README documents the 1.3.14 floor (badge label, alt text,
 *     prerequisites) with the rationale line, no stale "≥ 1.1" Bun claim
 *     remains anywhere in the README, and the floor byte-equals the
 *     digest-pinned oven/bun runtime version (README floor === image truth);
 *   - pin 4: the HC-5 INFO closure remains intact (dependabot config still
 *     present) — the full four-note list reads as closed.
 *
 * Honest scope: GitHub Actions does not execute here (runner-blocked,
 * OWNER-CI-001) — the ci.yml edit is validated structurally (this pin) and
 * the YAML was parsed locally as a one-off (PyYAML at R60); execution proof
 * lands with HC-6.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CI_YML = ".github/workflows/ci.yml";
const GITIGNORE = ".gitignore";
const README = "README.md";

/** Registry-resolved digest reused from SUPPLY-001-A (tests/audit/supply-chain.test.ts). */
const POSTGRES_DIGEST =
  "sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("R60: R52 INFO polish notes zeroed out", () => {
  test("pin 1 — every ci.yml container image is digest-pinned; postgres uses the SUPPLY-001-A digest", () => {
    const ci = readRepoFile(CI_YML);
    const imageLines = ci.split("\n").filter((l) => /^\s*image:\s*\S/.test(l));
    // Three postgres service containers (gate, e2e, browser jobs) — the only
    // container images in the workflow.
    expect(imageLines.length).toBe(3);
    for (const line of imageLines) {
      expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
      expect(line).toContain(`postgres:16-alpine@${POSTGRES_DIGEST}`);
    }
    // No new registry resolution was introduced: the digest byte-equals the
    // one compose.yml already pins (one image, one truth).
    expect(readRepoFile("compose.yml")).toContain(`postgres:16-alpine@${POSTGRES_DIGEST}`);
  });

  test("pin 2 — .gitignore CERT-006 comment carries the full explicit path that really exists", () => {
    const gi = readRepoFile(GITIGNORE);
    const fullPath = "mini-services/worker/harness/tls/README.md";
    expect(gi).toContain(`see\n# ${fullPath}`);
    expect(existsSync(path.join(REPO_ROOT, fullPath))).toBe(true);
    // The ambiguous bare relative path must be gone.
    expect(gi).not.toMatch(/see harness\/tls\/README\.md/);
  });

  test("pin 3 — README Bun floor raised to 1.3.14 with rationale; stale ≥ 1.1 claim gone; floor === runtime image", () => {
    const readme = readRepoFile(README);
    expect(readme).toContain("Bun-%E2%89%A51.3.14-525252");
    expect(readme).toContain('alt="Bun ≥ 1.3.14"');
    expect(readme).toContain("≥ 1.3.14 — the floor is the version the CI");
    expect(readme).toContain("older Bun is untested and unsupported");
    expect(readme).not.toMatch(/Bun ≥ 1\.1|Bun-%E2%89%A51\.1/);
    // Floor byte-equals the digest-pinned runtime image version.
    const dockerfile = readRepoFile("Dockerfile");
    const bunFrom = dockerfile.split("\n").find((l) => l.startsWith("FROM oven/bun:"));
    expect(bunFrom).toBeDefined();
    expect(bunFrom).toContain("oven/bun:1.3.14@");
  });

  test("pin 4 — the full four-note R52 INFO list reads as closed (HC-5 closure intact)", () => {
    // Note 4 (dependabot) landed as HC-5 in R57.
    expect(existsSync(path.join(REPO_ROOT, ".github/dependabot.yml"))).toBe(true);
    // Notes 1–3 closed by this round (pins 1–3 above).
  });
});
