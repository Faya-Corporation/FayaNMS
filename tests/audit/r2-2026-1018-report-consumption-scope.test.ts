import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";

/**
 * FNM-2026-104 (2026-10-18 independent re-audit, Wave R2) — report
 * CONSUMPTION scoping. GA-2 froze the creation scope; this suite pins the
 * read side: a site-limited session can neither list, download, mutate,
 * delete, nor run-now a report surface whose frozen scope exceeds its own.
 * Disclosure is not an authorization boundary.
 *
 * Semantics under test (set containment on frozen site codes):
 *   wildcard viewer → everything; wildcard ARTIFACT → wildcard viewers
 *   only; sites artifact A → viewers with A ⊆ scope; deny-all artifact
 *   (empty by construction) → everyone; a run whose schedule is deleted
 *   (scope unknowable) → wildcard viewers only, fail-closed.
 */

const RUN = randomUUID().slice(0, 8);
const PREFIX = `r2${RUN}`;
const SITE_A = `R2A${RUN}`;
const SITE_B = `R2B${RUN}`;

const USER1_EMAIL = `${PREFIX}-wildcard@faya.local`; // wildcard admin
const USER2_EMAIL = `${PREFIX}-siteA@faya.local`;    // site-A admin
const USER3_EMAIL = `${PREFIX}-siteB@faya.local`;    // site-B admin

let user1Id = "";
let user2Id = "";
let user3Id = "";

const cleanupIds: { schedule: string[]; job: string[]; user: string[]; site: string[]; org: string[] } = {
  schedule: [], job: [], user: [], site: [], org: [],
};

type SessionShape = { id: string; email: string; name: string | null; role: string; sites?: unknown };

