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
 *   2. exactly THREE update entries — TWO `package-ecosystem: "bun"` plus
 *      ONE `package-ecosystem: "github-actions"` (RT-035/F-065: the actions
 *      ecosystem keeps the ci.yml SHA pins fresh — without it, nothing
 *      ever proposed a pin update and an ARCHIVED action
 *      (returntocorp/semgrep-action) sat unflagged);
 *   3. BOTH bun manifest paths are declared (`/` and `/mini-services/worker`)
 *      AND both declared manifests actually exist on disk (package.json +
 *      bun.lock each) — config and reality cannot drift apart silently;
 *      the actions entry pins directory `/` (the workflows live in
 *      .github/workflows);
 *   4. weekly cadence on ALL entries;
 *   5. a security-updates GROUP on the bun entries (applies-to:
 *      security-updates) — CVE bumps land as one reviewable PR;
 *   6. the allow policy on the entries (`dependency-type: "all"`) plus
 *      the header comment that documents exact-pin preservation;
 *   7. no `ignore` blocks exist that could silently mute security updates;
 *   8. the README supply-chain note exists and states the OWNER-CI-001
 *      activation caveat (config reviewable now, PRs activate with
 *      runners);
 *   9. no duplicate (ecosystem, directory) pairs (RT-035 negative case).
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

  test("exactly THREE update entries: two bun + one github-actions (RT-035)", () => {
    const blocks = updateEntryBlocks(config);
    expect(blocks.length).toBe(3);
    const bunBlocks = blocks.filter((b) => /package-ecosystem:\s*"bun"/.test(b));
    const actionsBlocks = blocks.filter((b) => /package-ecosystem:\s*"github-actions"/.test(b));
    expect(bunBlocks.length).toBe(2);
    expect(actionsBlocks.length).toBe(1);
    // No other ecosystems sneak in.
    const ecosystems = [...config.matchAll(/package-ecosystem:\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(ecosystems.sort()).toEqual(["bun", "bun", "github-actions"]);
  });

  test("BOTH bun manifest paths are declared AND exist on disk (no drift)", () => {
    const blocks = updateEntryBlocks(config);
    const root = blockForDirectory(blocks, "/");
    const worker = blockForDirectory(blocks, "/mini-services/worker");
    expect(root).toContain('directory: "/"');
    expect(root).toContain('package-ecosystem: "bun"');
    expect(worker).toContain('directory: "/mini-services/worker"');
    // Config ↔ reality consistency: each declared manifest really exists
    // with its committed lockfile (the dual-lockfile osv scan pair).
    expect(existsSync(path.join(REPO_ROOT, "package.json"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "bun.lock"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "mini-services/worker/package.json"))).toBe(true);
    expect(existsSync(path.join(REPO_ROOT, "mini-services/worker/bun.lock"))).toBe(true);
  });

  test("weekly cadence on ALL entries", () => {
    for (const block of updateEntryBlocks(config)) {
      expect(block).toMatch(/interval:\s*"weekly"/);
    }
  });

  test("security-updates GROUP on the bun entries (one reviewable PR per wave)", () => {
    for (const block of updateEntryBlocks(config)) {
      if (!block.includes('package-ecosystem: "bun"')) continue;
      expect(block).toMatch(/security-updates:\s*\n\s+applies-to:\s*security-updates/);
    }
    // All THREE entries (bun ×2 + github-actions) carry the grouped
    // security policy.
    expect(config.match(/applies-to:\s*security-updates/g)?.length).toBe(3);
  });

  test("the allow policy is declared on ALL entries + exact-pin preservation documented", () => {
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

describe("RT-035 (F-065): github-actions ecosystem entry", () => {
  const config = readRepoFile(CONFIG_PATH);
  const blocks = updateEntryBlocks(config);

  test("github-actions ecosystem present", () => {
    const actions = blocks.find((b) => /package-ecosystem:\s*"github-actions"/.test(b));
    expect(actions).toBeDefined();
    expect(actions).toContain('directory: "/"');
    expect(actions).toMatch(/interval:\s*"weekly"/);
    // Scope comment: the entry exists to keep the ci.yml SHA pins fresh,
    // and the archived semgrep-action follow-up is noted (comment only).
    expect(config).toMatch(/SHA pins of third-party actions fresh|keeps the SHA pins/);
    expect(config).toContain("returntocorp/semgrep-action is ARCHIVED upstream");
  });

  test("existing bun entries untouched (regression guard)", () => {
    const bunBlocks = blocks.filter((b) => /package-ecosystem:\s*"bun"/.test(b));
    expect(bunBlocks.length).toBe(2);
    const [root, worker] = bunBlocks;
    expect(root).toContain('directory: "/"');
    expect(root).toContain("open-pull-requests-limit: 10");
    expect(worker).toContain('directory: "/mini-services/worker"');
    expect(worker).toContain("open-pull-requests-limit: 5");
    for (const block of bunBlocks) {
      expect(block).toMatch(/security-updates:\s*\n\s+applies-to:\s*security-updates/);
      expect(block).toMatch(/allow:\s*\n\s+-\s+dependency-type:\s*"all"/);
    }
  });

  test("schedule/cadence consistent with the house style (weekly/monday/06:00)", () => {
    const actions = blocks.find((b) => /package-ecosystem:\s*"github-actions"/.test(b)) ?? "";
    expect(actions).toMatch(/interval:\s*"weekly"/);
    expect(actions).toMatch(/day:\s*"monday"/);
    expect(actions).toMatch(/time:\s*"06:00"/);
    expect(actions).toMatch(/timezone:\s*"Etc\/UTC"/);
  });

  test("no duplicate ecosystem+directory pairs", () => {
    const pairs = blocks
      .map((b) => {
        const eco = b.match(/package-ecosystem:\s*"([^"]+)"/)?.[1];
        const dir = b.match(/directory:\s*"([^"]+)"/)?.[1];
        return `${eco} @ ${dir}`;
      })
      .filter((p) => !p.includes("null"));
    expect(new Set(pairs).size).toBe(pairs.length);
  });
});
