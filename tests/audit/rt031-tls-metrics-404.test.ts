import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-031 (F-061) — the edge 404 for /api/metrics must exist on EVERY TLS
 * entrypoint, not just one.
 *
 * The finding: the internal-metrics block
 *
 *     @internal_metrics path /api/metrics
 *     respond @internal_metrics 404
 *
 * was added to deploy/oci/Caddyfile only; docs/deploy/Caddyfile.tls (the
 * repo's canonical TLS example) and the sandbox root gateway Caddyfile
 * never received it. src/app/api/metrics/route.ts treats the metrics token
 * as OPTIONAL, so on those entrypoints unauthenticated process metrics
 * (uptime, RSS, release SHA) were reachable from the public internet —
 * inconsistent posture between the two TLS entrypoints.
 *
 * Pinned here (config police, style of tests/audit/deploy-hardening.test.ts):
 *   1. docs/deploy/Caddyfile.tls carries the block;
 *   2. ALL THREE Caddyfiles agree (parity contract — a future fourth
 *      entrypoint MUST repeat the block; the failure message says so);
 *   3. the matcher is exactly /api/metrics — no broad path pattern that
 *      would break /api/v1/* or /api/health pass-through;
 *   4. deploy/oci/Caddyfile (the source of truth) is unchanged.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const MATCHER_LINE = "@internal_metrics path /api/metrics";
const RESPOND_LINE = "respond @internal_metrics 404";

/** Every ingress Caddyfile in the repo (add the fourth here when it lands). */
const ALL_CADDYFILES = [
  "deploy/oci/Caddyfile",
  "docs/deploy/Caddyfile.tls",
  "Caddyfile",
];

describe("RT-031: internal-metrics edge 404 parity", () => {
  const tls = readRepoFile("docs/deploy/Caddyfile.tls");
  const oci = readRepoFile("deploy/oci/Caddyfile");
  const root = readRepoFile("Caddyfile");

  test("TLS Caddyfile 404s /api/metrics", () => {
    expect(tls).toContain(MATCHER_LINE);
    expect(tls).toContain(RESPOND_LINE);
    // The block guards the app site: the respond comes before the proxy.
    const respondAt = tls.indexOf(RESPOND_LINE);
    const proxyAt = tls.indexOf("reverse_proxy app:3000");
    expect(respondAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeGreaterThan(-1);
    expect(respondAt).toBeLessThan(proxyAt);
  });

  test("all three Caddyfiles agree (parity contract)", () => {
    // FUTURE FOURTH ENTRYPOINT: any new Caddyfile/ingress in this repo MUST
    // repeat these two lines — add it to ALL_CADDYFILES or this contract
    // silently rots again (that is exactly how F-061 happened).
    for (const file of ALL_CADDYFILES) {
      const text = readRepoFile(file);
      expect(
        text,
        `${file} must carry the internal-metrics 404 block (RT-031 parity contract)`
      ).toContain(MATCHER_LINE);
      expect(
        text,
        `${file} must respond 404 to @internal_metrics (RT-031 parity contract)`
      ).toContain(RESPOND_LINE);
    }
  });

  test("no other path is 404'd (matcher is exactly /api/metrics)", () => {
    for (const [name, text] of [
      ["docs/deploy/Caddyfile.tls", tls],
      ["deploy/oci/Caddyfile", oci],
      ["Caddyfile", root],
    ] as const) {
      // The matcher declares exactly one path.
      const matcherDeclarations = text.match(/^.*@internal_metrics path .*$/gm) ?? [];
      expect(matcherDeclarations.length, name).toBe(1);
      const matcherDecl = matcherDeclarations[0] ?? "";
      expect(matcherDecl.trim(), name).toBe(MATCHER_LINE);
      // The only respond driven by the matcher is the 404.
      const respondUses = text.match(/^.*respond @internal_metrics.*$/gm) ?? [];
      expect(respondUses.length, name).toBe(1);
      const respondUse = respondUses[0] ?? "";
      expect(respondUse.trim(), name).toBe(RESPOND_LINE);
      // No wildcard/path-prefix matcher could 404 /api/v1/* or /api/health.
      expect(text, name).not.toMatch(/path\s+\*+/);
      expect(text, name).not.toMatch(/path\s+\/api\/\*/);
    }
  });

  test("deploy/oci/Caddyfile stays the unchanged source of truth", () => {
    // Regression guard: the OCI block predates this RT — the metrics 404
    // pair must stay present and ordered before the log/reverse_proxy
    // blocks (comments between them are fine — RT-029 moved the log block
    // wording, not the gate).
    expect(oci).toMatch(
      /@internal_metrics path \/api\/metrics\n\s*respond @internal_metrics 404/
    );
    expect(oci.indexOf("respond @internal_metrics 404")).toBeLessThan(
      oci.indexOf("reverse_proxy app:3000")
    );
  });
});
