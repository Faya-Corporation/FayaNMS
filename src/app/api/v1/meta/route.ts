import { db } from "@/lib/db";
import { ok } from "../_lib/api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/meta — lightweight reference data for filter bars
 * (vendors + sites). Kept tiny; consumed by device filters and pickers.
 */
export async function GET() {
  const [vendors, sites] = await Promise.all([
    db.vendor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, key: true, name: true },
    }),
    db.site.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
  ]);

  return ok({ vendors, sites });
}
