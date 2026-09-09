import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../_lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/search?q=<min 2 chars>
 * Cross-entity search for the command palette:
 * devices (top 5), incidents (top 3), changes (top 3).
 */

const querySchema = z.object({
  q: z.string().trim().min(2, "Search needs at least 2 characters").max(120),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({ q: url.searchParams.get("q") ?? "" });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }

  const q = parsed.data.q;
  const contains = { contains: q };

  const [devices, incidents, changes] = await Promise.all([
    db.device.findMany({
      where: {
        OR: [
          { hostname: contains },
          { displayName: contains },
          { mgmtIp: contains },
        ],
      },
      orderBy: { hostname: "asc" },
      take: 5,
      select: { id: true, hostname: true, mgmtIp: true, status: true },
    }),
    db.incident.findMany({
      where: { OR: [{ number: contains }, { title: contains }] },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: {
        id: true,
        number: true,
        title: true,
        severity: true,
        status: true,
      },
    }),
    db.changeRequest.findMany({
      where: { OR: [{ number: contains }, { title: contains }] },
      orderBy: { createdAt: "desc" },
      take: 3,
      select: { id: true, number: true, title: true, status: true },
    }),
  ]);

  return ok({ devices, incidents, changes });
}
