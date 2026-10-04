/**
 * Open-findings batch 10 — F-029 (P3, BACKLOG order 1):
 * /admin/users GET returns full emails to ANY active user.
 *
 *   History: Task 7-a shipped the directory with a requireUser gate —
 *   "any active authenticated user may LIST" — so a viewer could enumerate
 *   every account's full email address. The remediation decision (the
 *   BACKLOG plan's named option): the FULL email directory is ROLE-gated
 *   to admin/auditor via requireRole(request, "admin", "auditor").
 *   Auditors keep their read-only visibility (they were the documented
 *   consumers); every other role's directory surface stays /meta/users —
 *   the alert assign/suppress picker that never exposes more than the
 *   email local-part (R69).
 *
 *   Non-goals (deliberate): /admin/roles GET stays any-active-session
 *   (role name catalog — no PII); the mutation plane keeps its admin
 *   gates; /meta/users is untouched.
 *
 * Same certified rig as batches 2-7 (tests/audit/open-findings-batch-{2..7}
 * .test.ts): REAL session tokens minted with the production next-auth/jwt
 * encoder (no mock.module — it is process-wide and poisons later suites).
 * Every identity these probes depend on is SELF-CONTAINED via the
 * rt012/rt014 ensure-helper pattern: the CI gate replays ONLY
 * `migrate deploy` (no demo seed), so the roles and users are upserted
 * here and never deleted.
 */

import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { mintServiceToken } from "../../src/lib/auth/service-auth";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

type Batch10User = {
  id: string;
  email: string;
  name: string | null;
  role: string;
};

const userCache = new Map<string, Batch10User>();

/** Self-contained role + user identity (the certified rt012/rt014 pattern). */
async function ensureBatch10User(role: string): Promise<Batch10User> {
  const cached = userCache.get(role);
  if (cached) return cached;
  const matrixEntry = ROLE_MATRIX.find((entry) => entry.name === role);
  if (!matrixEntry) throw new Error(`role ${role} missing from ROLE_MATRIX`);
  await db.role.upsert({
    where: { name: role },
    update: {},
    create: {
      name: role,
      description: matrixEntry.description,
      permissionsJson: JSON.stringify([...matrixEntry.permissions]),
    },
  });
  const email = `batch10-${role}@faya.local`;
  const user = await db.user.upsert({
    where: { email },
    update: { isActive: true },
    create: {
      email,
      name: `Batch10 ${role}`,
      role,
      isActive: true,
      passwordHash: "batch10-test-no-login",
    },
    select: { id: true, email: true, name: true, role: true },
  });
  userCache.set(role, user);
  return user;
}

async function mintSessionJwt(user: Batch10User): Promise<string> {
  return encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

/* ── request helpers (handler-level — the gate runs inside the handler) ── */

type GetFn = (headers: Record<string, string>) => Promise<Response>;

function flatGet(rel: string, query = ""): GetFn {
  return async (headers) => {
    const mod = await import(`../../src/app/api/v1/${rel}/route`);
    return mod.GET(
      new NextRequest(`http://app.local/api/v1/${rel}${query}`, { method: "GET", headers })
    );
  };
}

async function sessionHeaders(role: string): Promise<Record<string, string>> {
  const user = await ensureBatch10User(role);
  const token = await mintSessionJwt(user);
  return { Cookie: `next-auth.session-token=${token}` };
}

describe("F-029 (batch 10): /admin/users GET is admin/auditor-gated", () => {
  test("anonymous → 401 UNAUTHENTICATED (fail-closed unchanged)", async () => {
    const res = await flatGet("admin/users")({});
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("machine service JWT → 401 — the directory never trusts machine tokens", async () => {
    const token = mintServiceToken({
      issuer: "fayanms:worker",
      subject: "worker:batch10-directory-test",
      scopes: ["jobs"],
    });
    const res = await flatGet("admin/users")({ Authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("API-client opaque bearer → 401 — admin/* stays human-only (unwired)", async () => {
    const res = await flatGet("admin/users")({
      Authorization: `Bearer ${"b".repeat(43)}`,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("UNAUTHENTICATED");
  });

  test("viewer / operator / engineer / manager sessions → 403 RBAC_FORBIDDEN", async () => {
    for (const role of ["viewer", "operator", "engineer", "manager"]) {
      const res = await flatGet("admin/users")(await sessionHeaders(role));
      expect(res.status, role).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code, role).toBe("RBAC_FORBIDDEN");
    }
  });

  test("auditor session → 200 — read-only directory visibility preserved", async () => {
    const res = await flatGet("admin/users")(await sessionHeaders("auditor"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; data?: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("admin session → 200 with the full email directory intact", async () => {
    const res = await flatGet("admin/users")(await sessionHeaders("admin"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: Array<{ email?: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.data?.some((user) => user.email?.includes("@"))).toBe(true);
  });

  test("meta/users picker UNCHANGED for a non-privileged role (F-029 non-goal)", async () => {
    const res = await flatGet("meta/users")(await sessionHeaders("viewer"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      data?: { users?: Array<{ name?: string; username?: string }> };
    };
    expect(body.success).toBe(true);
    for (const user of body.data?.users ?? []) {
      expect(user.name, "picker name stays local-part/label").not.toContain("@");
      expect(user.username, "picker username stays local-part").not.toContain("@");
    }
  });
});
