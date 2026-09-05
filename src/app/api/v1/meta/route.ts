import { db } from "@/lib/db";
import { ok } from "../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/meta — lightweight reference data for filter bars and
 * form pickers (vendors, sites, credential profiles). Consumed by the
 * device filters, the Add/Edit Device form and the Sites view.
 */
export async function GET() {
  const [vendors, sites, credentialProfiles] = await Promise.all([
    db.vendor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, key: true, name: true },
    }),
    db.site.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    db.credentialProfile.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, type: true, username: true },
    }),
  ]);

  return ok({ vendors, sites, credentialProfiles });
}
