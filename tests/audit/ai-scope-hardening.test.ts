/**
 * Wave-9 AI-plane scope hardening (audit 9-b F-1 / task 10-b-1, WB-1).
 *
 * The four /api/v1/ai routes used to hand-roll their queries with ZERO
 * F-031 composition — sites-limited sessions retrieved cross-scope
 * device/incident/change/job data through the AI plane while the direct
 * routes hid it. The migration composes the central primitives:
 *
 *   - ai/query executors: scopedDeviceWhere on every device-derived leg;
 *     `site.code IN (…)` on the incident/change site relations (the
 *     dashboard's certified shape); jobs device-keyed via
 *     targetType="DEVICE" AND targetId IN (scoped device ids) because
 *     JobExecution has no device FK; the NL plan's site filter intersects
 *     the session scope via the same AND (out-of-scope plan site → empty).
 *   - ai/assist + ai/rca-draft: buildDeviceContext/buildIncidentContext
 *     fuse sessionAllowsSite into the not-found branch → the route's
 *     EXISTING 404 envelope (fused-404 — an out-of-scope resource is
 *     indistinguishable from a nonexistent one).
 *   - ai/change-draft: the grounding inventory is scopedDeviceWhere-composed
 *     and take-capped; an out-of-scope hostname grounds exactly like an
 *     unknown one (dropped — no match/no-match existence leak).
 *
 * Pinned with the batch-25 certified rig (REAL next-auth JWTs from the
 * production `encode`, synthetic fixtures with unique w9ai-<rand> suffixes,
 * surgical afterAll cleanup). Route-level pins cover the 404 paths that
 * never reach the LLM; the executor/inventory pins call the exported
 * deterministic pieces directly (the POST handlers are LLM-gated — stage 1
 * needs a completion — so route-level behavioral pins for them are
 * impractical without module mocking, which this suite deliberately avoids
 * per the established no-mock.module convention).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import {
  executeChanges,
  executeIncidents,
  executeInventory,
  executeJobs,
  executePredictive,
  executeSummary,
  type AiQueryPlan,
} from "../../src/app/api/v1/ai/query/route";
import {
  groundDeviceHostnames,
  loadChangeDraftInventory,
} from "../../src/app/api/v1/ai/change-draft/route";

/* ── fixtures (unique w9ai-<rand> suffixes, reclaimed in afterAll) ────── */

const RUN = Math.random().toString(36).slice(2, 8).toUpperCase();
const PREFIX = "w9ai-";
const ORG_NAME = `${PREFIX}org-${RUN}`;
const SITE_A_CODE = `W9A-${RUN}`; // the session's IN-scope site
const SITE_B_CODE = `W9B-${RUN}`; // the out-of-scope site
const HOST_A = `${PREFIX}dev-a-${RUN.toLowerCase()}`; // device @ site A
const HOST_B = `${PREFIX}dev-b-${RUN.toLowerCase()}`; // device @ site B
const ADMIN_EMAIL = `${PREFIX}admin-${RUN.toLowerCase()}@faya.local`;
const INC_B_NUMBER = `INC-9W-${RUN}`;
const CHG_B_NUMBER = `CHG-9W-${RUN}`;
const JOB_A_CORR = `JOB-9WA-${RUN}`; // CONFIG_BACKUP → device A (in scope)
const JOB_B_CORR = `JOB-9WB-${RUN}`; // CONFIG_BACKUP → device B (out of scope)
const JOB_C_CORR = `JOB-9WC-${RUN}`; // DISCOVERY, no device target

const testStartedAt = new Date();

let orgId = "";
let siteAId = "";
let siteBId = "";
let vendorId = "";
let deviceAId = "";
let deviceBId = "";
let adminId = "";
let incidentBId = "";
let changeBId = "";
let alertBId = "";
const jobIds: string[] = [];

type SessionShape = { id: string; email: string; name: string | null; role: string; sites?: unknown };

/** The certified rt012/batch-3 session-mint helper (real next-auth encode). */
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

async function adminJwt(sites?: unknown): Promise<string> {
  const claims: SessionShape = {
    id: adminId,
    email: ADMIN_EMAIL,
    name: "W9 AI Scope Admin",
    role: "admin",
  };
  if (sites !== undefined) claims.sites = sites;
  return mintSessionJwt(claims);
}

