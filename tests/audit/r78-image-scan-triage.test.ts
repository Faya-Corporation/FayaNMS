/**
 * R78 — image-scan triage history plus the current strict runtime contract.
 *
 * The historical addendum remains frozen below. Current image assertions
 * verify the follow-up remediation: digest-pinned distroless runtime stages
 * remove the Debian package-manager/utility surface, so image scans remain
 * fatal for every HIGH/CRITICAL result, including unfixed findings.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DOCKERFILE = read("Dockerfile");
const WORKER = read("Dockerfile.worker");
const MIGRATOR = read("Dockerfile.migrator");
const PRISMA_RUNTIME_HELPER = read("scripts/ci/prepare-prisma-runtime.sh");
const CI = read(".github/workflows/ci.yml");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R78-A: both runtime images use the hardened distroless base", () => {
  test("the app runtime has no package-manager or utility surface", () => {
    const runtime = DOCKERFILE.slice(
      DOCKERFILE.indexOf("FROM oven/bun:1.3.14-distroless")
    );
    expect(runtime).toContain(
      "oven/bun:1.3.14-distroless@sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307"
    );
    expect(runtime).toContain("USER 10001");
    expect(runtime).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(runtime).not.toContain("apt-get");
    expect(runtime).not.toContain("apk");
    expect(runtime).not.toContain("adduser");
    expect(runtime).not.toContain("addgroup");
  });

  test("the worker runtime has the same hardened contract", () => {
    const runtime = WORKER.slice(
      WORKER.indexOf("FROM oven/bun:1.3.14-distroless")
    );
    expect(runtime).toContain(
      "oven/bun:1.3.14-distroless@sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307"
    );
    expect(runtime).toContain("USER 10001");
    expect(runtime).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(runtime).not.toContain("apt-get");
    expect(runtime).not.toContain("apk");
  });
});

describe("R78-B: the image-scan gate is strict", () => {
  test("both image scans fail on every HIGH/CRITICAL result", () => {
    const appScan = CI.slice(
      CI.indexOf("- name: Image scan — app"),
      CI.indexOf("- name: Image scan — worker")
    );
    const workerScan = CI.slice(
      CI.indexOf("- name: Image scan — worker"),
      CI.indexOf("- name: Image SBOMs")
    );
    expect(appScan).toContain("ignore-unfixed: false");
    expect(workerScan).toContain("ignore-unfixed: false");
    expect(appScan).toContain("exit-code: \"1\"");
    expect(workerScan).toContain("exit-code: \"1\"");
    // The filesystem scan remains a separate, fully active scan.
    const fsScan = CI.slice(
      CI.indexOf("- name: Container scan (trivy)"),
      CI.indexOf("- name: Container scan skipped")
    );
    expect(fsScan).not.toContain("ignore-unfixed");
  });
});

describe("R78-C: the run record is frozen in the audit doc", () => {
  test("iteration-10 facts recorded (artifact proof passed, 88 base findings)", () => {
    expect(DOC).toContain("## 14. R78 ADDENDUM");
    expect(DOC).toContain("35423693016");
    expect(DOC).toContain("88 HIGH/CRITICAL");
    expect(DOC).toContain("BUILD_ID");
    expect(DOC).toContain("current tag resolution");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["Dockerfile", DOCKERFILE],
      ["Dockerfile.worker", WORKER],
      ["ci.yml", CI],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});


describe("R78-D: Prisma native runtime closure is explicit and non-root", () => {
  test("the app and migrator carry only the staged Prisma/OpenSSL closure", () => {
    expect(PRISMA_RUNTIME_HELPER).toContain("libgcc_s.so.1");
    expect(PRISMA_RUNTIME_HELPER).toContain("command -v openssl");

    const appRuntime = DOCKERFILE.slice(
      DOCKERFILE.indexOf("FROM oven/bun:1.3.14-distroless")
    );
    const migratorRuntime = MIGRATOR.slice(
      MIGRATOR.indexOf("FROM oven/bun:1.3.14-distroless")
    );

    expect(DOCKERFILE).toContain(
      "RUN /usr/local/bin/prepare-prisma-runtime.sh /app /prisma-runtime"
    );
    expect(appRuntime).toContain(
      "COPY --from=build --chown=10001:10001 /prisma-runtime ./prisma-runtime"
    );
    expect(appRuntime).toContain(
      "LD_LIBRARY_PATH=/app/prisma-runtime/lib"
    );
    expect(migratorRuntime).toContain(
      "COPY --from=deps --chown=10001:10001 /prisma-runtime ./prisma-runtime"
    );
    expect(migratorRuntime).toContain(
      "LD_LIBRARY_PATH=/migrator/prisma-runtime/lib"
    );
    expect(migratorRuntime).not.toContain("apt-get");
    expect(migratorRuntime).toContain("USER 10001");
  });
});
