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
 *   - Probe memoization (wave-12 F-4, audit 18-b): the DB probe result is
 *     memoized in module scope for PROBE_CACHE_TTL_MS (1 second). The first
 *     hit in a TTL window executes the probe; every hit within the window
 *     reuses the cached {ok, db, error} snapshot (uptimeSec stays live,
 *     200/503 semantics exact, no-store kept) and concurrent cold hits
 *     share ONE in-flight probe instead of stampeding the pool. The route
 *     is anonymous by design (RT-027) and outside the proxy rate budget,
 *     so without the memo a sustained flood translated 1:1 into SELECT 1
 *     load (Prisma-pool contention + a free DB-up/down timing oracle);
 *     the memo caps the probe cost at ~1 query/second worst case. Failure
 *     detail is logged ONCE per EXECUTED probe — TTL-window cache hits do
 *     not re-log.
 */

/** Probe budget: fail faster than the 5 s probe timeouts in the callers. */
const DB_PROBE_TIMEOUT_MS = 3_000;

/**
 * Wave-12 F-4: the memoization window (see the docstring above). 1 s keeps
 * deploy-gate semantics instantaneous (a probe cycle is 30 s) while capping
 * the anonymous probe cost at ~1 query/second.
 */
const PROBE_CACHE_TTL_MS = 1_000;

/** What one probe learned (the detail is server-side only — never returned). */
type ProbeResult = { ok: true } | { ok: false; detail: string };

/** Module-scope memo: the {ok, db, error} snapshot + its wall-clock stamp. */
let probeCache: { at: number; result: ProbeResult } | null = null;

/** In-flight probe shared by concurrent cold hits (thundering-herd dedupe). */
let probeInFlight: Promise<ProbeResult> | null = null;

/** Execute the DB probe once; log failures server-side under a correlation id. */
async function runDbProbe(correlationId: string): Promise<ProbeResult> {
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
    return { ok: true };
  } catch (error) {
    // Server-side detail only (may include driver text — the response must
    // not): one structured line, correlated for log searches.
    const detail = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: "health_db_down",
        correlationId,
        detail,
      }),
    );
    return { ok: false, detail };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The memoized snapshot when fresh, or null when empty/expired. */
function freshProbeSnapshot(now: number): ProbeResult | null {
  if (!probeCache) return null;
  if (now - probeCache.at >= PROBE_CACHE_TTL_MS) return null;
  return probeCache.result;
}

export async function GET(): Promise<Response> {
  const correlationId = randomUUID();
  let result = freshProbeSnapshot(Date.now());
  if (!result) {
    // Cold window: start ONE probe (shared by every concurrent hit) and
    // memoize the snapshot for the next PROBE_CACHE_TTL_MS.
    if (!probeInFlight) {
      probeInFlight = runDbProbe(correlationId)
        .then((probed) => {
          probeCache = { at: Date.now(), result: probed };
          return probed;
        })
        .finally(() => {
          probeInFlight = null;
        });
    }
    result = await probeInFlight;
  }

  if (result.ok) {
    return NextResponse.json(
      {
        ok: true,
        service: "fayanms-app",
        db: "up",
        uptimeSec: Math.round(process.uptime()),
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: false, db: "down", error: "database unreachable" },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}
