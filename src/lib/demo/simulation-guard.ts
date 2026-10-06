/**
 * GA-4 (2026-10-06 re-audit, P0-R05/P1-O02) — simulation honesty gating.
 *
 * The re-audit is explicit: simulated operational surfaces (the HA failover
 * test, the collector rebalance APPLY) must not be exposed as real
 * infrastructure operations in a production posture. The repo already
 * labels them (DEMO DATA banners in src/lib/ha/topology.ts and
 * src/lib/collectors/distribution.ts); this guard turns the labels into
 * FAIL-CLOSED behavior:
 *
 *   - FAYANMS_DEMO_MODE=true  → the simulated surfaces run (the demo shell);
 *   - anything else           → 403 SIMULATION_DISABLED, always.
 *
 * Deliberately a REQUEST-TIME check (not a startup policy row): the demo
 * flag is a per-environment deployment posture, and the surface must die
 * the moment the flag is gone — no process restart ordering games.
 */

export const SIMULATION_DISABLED_CODE = "SIMULATION_DISABLED";

export function isDemoMode(): boolean {
  return (process.env.FAYANMS_DEMO_MODE ?? "").trim().toLowerCase() === "true";
}

/** The typed refusal every gated simulated surface returns. */
export function simulationDisabledFail(): {
  code: typeof SIMULATION_DISABLED_CODE;
  message: string;
  status: 403;
} {
  return {
    code: SIMULATION_DISABLED_CODE,
    message:
      "This surface is a DOCUMENTED SIMULATION (demo data, no real infrastructure effect). Set FAYANMS_DEMO_MODE=true to enable it in a demo environment; it is disabled in production postures.",
    status: 403,
  };
}
