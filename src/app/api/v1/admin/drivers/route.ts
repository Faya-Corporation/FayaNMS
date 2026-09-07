import { driverCatalog } from "@/lib/vendors/drivers";
import { ok, requestContext } from "../../_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/drivers (Task 7-b)
 *
 * Device driver catalog — a static derivation from the vendor adapter
 * registry (src/lib/vendors/drivers.ts). No DB rows: the adapters ARE the
 * drivers; this surface exposes the matrix the Device Drivers admin page
 * renders (vendor, config flavor, capability set, model flavors, notes).
 */
export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);
    return ok(
      {
        drivers: driverCatalog,
      },
      { total: driverCatalog.length },
      200,
      requestContext(request)
    );
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