async function mintSessionJwt(user: SessionShape): Promise<string> {
  return encode({
    token: {
      id: user.id,
      email: user.email,
      name: user.name ?? undefined,
      role: user.role,
      ...(user.sites !== undefined ? { sites: user.sites } : {}),
    },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

function cookieGet(url: string, jwt: string): NextRequest {
  return new NextRequest(url, {
    headers: { cookie: `next-auth.session-token=${jwt}` },
  });
}

function jsonRequest(method: string, url: string, jwt: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "content-type": "application/json",
      cookie: `next-auth.session-token=${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

/** Minimal valid stored artifact for the download route. */
function artifactJson(reportType: string): string {
  return JSON.stringify({
    reportType,
    generatedAt: new Date().toISOString(),
    range: "test",
    columns: [{ key: "k", label: "K" }],
    rows: [{ k: "v" }],
  });
}

let schWildcard = ""; // scopeJson null → fleet-wide artifact
let schA = "";        // scopeJson ["A"]
let schB = "";        // scopeJson ["B"]
let schDeny = "";     // scopeJson "[]"
let runWildcard = "";
let runA = "";
let runB = "";
let runDeny = "";
let runDeleted = "";

beforeAll(async () => {
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
  for (const [email, sites, ref] of [
    [USER1_EMAIL, undefined, "u1"],
    [USER2_EMAIL, [SITE_A], "u2"],
    [USER3_EMAIL, [SITE_B], "u3"],
  ] as const) {
    const u = await db.user.create({
      data: { email, name: `R2 ${ref}`, role: "admin", isActive: true },
      select: { id: true },
    });
    cleanupIds.user.push(u.id);
    if (ref === "u1") user1Id = u.id;
    if (ref === "u2") user2Id = u.id;
    if (ref === "u3") user3Id = u.id;
  }

  const org = await db.organization.create({ data: { name: `${PREFIX}-org` } });
  cleanupIds.org.push(org.id);
  await db.site.create({ data: { name: `R2 A ${RUN}`, code: SITE_A, organizationId: org.id } });
  await db.site.create({ data: { name: `R2 B ${RUN}`, code: SITE_B, organizationId: org.id } });

  const mk = async (name: string, scopeJson: string | null) =>
    db.reportSchedule.create({
      data: {
        name,
        reportType: "AVAILABILITY",
        frequency: "WEEKLY",
        format: "PDF",
        recipientsJson: JSON.stringify([`${PREFIX}@faya.local`]),
        scopeJson,
        isActive: false,
      },
      select: { id: true },
    });
  schWildcard = (await mk(`${PREFIX}-wild`, null)).id;
  schA = (await mk(`${PREFIX}-a`, JSON.stringify([SITE_A]))).id;
  schB = (await mk(`${PREFIX}-b`, JSON.stringify([SITE_B]))).id;
  schDeny = (await mk(`${PREFIX}-deny`, "[]")).id;
  cleanupIds.schedule.push(schWildcard, schA, schB, schDeny);

  const mkRun = async (scheduleId: string) =>
    db.jobExecution.create({
      data: {
        type: "REPORT_RUN",
        targetType: "REPORT_SCHEDULE",
        targetId: scheduleId,
        status: "SUCCEEDED",
        progress: 100,
        priority: 5,
        correlationId: `REP-${randomUUID().slice(0, 8).toUpperCase()}`,
        payloadJson: JSON.stringify({ scheduleId, scheduleName: "r2", triggeredBy: "TEST" }),
        resultJson: artifactJson("AVAILABILITY"),
      },
      select: { id: true },
    });
  runWildcard = (await mkRun(schWildcard)).id;
  runA = (await mkRun(schA)).id;
  runB = (await mkRun(schB)).id;
  runDeny = (await mkRun(schDeny)).id;
  cleanupIds.job.push(runWildcard, runA, runB, runDeny);

  // A run whose schedule will be deleted → scope unknowable.
  const doomed = await mk(`${PREFIX}-doomed`, JSON.stringify([SITE_A]));
  runDeleted = (await mkRun(doomed.id)).id;
  cleanupIds.job.push(runDeleted);
  await db.reportSchedule.delete({ where: { id: doomed.id } });
});

afterAll(async () => {
  await db.jobExecution.deleteMany({ where: { id: { in: cleanupIds.job } } });
  await db.reportSchedule.deleteMany({ where: { id: { in: cleanupIds.schedule } } });
  await db.site.deleteMany({ where: { id: { in: cleanupIds.site } } });
  await db.user.deleteMany({ where: { id: { in: cleanupIds.user } } });
  await db.organization.deleteMany({ where: { id: { in: cleanupIds.org } } });
});

const RUNS_URL = "http://app.local/api/v1/reports/runs";
const SCHEDULES_URL = "http://app.local/api/v1/reports/schedules";

async function user1Jwt() {
  return mintSessionJwt({ id: user1Id, email: USER1_EMAIL, name: "u1", role: "admin" });
}
async function user2Jwt() {
  return mintSessionJwt({ id: user2Id, email: USER2_EMAIL, name: "u2", role: "admin", sites: [SITE_A] });
}
async function user3Jwt() {
  return mintSessionJwt({ id: user3Id, email: USER3_EMAIL, name: "u3", role: "admin", sites: [SITE_B] });
}

type Envelope = { success?: boolean; data?: unknown; meta?: Record<string, unknown>; error?: { code?: string } };

async function bodyOf(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}

describe("FNM-2026-104 — runs history is scope-filtered", () => {
  test("wildcard viewer sees every run", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/route");
    const res = await GET(cookieGet(`${RUNS_URL}?pageSize=100`, await user1Jwt()));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const ids = (body.data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(runWildcard);
    expect(ids).toContain(runA);
    expect(ids).toContain(runB);
    expect(ids).toContain(runDeleted);
  });

  test("site-A viewer sees in-scope + deny-all runs; NOT wildcard/scope-B/deleted-schedule runs", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/route");
    const res = await GET(cookieGet(`${RUNS_URL}?pageSize=100`, await user2Jwt()));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const ids = (body.data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(runA);
    expect(ids).toContain(runDeny);
    expect(ids).not.toContain(runWildcard);
    expect(ids).not.toContain(runB);
    expect(ids).not.toContain(runDeleted);
  });

  test("site-B viewer is symmetric (sees B, not A)", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/route");
    const res = await GET(cookieGet(`${RUNS_URL}?pageSize=100`, await user3Jwt()));
    const body = await bodyOf(res);
    const ids = (body.data as { id: string }[]).map((r) => r.id);
    expect(ids).toContain(runB);
    expect(ids).not.toContain(runA);
  });

  test("the meta counters honor the scope filter", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/route");
    const res = await GET(cookieGet(`${RUNS_URL}?pageSize=100`, await user2Jwt()));
    const body = await bodyOf(res);
    expect(body.meta?.total).toBe((body.data as unknown[]).length);
  });
});

describe("FNM-2026-104 — downloads are scope-gated", () => {
  test("site-A downloads its own-scope artifact", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");
    const res = await GET(
      cookieGet(`http://app.local/api/v1/reports/runs/${runA}/download?format=CSV`, await user2Jwt()),
      { params: Promise.resolve({ id: runA }) } as never
    );
    expect(res.status).toBe(200);
  });

  test("site-A downloads a deny-all artifact (it contains no data)", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");
    const res = await GET(
      cookieGet(`http://app.local/api/v1/reports/runs/${runDeny}/download?format=CSV`, await user2Jwt()),
      { params: Promise.resolve({ id: runDeny }) } as never
    );
    expect(res.status).toBe(200);
  });

  test("site-A CANNOT download a scope-B artifact → 403 REPORT_SCOPE_FORBIDDEN", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");
    const res = await GET(
      cookieGet(`http://app.local/api/v1/reports/runs/${runB}/download?format=CSV`, await user2Jwt()),
      { params: Promise.resolve({ id: runB }) } as never
    );
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("REPORT_SCOPE_FORBIDDEN");
  });

  test("site-A CANNOT download a wildcard (fleet-wide) artifact → 403", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");
    const res = await GET(
      cookieGet(`http://app.local/api/v1/reports/runs/${runWildcard}/download?format=CSV`, await user2Jwt()),
      { params: Promise.resolve({ id: runWildcard }) } as never
    );
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("REPORT_SCOPE_FORBIDDEN");
  });

  test("a run whose schedule is deleted downloads ONLY for the wildcard viewer (fail-closed)", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");
    const denied = await GET(
      cookieGet(`http://app.local/api/v1/reports/runs/${runDeleted}/download?format=CSV`, await user2Jwt()),
      { params: Promise.resolve({ id: runDeleted }) } as never
    );
    expect(denied.status).toBe(403);
    const allowed = await GET(
      cookieGet(`http://app.local/api/v1/reports/runs/${runDeleted}/download?format=CSV`, await user1Jwt()),
      { params: Promise.resolve({ id: runDeleted }) } as never
    );
    expect(allowed.status).toBe(200);
  });

  test("the wildcard viewer downloads everything (unchanged admin behavior)", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/runs/[id]/download/route");
    for (const id of [runWildcard, runA, runB, runDeny]) {
      const res = await GET(
        cookieGet(`http://app.local/api/v1/reports/runs/${id}/download?format=CSV`, await user1Jwt()),
        { params: Promise.resolve({ id }) } as never
      );
      expect(res.status).toBe(200);
    }
  });
});

