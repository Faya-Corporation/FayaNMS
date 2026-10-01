import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { verifyAuditChain } from "@/lib/audit/chain";
import {
  ok,

} from "@/app/api/v1/_lib/api";
import { resolveAdminActor } from "@/lib/auth/acting-admin";
import { authErrorToFail } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/admin/audit-chain/verify (Task 7-b, RT-013)
 *
 * Walk the audit hash chain by its links over a TAIL-anchored window (the
 * NEWEST 5,000 rows), recomputing every hash. Response:
 *   { valid, verdict, checked, window: "FULL" | "TAIL", anchoredAt?,
 *     brokenAt?: { id, index, reason }, issues[] }
 * with reason ∈ "unhashed" | "prev-hash-mismatch" | "hash-mismatch".
 * window "TAIL" + anchoredAt report that the scan cap truncated the table
 * and which row the walk anchored at; a truncated walk caps the verdict at
 * PARTIALLY_VERIFIED. Rows whose hash is null (pre-chain events awaiting
 * backfill) are chain gaps and are reported as "unhashed".
 */
export async function GET(request: Request) {
  try {
    await resolveAdminActor(request);
    const result = await verifyAuditChain(db as unknown as PrismaClient);
    return ok(result, undefined, 200);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (authFail) return authFail;
    throw error;
  }
}
