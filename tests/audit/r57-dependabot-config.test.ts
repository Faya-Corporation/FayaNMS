import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * HC-5 (R57) — supply-chain automation config hygiene.
 *
 * The debt: the repo had NO dependabot/renovate (re-audit 2026-09-18 INFO
 * note) — dependency pin discipline was manual + the CI osv gate only, so
 * "what is the weekly intended-diff?" had no machine-readable answer.
 *
 * Landed here: `.github/dependabot.yml` automating BOTH bun manifests in
 * the repo (root app + mini-services/worker — the two projects behind the
 * dual-lockfile osv scan in ci.yml), weekly cadence, security updates
 * GROUPED per manifest, and an explicit allow list codifying the repo's
 * versioning policy: bumps PRESERVE each dependency's declared range style
 * (a caret dep gets a caret bump; an exact pin like `next` / `react` is
 * bumped in place as an exact pin and never widened).
 *
 * Pinned here (config-hygiene, dependency-free — structural checks on the
 * raw YAML text, no YAML parser dependency):
 *   1. the config exists at the canonical path and is version: 2;
 *   2. exactly TWO update entries, both `package-ecosystem: "bun"`;
 *   3. BOTH manifest paths are declared (`/` and `/mini-services/worker`)
 *      AND both declared manifests actually exist on disk (package.json +
 *      bun.lock each) — config and reality cannot drift apart silently;
 *   4. weekly cadence on both entries;
 *   5. a security-updates GROUP on both entries (applies-to:
 *      security-updates) — CVE bumps land as one reviewable PR;
 *   6. the allow policy on both entries (`dependency-type: "all"`) plus
 *      the header comment that documents exact-pin preservation;
 *   7. no `ignore` blocks exist that could silently mute security updates;
 *   8. the README supply-chain note exists and states the OWNER-CI-001
 *      activation caveat (config reviewable now, PRs activate with
 *      runners).
 *
 * Honest scope: GitHub-side behavior (ecosystem key acceptance, first
 * scheduled run, actual PRs) cannot be exercised in this sandbox — it
 * activates with runner capacity (OWNER-CI-001). The YAML shape WAS
 * parsed locally (PyYAML one-off at R57) and the header documents that.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const CONFIG_PATH = ".github/dependabot.yml";
const README_PATH = "README.md";

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/** Split the YAML into per-entry blocks (each starts `- package-ecosystem:`). */
function updateEntryBlocks(config: string): string[] {
  const starts: number[] = [];
  const lines = config.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (/^\s{2,4}-\s+package-ecosystem:\s/.test(line)) starts.push(offset);
    offset += line.length + 1;
  }
  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : config.length;
    blocks.push(config.slice(starts[i], end));
  }
  return blocks;
}

function blockForDirectory(blocks: string[], directory: string): string {
  const block = blocks.find((b) =>
    new RegExp(`^\\s{2,4}-\\s+package-ecosystem:[\\s\\S]*?directory:\\s+"${directory.replace(/\//g, "\\/")}"\\s*$`, "m").test(b),
  );
  expect(block).toBeDefined();
  return block as string;
}

describe("HC-5: dependabot config hygiene", () => {
  const config = readRepoFile(CONFIG_PATH);

  test("the config exists at the canonical path and is version: 2", () => {
    expect(existsSync(path.join(REPO_ROOT, CONFIG_PATH))).toBe(true);
    expect(config).toMatch(/^version:\s*2\s*$/m);
    expect(config).not.toMatch(/^version:\s*1\s*$/m);
  });

  test("exactly TWO update entries, both the bun ecosystem", () => {
    const blocks = updateEntryBlocks(config);
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      expect(block).toMatch(/package-ecosystem:\s*"bun"/);
    }
    // No other ecosystems sneak in.
    expect(config.match(/package-ecosystem:\s*"(?!bun")/g)).toBeNull();
  });

  test("BOTH manifest paths are declared AND exist on disk (no drift)", () => {
    const blocks = updateEntryBlocks(config);
    const root = blockForDirectory(blocks, "/");
    const worker = blockForDirectory(blocks, "/mini-services/worker");
    expect(root).toContain('directory: "/"');
    expect(worker).toContain('directory: "/mini-services/worker"');
    // Config ↔ reality consistency: each declared manifest really exists
    // with its committed lockfile (the dual-lockfile osv scan pair).
    expect(existsSync(path.join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "bun.lock"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "mini-services/worker/package.json"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "mini-services/worker/bun.lock"))).toBe(true);
  });

  test("weekly cadence on BOTH entries", () => {
    for (const block of updateEntryBlocks(config)) {
      expect(block).toMatch(/interval:\s*"weekly"/);
    }
  });

  test("security-updates GROUP on BOTH entries (one reviewable PR per wave)", () => {
    for (const block of updateEntryBlocks(config)) {
      expect(block).toMatch(/security-updates:\s*\n\s+applies-to:\s*security-updates/);
    }
    expect(config.match(/applies-to:\s*security-updates/g)?.length).toBe(2);
  });

  test("the allow policy is declared on BOTH entries + exact-pin preservation documented", () => {
    for (const block of updateEntryBlocks(config)) {
      expect(block).toMatch(/allow:\s*\n\s+-\s+dependency-type:\s*"all"/);
    }
    // The known versioning policy, in the header comment: bumps preserve
    // each dependency's declared range style (exact pins stay exact pins).
    expect(config).toMatch(/PRESERVES each dependency's declared range style/);
    expect(config).toMatch(/exact\s+pin/i);
    expect(config).toMatch(/never widened/);
  });

  test("no ignore blocks that could silently mute security updates", () => {
    // No `ignore:` key anywhere — nothing is muted, everything is updatable
    // through the allow list (the mute valve would defeat the gate).
    expect(config).not.toMatch(/^\s*ignore:/m);
  });

  test("README supply-chain note exists with the OWNER-CI-001 activation caveat", () => {
    const readme = readRepoFile(README_PATH);
    expect(readme).toContain("HC-5 (R57): supply-chain automation config");
    expect(readme).toContain(".github/dependabot.yml");
    expect(readme).toContain("OWNER-CI-001");
    expect(readme).toContain("tests/audit/r57-dependabot-config.test.ts");
  });
});
