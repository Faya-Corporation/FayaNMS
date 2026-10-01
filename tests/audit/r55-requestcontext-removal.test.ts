import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * HC-3 (R55) — deprecated `RequestContext` removal (mechanical).
 *
 * Historic debt: the envelope builders in src/app/api/v1/_lib/api.ts used
 * to accept a trailing RequestContext argument that fed the (then
 * in-builder) rate limiter. SAFE-002 moved that gate pre-handler into the
 * proxy plane, so the argument became dead weight kept only "so existing
 * call sites compile" — ~50 plumbing sites across 40 route files, with a
 * tracked backlog note in api.ts.
 *
 * R55 retired it mechanically:
 *   - ok/fail/failWithMeta/failWithDetail no longer accept a `_ctx` param.
 *   - Every in-repo call site was removed (imports, inline trailing args,
 *     own-line trailing args, `const ctx = requestContext(request)`
 *     indirection).
 *   - The api.ts debt comment is retired; the shim (type + helper) stays
 *     exported ONLY as an inert no-op for external consumers — and these
 *     pins make that boundary machine-enforced: it cannot silently grow
 *     callers again.
 *
 * Envelope invariance is pinned at three levels: pure builder units, the
 * shim's own contract, and wire-level handler responses (requestId
 * stamping unchanged with zero per-call context).
 */

const REPO = join(import.meta.dir, "..", "..");
const SHIM_REL = "src/app/api/v1/_lib/api.ts";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRepo(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

/** Every .ts/.tsx file under src/ as repo-relative paths. */
function walkSrc(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
        out.push(p.slice(REPO.length + 1));
      }
    }
  };
  walk(join(REPO, "src"));
  return out;
}

describe("HC-3 — the shim surface stays exported but inert", () => {
  test("requestContext + RequestContext remain exported (compat contract)", () => {
    const api = readRepo(SHIM_REL);
    expect(api).toContain("export interface RequestContext {");
    expect(api).toContain("export function requestContext(_request?: Request): RequestContext {");
  });

  test("the helper is an inert no-op (returns {} with or without a request)", async () => {
    const { requestContext } = await import("@/app/api/v1/_lib/api");
    expect(requestContext()).toEqual({});
    expect(requestContext(new Request("http://localhost/api/v1/devices"))).toEqual({});
  });

  test("the api.ts debt comment is retired (HC-3 stamp replaces the backlog note)", () => {
    const api = readRepo(SHIM_REL);
    // The tracked-debt sentence is gone…
    expect(api).not.toContain("tracked as backlog");
    expect(api).not.toContain("Mechanical removal of the ~50 call sites");
    expect(api).not.toContain("@deprecated");
    // …replaced by the R55 retirement record.
    expect(api).toContain("HC-3 (R55)");
    // The builders carry no context parameter anymore — parameter syntax
    // `_ctx?:` must appear nowhere (the prose was reworded to keep this
    // assertion exact).
    expect(api).not.toContain("_ctx");
  });
});