function postRequest(url: string, jwt: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `next-auth.session-token=${jwt}`,
    },
    body: JSON.stringify(body),
  });
}

/**
 * The _lib fail() envelope carries a per-request meta.requestId — strip it
 * before comparing two responses so "byte-identical envelope" means the
 * stable shape (success/error/meta-presence), not the ephemeral id.
 */
function stableEnvelope(body: {
  success: boolean;
  error: { code: string; message: string };
  meta?: { requestId?: string };
}): unknown {
  expect(typeof body.meta?.requestId).toBe("string");
  const clone = JSON.parse(JSON.stringify(body)) as {
    meta?: { requestId?: string };
  };
  delete clone.meta?.requestId;
  return clone;
}

/** Empty plan filters (the POST body's normalized no-filter shape). */
function noFilters(): AiQueryPlan {
  return {
    intent: "inventory",
    site: null,
    vendor: null,
    severity: null,
    status: null,
    hostnameLike: null,
    limit: null,
  };
}

beforeAll(async () => {
  // The CI gate replays ONLY `migrate deploy` (no demo seed): upsert the
  // admin Role from ROLE_MATRIX — the certified batch-25 pattern.
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
  const admin = await db.user.create({
    data: { email: ADMIN_EMAIL, name: "W9 AI Scope Admin", role: "admin", isActive: true },
    select: { id: true },
  });
  adminId = admin.id;

  const org = await db.organization.create({ data: { name: ORG_NAME } });
  orgId = org.id;
  const siteA = await db.site.create({
    data: { name: `W9 AI Site A ${RUN}`, code: SITE_A_CODE, organizationId: orgId },
  });
  siteAId = siteA.id;
  const siteB = await db.site.create({
    data: { name: `W9 AI Site B ${RUN}`, code: SITE_B_CODE, organizationId: orgId },
  });
  siteBId = siteB.id;

  const vendor = await db.vendor.create({
    data: { key: `${PREFIX}vendor-${RUN}`, name: `W9 AI Vendor ${RUN}`, adapterKey: "generic" },
  });
  vendorId = vendor.id;

  const devA = await db.device.create({
    data: { hostname: HOST_A, mgmtIp: "192.0.2.91", vendorId, siteId: siteAId, status: "ONLINE" },
  });
  deviceAId = devA.id;
  const devB = await db.device.create({
    data: { hostname: HOST_B, mgmtIp: "192.0.2.92", vendorId, siteId: siteBId, status: "ONLINE" },
  });
  deviceBId = devB.id;

  // Open incident at the OUT-of-scope site (SEV1 → sorts first under the
  // executor's severity-asc/createdAt-desc order, so the wildcard leg
  // always surfaces it within the 10-row take).
  const incident = await db.incident.create({
    data: {
      number: INC_B_NUMBER,
      title: `W9 AI cross-scope incident ${RUN}`,
      severity: "SEV1",
      status: "NEW",
      source: "MANUAL",
      siteId: siteBId,
    },
  });
  incidentBId = incident.id;

  const change = await db.changeRequest.create({
    data: {
      number: CHG_B_NUMBER,
      title: `W9 AI cross-scope change ${RUN}`,
      status: "DRAFT",
      requesterId: adminId,
      siteId: siteBId,
    },
  });
  changeBId = change.id;

  // Active alert pressure on the OUT-of-scope device (predictive leg).
  const alert = await db.alert.create({
    data: {
      deviceId: deviceBId,
      severity: "HIGH",
      status: "ACTIVE",
      message: `W9 AI scope fixture alert ${RUN}`,
    },
  });
  alertBId = alert.id;

  // Device-keyed jobs: A in scope, B out of scope, C with no device target.
  const jobA = await db.jobExecution.create({
    data: {
      type: "CONFIG_BACKUP",
      targetType: "DEVICE",
      targetId: deviceAId,
      status: "SUCCEEDED",
      correlationId: JOB_A_CORR,
    },
  });
  jobIds.push(jobA.id);
  const jobB = await db.jobExecution.create({
    data: {
      type: "CONFIG_BACKUP",
      targetType: "DEVICE",
      targetId: deviceBId,
      status: "FAILED",
      correlationId: JOB_B_CORR,
    },
  });
  jobIds.push(jobB.id);
  const jobC = await db.jobExecution.create({
    data: {
      type: "DISCOVERY",
      status: "SUCCEEDED",
      correlationId: JOB_C_CORR,
      resultJson: JSON.stringify({ candidates: [] }),
    },
  });
  jobIds.push(jobC.id);

  expect(deviceAId.length).toBeGreaterThan(0);
});

