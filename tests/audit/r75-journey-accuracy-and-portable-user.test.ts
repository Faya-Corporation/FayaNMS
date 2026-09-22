/**
 * R75 — CI journey-accuracy history plus the current portable non-root
 * container contract.
 *
 * The journey assertions retain the historical R75 evidence. The image
 * assertions track the current hardened runtime: Bun's digest-pinned
 * distroless image, numeric uid 10001, and no runtime user/package-manager
 * registration. The build/runtime split is intentional and is covered by
 * the supply-chain and image-build contracts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "../..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const DETECTION = read("tests/browser/detection-journeys.test.ts");
const DOCKERFILE = read("Dockerfile");
const DOC = read("docs/audits/FayaNMS-R70-Merge-to-Main-and-CI-Bootstrap-2026-09-19.md");

describe("R75-A: the D-journeys match the UI's real conflict semantics", () => {
  test("D7 waits on the toast title with an exact match (strict-mode safe)", () => {
    const d7 = DETECTION.slice(
      DETECTION.indexOf('"D7: no credential selected'),
      DETECTION.indexOf('"D8+D9:')
    );
    expect(d7).toContain('getByText("Hostname resolved", { exact: true })');
    expect(d7).not.toContain('getByText("Hostname resolved")');
  });

  test("D11 exercises Use and Keep-mine in two passes, not one impossible chip", () => {
    const d11 = DETECTION.slice(
      DETECTION.indexOf('"D11: field conflict'),
      DETECTION.indexOf('"D12: vendor-stage')
    );
    const use = d11.indexOf('name: "Use", exact: true');
    const keep = d11.indexOf('name: "Keep mine", exact: true');
    const refill = d11.indexOf('page.fill("#device-mgmt-ip", "10.99.99.99")');
    expect(use, "Use click exists").toBeGreaterThan(-1);
    expect(keep, "Keep-mine click exists").toBeGreaterThan(-1);
    expect(use < keep, "Use pass BEFORE Keep-mine pass").toBeTrue();
    expect(refill, "re-type between the passes").toBeGreaterThan(-1);
    expect(d11).toContain("two passes");
  });

  test("D12 asserts the typed-code invariant, not one sandbox-specific code", () => {
    // D12 is the LAST test — slice from its name to the end of file (the
    // describe block opens BEFORE D6, so the describe line cannot bound it).
    const d12 = DETECTION.slice(DETECTION.indexOf('"D12: vendor-stage'));
    expect(d12).toContain("CREDENTIAL_UNRESOLVED|SSH_TARGET_POLICY_REFUSED|SSH_UNREACHABLE");
    expect(d12).toContain("Management address — 127.0.0.1");
    // the sandbox-specific single-code wait is gone
    expect(d12).not.toContain('getByText("CREDENTIAL_UNRESOLVED", { exact: false })');
  });
});

describe("R75-B: the images use portable non-root distroless runtimes", () => {
  test("the app runtime is digest-pinned and runs as numeric uid 10001", () => {
    const runtime = DOCKERFILE.slice(
      DOCKERFILE.indexOf("FROM oven/bun:1.3.14-distroless")
    );
    expect(runtime).toContain(
      "oven/bun:1.3.14-distroless@sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307"
    );
    expect(runtime).toContain("COPY --from=build --chown=10001:10001");
    expect(runtime).toContain("USER 10001");
    expect(runtime).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(runtime).not.toContain(">> /etc/passwd");
    expect(runtime).not.toContain(">> /etc/group");
    expect(runtime).not.toContain("addgroup --system");
    expect(runtime).not.toContain("adduser --system");
  });

  test("the worker runtime is distroless and uses the same non-root uid", () => {
    const worker = read("Dockerfile.worker");
    const runtime = worker.slice(worker.indexOf("FROM oven/bun:1.3.14-distroless"));
    expect(runtime).toContain(
      "oven/bun:1.3.14-distroless@sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307"
    );
    expect(runtime).toContain("USER 10001");
    expect(runtime).toContain('ENTRYPOINT ["/usr/local/bin/bun"]');
    expect(runtime).not.toContain("USER bun");
    expect(runtime).not.toContain("addgroup");
    expect(runtime).not.toContain("adduser");
  });
});

describe("R75-C: the run record is frozen in the audit doc", () => {
  test("iteration-6 facts recorded (9/12 + three journey bugs + exit 127)", () => {
    expect(DOC).toContain("## 11. R75 ADDENDUM");
    expect(DOC).toContain("35421797082");
    expect(DOC).toContain("9/12");
    expect(DOC).toContain("addgroup: not found");
    expect(DOC).toContain("strict");
  });

  test("PAT hygiene on the touched artifacts", () => {
    for (const [name, text] of [
      ["detection-journeys", DETECTION],
      ["Dockerfile", DOCKERFILE],
      ["doc", DOC],
    ] as const) {
      expect(text.includes("github_pat_"), name).toBeFalse();
      expect(text.includes("ghp_"), name).toBeFalse();
    }
  });
});
