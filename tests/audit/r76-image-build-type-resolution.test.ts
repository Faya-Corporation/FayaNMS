/**
 * R76 — CI bring-up iteration 7: browser FIRST GREEN (12/12) + the app
 * image build resolves the worker's types.
 *
 * Context (docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md §12):
 * run 35422501995 @ 6d01aeb — gate GREEN fifth consecutive, e2e GREEN fourth
 * consecutive, **browser GREEN — FIRST TIME in repo history (12/12: the
 * B-suite plus all six detection-panel journeys after four bring-up
 * iterations)** — and the scan job's image build moved one layer deeper:
 * next build type-checks the WHOLE repo per the root tsconfig (the include
 * covers every .ts under the repo root — the documented "src/ + worker
 * zero-error policy"), so the worker's TS files must resolve ssh2 and its
 * types INSIDE the image build — ci.yml's "Install worker dependencies
 * (frozen)" step provides exactly that to the gate/e2e/browser jobs, but
 * the Docker build stage never had it (worker node_modules are
 * context-excluded by .dockerignore). The type errors (TS2307 ssh2,
 * TS18046 unknown) were followed by a Bun 1.3.14 segfault during the
 * failing type-check teardown (crash AFTER the errors — Bun's own bug
 * class; the deterministic root cause is the resolution).
 * FIX: the build stage installs the worker deps frozen (lockfile-committed)
 * BEFORE the copy + build, mirroring the CI jobs; the runtime stage stays
 * worker-free, so the audited image content is unchanged.
 *
 * These pins freeze the build-stage mirror and the runtime-stage purity.
 * They never execute docker or the harness.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DOCKERFILE = read("Dockerfile");
const CI = read(".github/workflows/ci.yml");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R76-A: the app image build mirrors the CI type-check environment", () => {
  test("the build stage installs the worker deps frozen BEFORE the build", () => {
    const buildStage = DOCKERFILE.slice(
      DOCKERFILE.indexOf("FROM deps AS build"),
      DOCKERFILE.indexOf("FROM oven/bun:1.3.14-distroless")
    );
    const workerCopy = buildStage.indexOf("COPY mini-services/worker/package.json");
    const workerInstall = buildStage.indexOf(
      "RUN cd mini-services/worker && bun install --frozen-lockfile"
    );
    const build = buildStage.indexOf("bun run build");
    expect(workerCopy, "worker manifests copied").toBeGreaterThan(-1);
    expect(workerInstall, "frozen worker install exists").toBeGreaterThan(-1);
    expect(workerInstall < build, "worker install precedes next build").toBeTrue();
    expect(buildStage).toContain("35422501995");
  });

  test("the runtime stage stays worker-free (unchanged audited content)", () => {
    const runtime = DOCKERFILE.slice(DOCKERFILE.indexOf("FROM oven/bun:1.3.14-distroless"));
    expect(runtime).toContain("/app/.next/standalone");
    expect(runtime).toContain("node_modules/.prisma");
    expect(runtime).toContain("USER 10001");
    expect(runtime).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(runtime).not.toContain("mini-services/worker");
    expect(runtime).not.toContain("bun install");
    expect(runtime).not.toContain("apt-get");
  });

  test("the CI jobs' worker install remains the documented reference shape", () => {
    expect(CI).toContain("Install worker dependencies (frozen)");
    expect(CI).toContain("cd mini-services/worker && bun install --frozen-lockfile");
  });
});

describe("R76-B: the run record is frozen in the audit doc", () => {
  test("browser first-green 12/12 + the type-resolution root cause recorded", () => {
    expect(DOC).toContain("## 12. R76 ADDENDUM");
    expect(DOC).toContain("35422501995");
    expect(DOC).toContain("FIRST GREEN BROWSER JOB");
    expect(DOC).toContain("TS2307");
    expect(DOC).toContain("zero-error");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["Dockerfile", DOCKERFILE],
      ["ci.yml", CI],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