afterAll(async () => {
  // Surgical cleanup in FK order — every fixture row this suite created,
  // nothing else.
  await db.alert.deleteMany({ where: { id: alertBId } });
  await db.jobExecution.deleteMany({ where: { id: { in: jobIds } } });
  await db.changeRequest.deleteMany({ where: { id: changeBId } });
  await db.incident.deleteMany({ where: { id: incidentBId } });
  await db.device.deleteMany({ where: { id: { in: [deviceAId, deviceBId] } } });
  await db.site.deleteMany({ where: { id: { in: [siteAId, siteBId].filter(Boolean) } } });
  await db.organization.deleteMany({ where: { id: orgId } });
  await db.vendor.deleteMany({ where: { id: vendorId } });
  await db.user.deleteMany({ where: { id: adminId } });
});

/* ── (a) ai/query executors honor the session scope ───────────────────── */

describe("wave9 ai/query: executors compose the session site scope", () => {
  test("inventory: a sites-limited session sees its device, never the cross-scope one", async () => {
    // hostnameLike narrows to this suite's fixtures (the wildcard path alone
    // returns the demo fleet's first 10 rows); the scope must still cut the
    // cross-scope fixture out of the matched set.
    const scoped = await executeInventory(
      { ...noFilters(), hostnameLike: PREFIX },
      { sites: [SITE_A_CODE] }
    );
    const hostnames = (scoped.results.devices ?? []).map((row) => row.hostname);
    expect(hostnames).toContain(HOST_A);
    expect(hostnames).not.toContain(HOST_B);
  });

  test("inventory: the NL plan's site filter is INTERSECTED with the scope — a plan targeting the out-of-scope site yields EMPTY, never those rows", async () => {
    const plan = { ...noFilters(), site: SITE_B_CODE, hostnameLike: PREFIX };
    const scoped = await executeInventory(plan, { sites: [SITE_A_CODE] });
    expect(scoped.results.devices).toEqual([]);
    // In-scope plan sites still filter normally (BR1-limited session asking
    // for BR1 gets BR1 rows — here the fixture device at site A).
    const inScope = await executeInventory(
      { ...noFilters(), site: SITE_A_CODE, hostnameLike: PREFIX },
      { sites: [SITE_A_CODE] }
    );
    expect((inScope.results.devices ?? []).map((row) => row.hostname)).toEqual([HOST_A]);
  });

  test("WILDCARD PARITY: no claims → the base where unchanged, both fixture rows, exact row shape", async () => {
    const wildcard = await executeInventory(
      { ...noFilters(), hostnameLike: PREFIX },
      undefined
    );
    const rows = wildcard.results.devices ?? [];
    const hostnames = rows.map((row) => row.hostname);
    expect(hostnames).toContain(HOST_A);
    expect(hostnames).toContain(HOST_B);
    const row = rows.find((r) => r.hostname === HOST_A)!;
    expect(Object.keys(row)).toEqual([
      "id",
      "hostname",
      "model",
      "firmware",
      "status",
      "criticality",
      "backupCompliance",
      "siteCode",
      "siteName",
      "vendorKey",
    ]);
    expect(row.siteCode).toBe(SITE_A_CODE);
  });

  test("(d) DENY-ALL: sites: [] → empty results on the scoped executor", async () => {
    const denyAll = await executeInventory(
      { ...noFilters(), hostnameLike: PREFIX },
      { sites: [] }
    );
    expect(denyAll.results.devices).toEqual([]);
  });

  test("incidents: the cross-scope open incident is hidden scoped (and a plan site outside the scope yields empty), visible wildcard", async () => {
    const scoped = await executeIncidents(noFilters(), { sites: [SITE_A_CODE] });
    expect((scoped.results.incidents ?? []).map((r) => r.number)).not.toContain(INC_B_NUMBER);

    const planSiteB = await executeIncidents(
      { ...noFilters(), site: SITE_B_CODE },
      { sites: [SITE_A_CODE] }
    );
    expect(planSiteB.results.incidents).toEqual([]);

    const wildcard = await executeIncidents(noFilters(), undefined);
    expect((wildcard.results.incidents ?? []).map((r) => r.number)).toContain(INC_B_NUMBER);
  });

  test("changes: the cross-scope change is hidden scoped, visible wildcard", async () => {
    const scoped = await executeChanges(noFilters(), { sites: [SITE_A_CODE] });
    expect((scoped.results.changes ?? []).map((r) => r.number)).not.toContain(CHG_B_NUMBER);

    const wildcard = await executeChanges(noFilters(), undefined);
    expect((wildcard.results.changes ?? []).map((r) => r.number)).toContain(CHG_B_NUMBER);
  });

  test("jobs (device-keyed): scoped sees only the job targeting the in-scope device; untargeted and cross-scope jobs are hidden; wildcard sees all", async () => {
    const scoped = await executeJobs(noFilters(), { sites: [SITE_A_CODE] });
    const corrs = (scoped.results.jobs ?? []).map((r) => r.correlationId);
    expect(corrs).toContain(JOB_A_CORR);
    expect(corrs).not.toContain(JOB_B_CORR);
    expect(corrs).not.toContain(JOB_C_CORR);

    const wildcard = await executeJobs(noFilters(), undefined);
    const wideCorrs = (wildcard.results.jobs ?? []).map((r) => r.correlationId);
    expect(wideCorrs).toContain(JOB_A_CORR);
    expect(wideCorrs).toContain(JOB_B_CORR);
    expect(wideCorrs).toContain(JOB_C_CORR);
  });

  test("predictive: alert pressure on the out-of-scope device is invisible scoped, ranked wildcard", async () => {
    const scoped = await executePredictive(noFilters(), { sites: [SITE_A_CODE] });
    expect((scoped.results.predictive ?? []).map((r) => r.hostname)).not.toContain(HOST_B);

    const wildcard = await executePredictive(noFilters(), undefined);
    const hostBRow = (wildcard.results.predictive ?? []).find((r) => r.hostname === HOST_B);
    expect(hostBRow).toBeTruthy();
    expect(hostBRow!.activeAlerts).toBeGreaterThanOrEqual(1);
  });

  test("summary: the scoped snapshot counts only in-scope fixtures (devices, incidents, changes, device-keyed backups)", async () => {
    const scoped = await executeSummary({ sites: [SITE_A_CODE] });
    const snapshot = scoped.results.snapshot!;
    // Site A holds exactly one fixture device (ONLINE) — nothing else can
    // live on this suite-owned site code.
    expect(snapshot.devicesByStatus).toEqual({ ONLINE: 1 });
    // No open incidents exist at site A → the severity histogram is empty.
    expect(snapshot.openIncidentsBySeverity).toEqual({});
    // No changes at site A → recentChanges is empty (cross-scope change hidden).
    expect(snapshot.recentChanges).toEqual([]);
    // Device-keyed backups: only JOB_A targets the in-scope device.
    expect(snapshot.backupJobs24h.total).toBe(1);
    expect(snapshot.backupJobs24h.succeeded).toBe(1);

    const wildcard = await executeSummary(undefined);
    expect(wildcard.results.snapshot!.openIncidentsBySeverity.SEV1).toBeGreaterThanOrEqual(1);
    expect(
      (wildcard.results.snapshot!.recentChanges ?? []).map((c) => c.number)
    ).toContain(CHG_B_NUMBER);
    expect(wildcard.results.snapshot!.backupJobs24h.total).toBeGreaterThanOrEqual(2);
  });
});

