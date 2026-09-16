/**
 * Next.js instrumentation hook (Phase 19 / audit SEC-004).
 *
 * register() runs exactly once per server process start, before any request
 * is served. It is the single chokepoint for the fail-closed startup
 * security policy: in production an insecure environment aborts boot here,
 * so a misconfigured deployment can never serve traffic.
 */
export async function register(): Promise<void> {
  // Node-only chokepoint: the edge bundle of this hook is compiled too, and a
  // bare dynamic import still pulls security-policy → service-jwt →
  // node:crypto into the edge sandbox (Turbopack compile error). NEXT_RUNTIME
  // is statically replaced per runtime, so the edge build eliminates this
  // branch entirely and never bundles the node:crypto chain.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Imported lazily so the instrumentation hook itself stays dependency-light.
  const { enforceStartupSecurityPolicy } = await import(
    "@/lib/startup/security-policy"
  );
  enforceStartupSecurityPolicy();
}
