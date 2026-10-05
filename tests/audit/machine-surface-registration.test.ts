/**
 * Wave-11 F-2 (audit 15-a P4): the DEDICATED machine-surface registration
 * scan that src/proxy.ts step 3a has promised in its docstring since the
 * R61 wave — "tests/audit/machine-surface-registration.test.ts scans the
 * handler tree and asserts every service-authenticated route is covered by
 * the machine-surface rules above".
 *
 * Until now the referenced file did not exist: registration coverage was
 * enforced only by an incidental scan inside
 * tests/audit/post-register-audit-fixes.test.ts (plus static toContain
 * pins), so a future service-authenticated route that missed registration
 * could silently reappear — together with the wave-11 CSRF-gate subjects
 * (the dual-gate exact routes) that drift matters.
 *
 * The scan is pure SOURCE TEXT, same harness as the post-register pins:
 * proxy.ts is edge middleware and importing it would pull its module graph
 * into the suite, so MACHINE_EXACT_ROUTES is parsed from the proxy source
 * between its markers, and the handler tree is walked for service-principal
 * authentication call sites (authenticateServiceRequest /
 * requireServiceOrPermission). Pinned here:
 *
 *   1. the proxy still PROMISES this suite (the docstring reference cannot
 *      be deleted without deleting the scan);
 *   2. step 3a derives from MACHINE_EXACT_ROUTES plus the worker PREFIX
 *      branch (the derived-not-duplicated lockstep);
 *   3. every route file under src/app/api/v1 that authenticates a service
 *      principal resolves to the machine surface (prefix or exact set);
 *   4. the scan does not silently no-op to green (census floor);
 *   5. the three DUAL-GATE session-reachable mutation routes — the
 *      wave-11 CSRF-gate subjects — stay registered on the exact set.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

function read(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

const proxySrc = read("src/proxy.ts");

/** MACHINE_EXACT_ROUTES parsed from the proxy source (single source of truth). */
const exactRoutes: string[] = (() => {
  const start = proxySrc.indexOf("const MACHINE_EXACT_ROUTES");
  const end = proxySrc.indexOf("function isMachineSurface");
  if (start < 0 || end <= start) {
    throw new Error("MACHINE_EXACT_ROUTES block not found in src/proxy.ts");
  }
  const block = proxySrc.slice(start, end);
  return [...block.matchAll(/"(\/api\/v1\/[^"]+)"/g)].map((m) => m[1] as string);
})();

/**
 * Handler-tree scan: every route file under src/app/api/v1 whose source
 * authenticates a service principal, mapped to its route path
 * ("v1/worker/tick/route.ts" → "/api/v1/worker/tick").
 */
const serviceRoutes: string[] = (() => {
  const apiDir = join(REPO_ROOT, "src/app/api/v1");
  const files = readdirSync(apiDir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith("route.ts"));
  const routes: string[] = [];
  for (const file of files) {
    const src = readFileSync(join(apiDir, file), "utf8");
    if (
      src.includes("authenticateServiceRequest(") ||
      src.includes("requireServiceOrPermission(")
    ) {
      routes.push(("/api/v1/" + file).replace(/\/route\.ts$/, ""));
    }
  }
  return routes;
})();

/**
 * The DUAL-GATE exact routes: requireServiceOrPermission falls back to the
 * admin session when no service token authenticates — the session-reachable
 * mutations the wave-11 proxy CSRF gate (F-1) exists for.
 */
const DUAL_GATE_ROUTES = [
  "/api/v1/metrics/retention/prune",
  "/api/v1/metrics/rollup/aggregate",
  "/api/v1/protocol/queue/retention/prune",
] as const;

describe("machine-surface registration (the proxy docstring's promised scan)", () => {
  test("SOURCE PIN: the proxy promises this suite and derives step 3a from the set", () => {
    // The docstring reference is load-bearing: deleting the scan without
    // deleting the promise (or vice versa) fails here.
    expect(proxySrc).toContain("tests/audit/machine-surface-registration.test.ts");
    expect(proxySrc).toContain("MACHINE_EXACT_ROUTES.has(pathname)");
    expect(proxySrc).toContain('pathname.startsWith("/api/v1/worker/")');
  });

  test("REGISTRATION SCAN: every service-authenticated /api/v1 route is machine surface", () => {
    const exact = new Set(exactRoutes);
    for (const route of serviceRoutes) {
      const covered = route.startsWith("/api/v1/worker/") || exact.has(route);
      expect({ route, covered }).toEqual({ route, covered: true });
    }
  });

  test("the scan does NOT silently no-op (wave-4 census floor: >= 21 routes)", () => {
    expect(serviceRoutes.length).toBeGreaterThanOrEqual(21);
  });

  test("the exact set is pinned at its census size (10 routes, each registered once)", () => {
    expect(exactRoutes.length).toBe(10);
    for (const route of exactRoutes) {
      const occurrences = proxySrc.split(`"${route}"`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("the DUAL-GATE session-reachable mutation routes stay registered (CSRF-gate subjects)", () => {
    const exact = new Set(exactRoutes);
    for (const route of DUAL_GATE_ROUTES) {
      expect(exact.has(route)).toBe(true);
    }
  });
});
