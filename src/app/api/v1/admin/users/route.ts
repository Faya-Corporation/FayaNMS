import { z } from "zod";
import { Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { hashPassword, validatePasswordPolicy } from "@/lib/auth/password";
import { USER_ROLES } from "@/lib/auth/roles";
import {
  requireRole,
  authErrorToFail,
} from "@/lib/auth/session";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
  pageMeta,
  paginationSchema,
} from "../../_lib/api";

export const dynamic = "force-dynamic";

/**
 * /api/v1/admin/users (Task 7-a) — identity administration.
 *
 * GET  — paginated user list (id/email/name/role/isActive/createdAt).
 *        passwordHash is NEVER selected, let alone serialized.
 *        q filters email/name contains; meta carries role facet counts.
 *        F-029 (batch-10): the full email directory is ROLE-gated to
 *        admin/auditor via requireRole — the previous requireUser gate
 *        let EVERY active user (viewer included) enumerate full emails.
 *        Non-privileged roles keep their directory surface at
 *        /meta/users (local-part picker only, no full emails).
 * POST — create a user (admin-only). Password arrives as plaintext over the
 *        request and is immediately scrypt-hashed; only the hash is stored.
 *        F-034 phase 1: the role-aware password policy (privileged min
 *        length + offline common-password denylist) is enforced here.
 *        Audited USER_CREATED (correlationId USR-XXXXXX).
 *
 * All responses use the standard _lib envelope.
 */

const listSchema = paginationSchema.extend({
  q: z.string().trim().max(120).optional(),
});

const createSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("email must be a valid address")
    .max(160),
  name: z.string().trim().min(1, "name is required").max(80),
  role: z.enum(USER_ROLES).default("viewer"),
  isActive: z.boolean().default(true),
  password: z
    .string()
    .min(8, "password must be at least 8 characters")
    .max(128),
});

export async function GET(request: Request) {
  try {
    // F-029 (batch-10): full email directory → admin/auditor only.
    await requireRole(request, "admin", "auditor");
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  const url = new URL(request.url);
  const parsed = listSchema.safeParse({
    page: url.searchParams.get("page") ?? undefined,
    pageSize: url.searchParams.get("pageSize") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { page, pageSize, q } = parsed.data;

  const where: Prisma.UserWhereInput = q
    ? {
        OR: [
          { email: { contains: q } },
          { name: { contains: q } },
        ],
      }
    : {};

  const [users, total, activeCount, roleGroups] = await Promise.all([
    db.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.user.count({ where }),
    db.user.count({ where: { ...where, isActive: true } }),
    db.user.groupBy({
      by: ["role"],
      _count: { _all: true },
      where,
    }),
  ]);

  const byRole: Record<string, number> = {};
  for (const group of roleGroups) {
    byRole[group.role] = group._count._all;
  }

  return ok(
    users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt.toISOString(),
    })),
    {
      ...pageMeta(page, pageSize, total),
      counts: { total, active: activeCount, byRole },
    }
  );
}

export async function POST(request: Request) {
  let actor;
  try {
    actor = await requireRole(request, "admin");
  } catch (error) {
    const envelope = authErrorToFail(error);
    if (envelope) return envelope;
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const data = parsed.data;

  const existing = await db.user.findUnique({
    where: { email: data.email },
    select: { id: true },
  });
  if (existing) {
    return fail(
      "USER_EMAIL_TAKEN",
      `A user with email "${data.email}" already exists`,
      409
    );
  }

  // F-034 phase 1: role-aware password policy at creation time — the
  // created account's own role decides the bar (privileged roles answer
  // PASSWORD_TOO_SHORT_FOR_ROLE; every role answers PASSWORD_DENYLISTED on
  // a common password).
  const policyIssue = validatePasswordPolicy(data.password, data.role);
  if (policyIssue) {
    return fail(policyIssue.code, policyIssue.message, 400);
  }

  const passwordHash = await hashPassword(data.password);
  const correlationId = newCorrelationId("USR");

  const user = await db.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email: data.email,
        name: data.name,
        role: data.role,
        isActive: data.isActive,
        passwordHash,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: actor.id,
        actorName: actor.name ?? actor.email,
        action: "USER_CREATED",
        resourceType: "User",
        resourceId: created.id,
        resourceLabel: created.email,
        result: "SUCCESS",
        correlationId,
        afterJson: JSON.stringify({
          email: created.email,
          name: created.name,
          role: created.role,
          isActive: created.isActive,
        }),
      },
    });
    return created;
  });

  return ok(
    {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt.toISOString(),
      },
    },
    { correlationId },
    201
  );
}