describe("HC-3 — zero call-site references outside the shim", () => {
  test("sweep: no src/ file except _lib/api.ts mentions requestContext/RequestContext", () => {
    const files = walkSrc();
    // Sanity: the walk must see a realistic tree (guards against a silent
    // empty-walk false-pass).
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const rel of files) {
      if (rel === SHIM_REL) continue;
      const src = readRepo(rel);
      if (src.includes("requestContext") || src.includes("RequestContext")) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("sweep: the `_ctx` parameter token is gone from all of src/", () => {
    const offenders: string[] = [];
    for (const rel of walkSrc()) {
      if (readRepo(rel).includes("_ctx")) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the mechanical pass is observable in the tree: route files import only live helpers", () => {
    // Representative file-level proof (the sweep above is exhaustive):
    // devices route — the heaviest former user (14 references) — imports
    // the envelope helpers WITHOUT the shim.
    const devices = readRepo("src/app/api/v1/devices/route.ts");
    expect(devices).toContain('from "../_lib/api"');
    expect(devices).not.toContain("requestContext");
  });
});

describe("HC-3 — envelope invariance: builders are pure and unchanged", () => {
  test("ok() stamps requestId in meta + X-Request-Id header (no ctx needed)", async () => {
    const { ok } = await import("@/app/api/v1/_lib/api");
    const res = ok({ a: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { a: number };
      meta: { requestId: string };
    };
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ a: 1 });
    expect(body.meta.requestId).toMatch(UUID_RE);
    expect(res.headers.get("X-Request-Id")).toBe(body.meta.requestId);
  });

  test("ok() meta merge + custom status unchanged", async () => {
    const { ok } = await import("@/app/api/v1/_lib/api");
    const res = ok([1, 2, 3], { page: 1, total: 3 }, 201);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      meta: { page: number; total: number; requestId: string };
    };
    expect(body.meta.page).toBe(1);
    expect(body.meta.total).toBe(3);
    expect(body.meta.requestId).toMatch(UUID_RE);
  });

  test("fail() error envelope unchanged (code/message/meta.requestId + header)", async () => {
    const { fail } = await import("@/app/api/v1/_lib/api");
    const res = fail("INVALID_BODY", "broken", 400);
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string; message: string };
      meta: { requestId: string };
    };
    expect(body.success).toBe(false);
    expect(body.error).toEqual({ code: "INVALID_BODY", message: "broken" });
    expect(body.meta.requestId).toMatch(UUID_RE);
    expect(res.headers.get("X-Request-Id")).toBe(body.meta.requestId);
  });

  test("failWithMeta / failWithDetail keep their extra payloads", async () => {
    const { failWithMeta, failWithDetail } = await import("@/app/api/v1/_lib/api");
    const metaRes = failWithMeta("DETECT", "m", 400, { contractVersion: 1 });
    const metaBody = (await metaRes.json()) as {
      meta: { contractVersion: number; requestId: string };
    };
    expect(metaBody.meta.contractVersion).toBe(1);
    expect(metaBody.meta.requestId).toMatch(UUID_RE);

    const detailRes = failWithDetail("AI_BAD_RESPONSE", "m", 502, "raw");
    const detailBody = (await detailRes.json()) as {
      error: { code: string; detail?: unknown };
    };
    expect(detailBody.error.code).toBe("AI_BAD_RESPONSE");
    expect(detailBody.error.detail).toBe("raw");
  });
});

describe("HC-3 — wire-level: handlers answer with stamped envelopes, zero context", () => {
  test("devices POST with an unparseable body → 400 INVALID_BODY with requestId", async () => {
    const { POST } = await import("@/app/api/v1/devices/route");
    const res = await POST(
      new Request("http://localhost/api/v1/devices", {
        method: "POST",
        body: "not-json",
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string };
      meta: { requestId: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INVALID_BODY");
    expect(body.meta.requestId).toMatch(UUID_RE);
    expect(res.headers.get("X-Request-Id")).toBe(body.meta.requestId);
  });

  test("devices GET on the real DB → 200 ok() envelope with requestId (no ctx arg)", async () => {
    // F-008 phase 3: the devices GET is handler-session-gated, so this
    // envelope-stamping probe now authenticates like every other
    // session-minting test (the certified rt012/rt014 ensure-helper pattern
    // — the CI gate replays only `migrate deploy`, no demo seed). The
    // assertions below are UNCHANGED: they pin the envelope shape and the
    // requestId stamping, not the auth plane.
    const { db } = await import("@/lib/db");
    const { encode } = await import("next-auth/jwt");
    const { ROLE_MATRIX } = await import("@/lib/auth/role-matrix");
    const adminEntry = ROLE_MATRIX.find((role) => role.name === "admin");
    await db.role.upsert({
      where: { name: "admin" },
      update: {},
      create: {
        name: "admin",
        description: adminEntry?.description ?? "Full platform administration",
        permissionsJson: JSON.stringify(adminEntry?.permissions ?? ["*"]),
      },
    });
    const admin = await db.user.upsert({
      where: { email: "admin@faya.local" },
      update: { isActive: true },
      create: { email: "admin@faya.local", name: "HC3 Admin", role: "admin", isActive: true },
      select: { id: true, email: true, name: true, role: true },
    });
    const session = await encode({
      token: {
        id: admin.id,
        email: admin.email,
        name: admin.name ?? undefined,
        role: admin.role,
      },
      secret: process.env.NEXTAUTH_SECRET ?? "",
    });
    const { GET } = await import("@/app/api/v1/devices/route");
    const { NextRequest } = await import("next/server");
    // NextRequest (not a plain Request): next-auth v4's getToken reads
    // req.cookies / req.headers.cookie — a plain web Request exposes
    // neither, so the token would be invisible to the gate. The runtime
    // hands handlers a NextRequest; the probe matches that reality.
    const res = await GET(
      new NextRequest("http://localhost/api/v1/devices", {
        headers: { cookie: `next-auth.session-token=${session}` },
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: unknown[];
      meta: { requestId: string; total: number };
    };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.meta.requestId).toMatch(UUID_RE);
    expect(res.headers.get("X-Request-Id")).toBe(body.meta.requestId);
  });
});