/* ── (b) ai/assist + ai/rca-draft: fused-404 (no existence leak) ───────── */

describe("wave9 ai/assist + rca-draft: out-of-scope ids answer the existing not-found envelope", () => {
  test("assist: out-of-scope deviceId → the EXISTING DEVICE_NOT_FOUND envelope (byte-shape)", async () => {
    const { POST } = (await import("../../src/app/api/v1/ai/assist/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const res = await POST(
      postRequest("http://app.local/api/v1/ai/assist", await adminJwt([SITE_A_CODE]), {
        scope: "device",
        id: deviceBId,
        question: "Why is this device flapping?",
      })
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      success: boolean;
      error: { code: string; message: string };
      meta?: { requestId?: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("DEVICE_NOT_FOUND");
    expect(body.error.message).toBe("The requested device does not exist");
    expect(Object.keys(body).sort()).toEqual(["error", "meta", "success"]);
  });

  test("assist: for a scoped session the out-of-scope id and a GARBAGE id are byte-identical (indistinguishable from nonexistent)", async () => {
    const { POST } = (await import("../../src/app/api/v1/ai/assist/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const jwt = await adminJwt([SITE_A_CODE]);
    const outOfScope = await POST(
      postRequest("http://app.local/api/v1/ai/assist", jwt, {
        scope: "device",
        id: deviceBId,
        question: "Why is this device flapping?",
      })
    );
    const garbage = await POST(
      postRequest("http://app.local/api/v1/ai/assist", jwt, {
        scope: "device",
        id: "nonexistent-device-id-w9ai",
        question: "Why is this device flapping?",
      })
    );
    expect(garbage.status).toBe(404);
    // Same stable envelope (minus the per-request meta.requestId) — the
    // out-of-scope device is indistinguishable from a nonexistent one.
    expect(stableEnvelope(await garbage.json())).toEqual(
      stableEnvelope(await outOfScope.json())
    );
  });

  test("rca-draft: out-of-scope incidentId → the EXISTING INCIDENT_NOT_FOUND envelope; a garbage id is byte-identical", async () => {
    const { POST } = (await import("../../src/app/api/v1/ai/rca-draft/route")) as {
      POST: (req: Request) => Promise<Response>;
    };
    const jwt = await adminJwt([SITE_A_CODE]);
    const outOfScope = await POST(
      postRequest("http://app.local/api/v1/ai/rca-draft", jwt, { incidentId: incidentBId })
    );
    expect(outOfScope.status).toBe(404);
    const body = (await outOfScope.json()) as {
      success: boolean;
      error: { code: string; message: string };
      meta?: { requestId?: string };
    };
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INCIDENT_NOT_FOUND");
    expect(body.error.message).toBe("Incident not found");

    const garbage = await POST(
      postRequest("http://app.local/api/v1/ai/rca-draft", jwt, {
        incidentId: "nonexistent-incident-id-w9ai",
      })
    );
    expect(garbage.status).toBe(404);
    expect(stableEnvelope(await garbage.json())).toEqual(stableEnvelope(body));
  });
});

/* ── (c) ai/change-draft: scoped grounding inventory + hostname matcher ── */

describe("wave9 ai/change-draft: the grounding inventory is scoped, out-of-scope hostnames ground as unknown", () => {
  test("loadChangeDraftInventory: scoped → only the in-scope device; wildcard → both (parity)", async () => {
    const scoped = await loadChangeDraftInventory({ sites: [SITE_A_CODE] });
    const scopedHostnames = scoped.map((row) => row.hostname);
    expect(scopedHostnames).toContain(HOST_A);
    expect(scopedHostnames).not.toContain(HOST_B);

    const wildcard = await loadChangeDraftInventory(undefined);
    const wideHostnames = wildcard.map((row) => row.hostname);
    expect(wideHostnames).toContain(HOST_A);
    expect(wideHostnames).toContain(HOST_B);
  });

  test("groundDeviceHostnames: with the scoped inventory an out-of-scope hostname is dropped exactly like an unknown one; wildcard matches both", async () => {
    const scopedInventory = await loadChangeDraftInventory({ sites: [SITE_A_CODE] });
    const scoped = groundDeviceHostnames(scopedInventory, [
      HOST_A.toUpperCase(), // case-insensitive match preserved
      HOST_B, // EXISTS cross-scope — must ground as unknown (dropped)
      "totally-unknown-hostname-w9ai",
    ]);
    expect(scoped.matchedDevices.map((row) => row.hostname)).toEqual([HOST_A]);
    expect(scoped.matchedDevices[0]!.id).toBe(deviceAId);
    expect(scoped.droppedHostnames).toBe(2);

    const wildcardInventory = await loadChangeDraftInventory(undefined);
    const wildcard = groundDeviceHostnames(wildcardInventory, [
      HOST_A,
      HOST_B,
      "totally-unknown-hostname-w9ai",
    ]);
    expect(wildcard.matchedDevices.map((row) => row.hostname)).toEqual([HOST_A, HOST_B]);
    expect(wildcard.droppedHostnames).toBe(1);
  });
});
