import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { GET } from "@/app/api/health/route";
import { db } from "../../src/lib/db";

/**
 * RT-028 (F-059) — /api/health readiness endpoint (DB connectivity →
 * 200/503) + the probe switch.
 *
 * The finding: every app probe (Dockerfile HEALTHCHECK, deploy/oci/
 * compose.yml app healthcheck, deploy/oci/health-check.sh) fetched the
 * marketing root page — "healthy" only proved the HTTP listener, not the
 * DB/auth wiring; a broken app showed green (pg_isready covers the DB
 * PROCESS only, not the app's connection path).
 *
 * Landed here: the readiness route (src/app/api/health/route.ts —
 * parameterized `SELECT 1` under a 3 s budget, no-store, no internals in
 * the failure body, server-side log with a correlation id) and all three
 * probes switched to it (deploy.sh's post-up gate delegates to
 * health-check.sh). e2e/browser boot waits may keep using `/` — they want
 * "server up", not "db up".
 *
 * Test style: DB-backed with env-fail-skip (like RT-015).
 *   - The healthy case runs the real route handler in THIS process against
 *     the dev DB (tests/_setup.ts URL);
 *   - the 503 case is subprocess/env-scoped: the Prisma client reads
 *     DATABASE_URL at construction, so the dead-DB path is proven by
 *     spawning tests/audit/rt028-dead-db-probe.ts (imports the SAME route
 *     module) with a DATABASE_URL pointing at a refused port.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const ROUTE_SOURCE = readFileSync(path.join(REPO_ROOT, "src/app/api/health/route.ts"), "utf8");

let dbUp = true;

beforeAll(async () => {
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    dbUp = false;
  }
});

describe("RT-028: /api/health readiness", () => {
  test("healthy when db reachable", async () => {
    if (!dbUp) {
      console.log("RT-028: DB unreachable — skipping healthy-path assertion");
      return;
    }
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.db).toBe("up");
    expect(body.service).toBe("fayanms-app");
    expect(typeof body.uptimeSec).toBe("number");
  });

  test("503 when db unreachable (dead-port subprocess, real route module)", () => {
    // Deterministic: a refused port fails immediately — no timing flake.
    const probe = Bun.spawnSync(
      ["bun", path.join(REPO_ROOT, "tests/audit/rt028-dead-db-probe.ts")],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          DATABASE_URL: "postgresql://fayanms:fayanms@127.0.0.1:1/fayanms",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(probe.exitCode).toBe(0);
    // Prisma's own error banner goes to STDOUT ahead of the probe's JSON —
    // extract the tagged result line rather than assuming stdout shape.
    const printed = probe.stdout.toString();
    const match = printed.match(/PROBE_RESULT:(\{.*\})/);
    expect(match).not.toBeNull();
    const result = JSON.parse(match![1]) as { status: number; body: string; cacheControl: string | null };
    // The negative case that justifies the whole RT:
    expect(result.status).toBe(503);
    expect(result.cacheControl).toBe("no-store");
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.db).toBe("down");
    expect(body.error).toBe("database unreachable");
    // Runtime proof that the failure envelope is EXACTLY the fixed shape —
    // stronger than any source-level regex (prisma banners go to the server
    // log, never into the response).
    expect(Object.keys(body).sort()).toEqual(["db", "error", "ok"]);
  });

  test("no internals in the failure body", () => {
    // Log-hygiene assertion: whatever the failure, the response string is a
    // fixed envelope — no URL/host/PG error text can appear (the route does
    // not interpolate the caught error into the body).
    expect(ROUTE_SOURCE).not.toMatch(/database URL|\$DATABASE_URL|connectionString/i);
    // The failure response is the fixed literal envelope (server-side detail
    // is logged under health_db_down, asserted below — never returned).
    expect(ROUTE_SOURCE).toContain('error: "database unreachable"');
    expect(ROUTE_SOURCE).not.toMatch(/NextResponse\.json\(\s*\{\s*ok: false[^}]*error\.(message|stack)/);
    // The caught detail goes to the server-side log, correlated (RT-027
    // discipline), never into NextResponse.json's first argument.
    expect(ROUTE_SOURCE).toContain("health_db_down");
    expect(ROUTE_SOURCE).toContain("correlationId");
  });

  test("route is fast and uncached", () => {
    expect(ROUTE_SOURCE).toContain('export const dynamic = "force-dynamic"');
    expect(ROUTE_SOURCE).toContain('"cache-control": "no-store"');
    // The probe budget is bounded and tighter than the callers' 5 s.
    expect(ROUTE_SOURCE).toMatch(/DB_PROBE_TIMEOUT_MS = 3_000/);
    // The query is the parameterized raw template (repo's allowed raw usage).
    expect(ROUTE_SOURCE).toContain("db.$queryRaw`SELECT 1`");
  });

  test("probes point at the readiness route", () => {
    // The contract that keeps the three probes from drifting back to `/`.
    const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
    const compose = readFileSync(path.join(REPO_ROOT, "deploy/oci/compose.yml"), "utf8");
    const healthCheck = readFileSync(path.join(REPO_ROOT, "deploy/oci/health-check.sh"), "utf8");
    for (const [name, text] of [
      ["Dockerfile", dockerfile],
      ["deploy/oci/compose.yml", compose],
      ["deploy/oci/health-check.sh", healthCheck],
    ] as const) {
      expect(
        text.includes("http://127.0.0.1:3000/api/health"),
        `${name} must probe the readiness route`
      ).toBe(true);
    }
    // And none of them probes the marketing root anymore.
    for (const [name, text] of [
      ["Dockerfile", dockerfile],
      ["deploy/oci/compose.yml", compose],
      ["deploy/oci/health-check.sh", healthCheck],
    ] as const) {
      expect(
        text.includes("fetch('http://127.0.0.1:3000/')") ||
          text.includes('fetch("http://127.0.0.1:3000/")'),
        `${name} must not probe the root page`
      ).toBe(false);
    }
  });
});
