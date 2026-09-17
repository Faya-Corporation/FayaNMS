import { ok, requestContext } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { snapshotDetectionMetrics } from "@/lib/metrics/detection-metrics";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/metrics/detection — R50-T072 operational read surface for the
 * vendor auto-detection plane.
 *
 * Answers the roadmap's named counters verbatim (device_detection_*_total +
 * device_detection_duration_seconds) plus the per-code failureReasons
 * breakdown, via snapshotDetectionMetrics() — see
 * src/lib/metrics/detection-metrics.ts for the documented semantics
 * (per-INSTANCE, process-lifetime-since-boot; `since` stamps the window so
 * a multi-instance fleet is never read as one aggregate).
 *
 * Authorization: `metrics.read` (operator + engineer + manager; admin via
 * the wildcard — role-matrix.ts). Aggregates ONLY: the snapshot carries no
 * hostnames, credential ids, fingerprints, or actor identities — the
 * per-invocation evidence lives in the audit trail (DEVICE_VENDOR_
 * AUTODETECTED + the R50-T071 refusal events, readable via /api/v1/events).
 * Reads are therefore not audited themselves (aggregates, no operational
 * risk surface; consistent with the other metrics reads).
 */
export async function GET(request: Request) {
  try {
    await requirePermission(request, "metrics.read");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
  return ok(
    { metrics: snapshotDetectionMetrics() },
    { scope: "process", note: "Per-instance counters since process boot — not a fleet aggregate." },
    200,
    requestContext(request)
  );
}
