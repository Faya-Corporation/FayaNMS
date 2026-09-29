import { readFileSync } from "node:fs";
import path from "node:path";

import nextConfig from "../../next.config";
import { describe, expect, test } from "bun:test";

/**
 * RT-007 / F-009 — security headers at the app layer (next.config.ts
 * headers()).
 *
 * BEFORE: security headers existed only in the OPTIONAL TLS Caddy profiles
 * (deploy/oci/Caddyfile, docs/deploy/Caddyfile.tls). The base compose
 * profile (plain :80), the sandbox gateway and any direct-to-app path
 * served ZERO security headers — no CSP/frame-ancestors (clickjacking), no
 * nosniff, no Referrer-Policy — making header posture an ingress choice
 * instead of an intrinsic app property.
 *
 * Pinned here:
 *   1. next.config.ts defines a headers() block covering every path;
 *   2. the CSP value is BYTE-IDENTICAL to deploy/oci/Caddyfile — one
 *      proven policy, two layers; a divergence fails this test with this
 *      RT pointer (extend BOTH files together, never one);
 *   3. HSTS is NOT set at the app layer (single-owner rule: the TLS Caddy
 *      profile owns Strict-Transport-Security; HSTS on plain-HTTP origins
 *      is ignored/misleading);
 *   4. X-Frame-Options is NOT set (CSP `frame-ancestors 'none'` is the
 *      single owner of the framing directive);
 *   5. the clickjacking guard (frame-ancestors 'none') and the
 *      nosniff/Referrer-Policy/Permissions-Policy set are present.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const OCI_CADDYFILE = readFileSync(
  path.join(REPO_ROOT, "deploy/oci/Caddyfile"),
  "utf8",
);

type HeaderSources = Awaited<ReturnType<NonNullable<typeof nextConfig.headers>>>;

async function appHeaders(): Promise<HeaderSources> {
  const headersFn = nextConfig.headers;
  expect(headersFn).toBeDefined();
  return await headersFn!();
}

describe("RT-007: app-layer security headers (next.config.ts headers())", () => {
  test("next.config defines a headers() block for all paths", async () => {
    const sources = await appHeaders();
    expect(sources).toHaveLength(1);
    expect(sources[0].source).toBe("/:path*");
    expect(sources[0].headers.length).toBeGreaterThan(0);
  });

  test("the header set matches the TLS Caddy profile (CSP byte-identical)", async () => {
    const sources = await appHeaders();
    const byKey = new Map(sources[0].headers.map((h) => [h.key, h.value]));

    const caddyCsp = OCI_CADDYFILE.match(/Content-Security-Policy\s+"([^"]+)"/);
    expect(caddyCsp).not.toBeNull();
    expect(byKey.get("Content-Security-Policy")).toBe(caddyCsp![1]);

    expect(byKey.get("X-Content-Type-Options")).toBe("nosniff");
    expect(byKey.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(byKey.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
  });

  test("no HSTS at the app layer (edge-owned, single owner per directive)", async () => {
    const sources = await appHeaders();
    const keys = sources[0].headers.map((h) => h.key);
    expect(keys).not.toContain("Strict-Transport-Security");
    expect(keys).not.toContain("X-Frame-Options");
  });

  test("frame-ancestors 'none' is present (clickjacking guard)", async () => {
    const sources = await appHeaders();
    const csp = sources[0].headers.find(
      (h) => h.key === "Content-Security-Policy",
    )?.value;
    expect(csp).toContain("frame-ancestors 'none'");
  });

  test("both Caddyfiles note the dual ownership (future-editor awareness)", () => {
    expect(OCI_CADDYFILE).toContain("RT-007");
    expect(
      readFileSync(path.join(REPO_ROOT, "docs/deploy/Caddyfile.tls"), "utf8"),
    ).toContain("RT-007");
  });
});
