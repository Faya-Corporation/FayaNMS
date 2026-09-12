/**
 * Next.js instrumentation hook (Phase 19 / audit SEC-004).
 *
 * register() runs exactly once per server process start, before any request
 * is served. It is the single chokepoint for the fail-closed startup
 * security policy: in production an insecure environment aborts boot here,
 * so a misconfigured deployment can never serve traffic.
 */
export async function register(): Promise<void> {
  // Imported lazily so the instrumentation hook itself stays dependency-light.
  const { enforceStartupSecurityPolicy } = await import(
    "@/lib/startup/security-policy"
  );
  enforceStartupSecurityPolicy();
}
