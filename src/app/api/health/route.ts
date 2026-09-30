import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * RT-028 (F-059) — /api/health is the container READINESS probe (deploy
 * gates and Docker recovery act on it), NOT a liveness endpoint.
 *
 * Semantics: 200 only when this process can actually query PostgreSQL; 503
 * otherwise. The previous probes fetched the marketing root page, which can
 * 200 while the app is functionally down — "healthy" must mean "the DB path
 * works", which pg_isready alone cannot prove (it covers the DB process,
 * not the app's connection path).
 *
 * Contract notes:
 *   - No session/CSRF required: this is a probe endpoint. It lives OUTSIDE
 *     the /api/v1 matcher (src/proxy.ts scopes middleware to /api/v1/:path*),
 *     so the proxy and its rate limiting are untouched here — probes are
 *     low-rate (30 s interval, 5 s timeout) by the healthchecks that call
 *     it, so a rate gate would only add flake.
 *   - Failure hygiene (RT-027 discipline): the response body never carries
 *     the DB URL, driver error text, or stack — the failure detail is logged
 *     server-side under a correlation id; the body only says
 *     "database unreachable".
 *   - Parameterized raw (`$queryRaw` template) is the repo's allowed raw
 *     usage; SELECT 1 has no user input by construction.
 *   - Probe migration point: Dockerfile HEALTHCHECK, deploy/oci/compose.yml
 *     app healthcheck and deploy/oci/health-check.sh (the deploy.sh post-up
 *     gate delegates to that script) all call THIS route. e2e/browser boot
 *     waits may keep using `/` — they want "server up", not "db up".
 */

/** Probe budget: fail faster than the 5 s probe timeouts in the callers. */
const DB_PROBE_TIMEOUT_MS = 3_000;

export async function GET(): Promise<Response> {
  const correlationId = randomUUID();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("database probe timeout")), DB_PROBE_TIMEOUT_MS);
        // A lost race must not keep the process (or a probe run) alive.
        timer.unref?.();
      }),
    ]);
    return NextResponse.json(
      {
        ok: true,
        service: "fayanms-app",
        db: "up",
        uptimeSec: Math.round(process.uptime()),
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    // Server-side detail only (may include driver text — the response must
    // not): one structured line, correlated for log searches.
    console.error(
      JSON.stringify({
        event: "health_db_down",
        correlationId,
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return NextResponse.json(
      { ok: false, db: "down", error: "database unreachable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
