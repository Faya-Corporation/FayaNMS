import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * SUPPLY-001-A — immutable base inputs + runtime image scan evidence.
 *
 * The confirmed finding: base images were TAG-pinned only (mutable — a
 * re-tag upstream silently changes what a build produces), and CI scanned
 * the FILESYSTEM, never the built images — the artifact a host actually
 * runs had zero scan evidence (independent audit 2026-09-15, P2).
 *
 * Pinned here:
 *   1. EVERY base image reference in Dockerfile, Dockerfile.worker,
 *      compose.yml and compose.tls.yml carries an @sha256 digest (tag kept
 *      for readability; the digest is authoritative);
 *   2. the pinned digests are the REAL registry-resolved values (byte-strict
 *      — resolved from Docker Hub at remediation time 2026-09-15; a bump
 *      must re-resolve, per the inline bump procedure);
 *   3. CI builds BOTH runtime images and scans them AS IMAGES (trivy image,
 *      HIGH/CRITICAL fail) and produces per-image SBOM artifacts — fs scans
 *      alone no longer satisfy the supply-chain gate.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

/** Registry-resolved digests (2026-09-15) — byte-strict immutability pins. */
const EXPECTED_DIGESTS: Record<string, string> = {
  "oven/bun:1.3.14": "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4",
  "oven/bun:1.3.14-slim": "sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04",
  "oven/bun:1.3.14-distroless": "sha256:c28c51287af70bab8e0b66fc4b6a30cfb92a727ebc88045223adc9f4c9d09307",
  "postgres:16-alpine": "sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685",
  "caddy:2-alpine": "sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648",
};

describe("SUPPLY-001-A: every base image is digest-pinned", () => {
  test("Dockerfile FROM lines all carry @sha256 digests", () => {
    const dockerfile = readRepoFile("Dockerfile");
    const froms = dockerfile.split("\n").filter((l) => l.startsWith("FROM "));
    expect(froms.length).toBeGreaterThanOrEqual(3);
    for (const line of froms) {
      // Stage references (FROM <stage> AS ...) carry no registry ref; every
      // EXTERNAL image reference must be digest-pinned.
      const ref = line.replace(/^FROM\s+/, "").split(/\s+/)[0];
      if (ref.includes("/")) {
        expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
      }
    }
  });

  test("Dockerfile.worker build and runtime FROM lines carry digests", () => {
    const dockerfile = readRepoFile("Dockerfile.worker");
    const froms = dockerfile.split("\n").filter((l) => l.startsWith("FROM "));
    expect(froms.length).toBe(2);
    for (const line of froms) {
      expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
    }
    expect(froms.some((line) => line.includes("AS deps"))).toBeTrue();
    expect(froms.some((line) => line.includes("distroless") && line.includes("AS runtime"))).toBeTrue();
  });

  test("compose base images (postgres, proxy) are digest-pinned", () => {
    const compose = readRepoFile("compose.yml");
    expect(compose).toMatch(/postgres:16-alpine@sha256:[0-9a-f]{64}/);
    const tls = readRepoFile("compose.tls.yml");
    expect(tls).toMatch(/caddy:2-alpine@sha256:[0-9a-f]{64}/);
  });

  test("the pinned digests are the real registry-resolved values (byte-strict)", () => {
    const all = [
      readRepoFile("Dockerfile"),
      readRepoFile("Dockerfile.worker"),
      readRepoFile("compose.yml"),
      readRepoFile("compose.tls.yml"),
    ].join("\n");
    for (const [ref, digest] of Object.entries(EXPECTED_DIGESTS)) {
      expect(all).toContain(`${ref.split(":").slice(0, 1)[0]}:${ref.split(":")[1]}@${digest}`);
      expect(all).toContain(digest);
    }
  });

  test("the bump procedure is documented inline (no silent tag bumps)", () => {
    const dockerfile = readRepoFile("Dockerfile");
    expect(dockerfile).toContain("digest-pinned");
    expect(dockerfile).toContain("Bump procedure");
    expect(dockerfile).toContain("imagetools");
  });
});

describe("SUPPLY-001-A: CI builds and scans the runtime images (image-level)", () => {
  const ci = readRepoFile(".github/workflows/ci.yml");

  test("both runtime images are built in CI", () => {
    // R74 (run 35420764756): shape evolved from the single-line
    // `docker build -t fayanms-app:ci .`; the governance intent is unchanged:
    // both images are built from the checkout and scanned as images.
    // F-026 (batch 9): NO site-URL build arg — the origin is the RUNTIME
    // SITE_URL (per-request resolution); the old T1 guard/placeholder era
    // is retired and the client bundles ship origin-free.
    const buildStep = ci.slice(
      ci.indexOf("- name: Build runtime images (app + worker)"),
      ci.indexOf("- name: Image scan — app")
    );
    expect(buildStep).toContain("- name: Build runtime images (app + worker)");
    expect(buildStep).not.toContain("NEXT_PUBLIC_SITE_URL");
    expect(buildStep).toContain("-t fayanms-app:ci .");
    expect(ci).toMatch(/docker build -f Dockerfile\.worker\b[^\r\n]*--build-arg FAYANMS_SOURCE_SHA=\$GITHUB_SHA[^\r\n]*-t fayanms-worker:ci \./);
  });

  test("trivy scans the IMAGES (not just the filesystem) and fails on HIGH/CRITICAL", () => {
    expect(ci).toContain("scan-type: image");
    expect(ci).toContain("image-ref: fayanms-app:ci");
    expect(ci).toContain("image-ref: fayanms-worker:ci");
  });

  test("per-image SBOM artifacts are produced and retained", () => {
    expect(ci).toContain("sbom-app-image.cdx.json");
    expect(ci).toContain("sbom-worker-image.cdx.json");
    expect(ci).toContain("sbom-runtime-images");
  });
});
