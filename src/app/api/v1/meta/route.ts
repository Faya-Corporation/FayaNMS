import { db } from "@/lib/db";
import { ok } from "../_lib/api";

export const dynamic = "force-dynamic";

/** Friendly label per seeded role (no auth server yet — demo identity). */
const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  operator: "NOC Operator",
  engineer: "Network Engineer",
  auditor: "Auditor",
  manager: "Service Manager",
  viewer: "Viewer",
};

/**
 * GET /api/v1/meta — lightweight reference data for filter bars and
 * form pickers (vendors, sites, credential profiles). Consumed by the
 * device filters, the Add/Edit Device form and the Sites view.
 *
 * Task 4-b adds `users`: the 5 seeded accounts (id/name only + a
 * username-style key derived from the email local-part) powering the
 * "Act as" demo identity Selects on the approval surfaces. No emails are
 * exposed beyond the local-part (already public inside the demo lab).
 */
export async function GET() {
  const [vendors, sites, credentialProfiles, users] = await Promise.all([
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
    db.user.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, email: true, role: true },
    }),
  ]);

  return ok({
    vendors,
    sites,
    credentialProfiles,
    users: users.map((user) => ({
      id: user.id,
      name: user.name ?? user.email,
      username: user.email.split("@")[0] ?? user.id,
      roleLabel: ROLE_LABELS[user.role] ?? user.role,
    })),
  });
}