describe("FNM-2026-104 — schedule list and mutations are scope-gated", () => {
  test("site-A viewer lists only in-scope + deny-all schedules", async () => {
    const { GET } = await import("../../src/app/api/v1/reports/schedules/route");
    const res = await GET(cookieGet(`${SCHEDULES_URL}?pageSize=100`, await user2Jwt()));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const ids = (body.data as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(schA);
    expect(ids).toContain(schDeny);
    expect(ids).not.toContain(schWildcard);
    expect(ids).not.toContain(schB);
  });

  test("site-A CANNOT PATCH a scope-B schedule → 403 (recipient hijack blocked)", async () => {
    const { PATCH } = await import("../../src/app/api/v1/reports/schedules/[id]/route");
    const res = await PATCH(
      jsonRequest("PATCH", `${SCHEDULES_URL}/${schB}`, await user2Jwt(), { name: "hijacked" }),
      { params: Promise.resolve({ id: schB }) } as never
    );
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error?.code).toBe("REPORT_SCOPE_FORBIDDEN");
  });

  test("site-A PATCHes its own schedule normally", async () => {
    const { PATCH } = await import("../../src/app/api/v1/reports/schedules/[id]/route");
    const res = await PATCH(
      jsonRequest("PATCH", `${SCHEDULES_URL}/${schA}`, await user2Jwt(), { name: `${PREFIX}-a-renamed` }),
      { params: Promise.resolve({ id: schA }) } as never
    );
    expect(res.status).toBe(200);
  });

  test("site-A CANNOT DELETE a scope-B schedule → 403", async () => {
    const { DELETE } = await import("../../src/app/api/v1/reports/schedules/[id]/route");
    const res = await DELETE(
      jsonRequest("DELETE", `${SCHEDULES_URL}/${schB}`, await user2Jwt(), undefined),
      { params: Promise.resolve({ id: schB }) } as never
    );
    expect(res.status).toBe(403);
    const still = await db.reportSchedule.findUnique({ where: { id: schB }, select: { id: true } });
    expect(still).not.toBeNull();
  });

  test("run-now on a broader-scope schedule → 403; on its own scope → queued", async () => {
    const { POST } = await import("../../src/app/api/v1/reports/schedules/[id]/run/route");
    const denied = await POST(
      jsonRequest("POST", `${SCHEDULES_URL}/${schB}/run`, await user2Jwt(), {}),
      { params: Promise.resolve({ id: schB }) } as never
    );
    expect(denied.status).toBe(403);
    expect((await bodyOf(denied)).error?.code).toBe("REPORT_SCOPE_FORBIDDEN");

    const queued = await POST(
      jsonRequest("POST", `${SCHEDULES_URL}/${schA}/run`, await user2Jwt(), {}),
      { params: Promise.resolve({ id: schA }) } as never
    );
    expect(queued.status).toBe(201);
    const body = await bodyOf(queued);
    const jobId =
      ((body.data as { job?: { id?: string } })?.job?.id) ??
      ((body.data as { id?: string })?.id ?? "");
    if (jobId) cleanupIds.job.push(jobId);
  });
});
