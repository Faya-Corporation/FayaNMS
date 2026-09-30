/**
 * RT-014 / F-016 — incident/change number allocation must retry on the
 * @@unique P2002 instead of dying with a 500 + full tx rollback.
 *
 * The allocation helpers used to read max(number)+1 via the GLOBAL client —
 * the incident read even ran outside the caller's tx — so two concurrent
 * creations computed the same number and the loser died with an unhandled
 * P2002. Both paths now allocate INSIDE the transaction via the tx client
 * and mirror the cmdb retry pattern (2 attempts; second conflict → typed
 * INCIDENT_NUMBER_CONFLICT / CHANGE_NUMBER_CONFLICT, 409 on the HTTP path).
 *
 * Test style: DB-backed (real PostgreSQL on :5433). Throwaway vendor/device/
 * alerts; every created incident/change is tracked and removed in afterAll.
 * The double-conflict negative case injects deterministic P2002s by wrapping
 * the shared client's $transaction (restored in a finally) — no production
 * code is patched on disk.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encode } from "next-auth/jwt";
import { Prisma } from "@prisma/client";

import { db } from "../../src/lib/db";
import { ROLE_MATRIX } from "../../src/lib/auth/role-matrix";
import {
  createIncidentForAlert,
  nextIncidentNumber,
  type CreateIncidentForAlertResult,
} from "../../src/lib/incidents/create";

/** The tx delegate type of the extended client (same convention as src). */
type DbTx = Parameters<Parameters<typeof db.$transaction>[0]>[0];
type TxOptions = Parameters<typeof db.$transaction>[1];

const VENDOR_KEY = "rt014-test-vendor";
const DEVICE_HOST = "rt014-test-device";
const ADMIN_EMAIL = "admin@faya.local";

const testStartedAt = new Date();
let vendorId = "";
let deviceId = "";
let adminJwt = "";
const createdAlertIds: string[] = [];
const createdIncidentIds: string[] = [];
const createdChangeIds: string[] = [];

async function mintSessionJwt(user: {
  id: string;
  email: string;
  name: string | null;
  role: string;
}): Promise<string> {
  return encode({
    token: {
      id: user.id,
      email: user.email,
      name: user.name ?? undefined,
      role: user.role,
    },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

/** Session-shaped projection of the admin identity (change requester). */
type AuditAdminUser = { id: string; email: string; name: string | null; role: string };

/**
 * Self-contained admin identity. The CI gate replays ONLY `migrate deploy`
 * on a fresh service container (no demo seed), so `admin@faya.local` cannot
 * be assumed to exist — and neither can the seeded admin ROLE row that
 * loadRolePermissions() resolves User.role against (a missing row turns
 * every requirePermission() into a 403). The Role upsert sources its
 * permissions from ROLE_MATRIX — the same single source of truth the seed
 * uses — and leaves an existing row untouched (update: {}). The user upsert
 * is atomic (ON CONFLICT on the unique email), so concurrent test files on
 * the shared database stay safe; the rows are never deleted afterwards —
 * they are seed-equivalent shared state, and removing them mid-run could
 * break parallel test files.
 */
let auditAdmin: AuditAdminUser | null = null;
async function ensureAuditAdmin(): Promise<AuditAdminUser> {
  if (auditAdmin) return auditAdmin;
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
  auditAdmin = await db.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { isActive: true },
    create: { email: ADMIN_EMAIL, name: "RT014 Admin", role: "admin", isActive: true },
    select: { id: true, email: true, name: true, role: true },
  });
  return auditAdmin;
}

async function createAlert(severity: string, message: string): Promise<string> {
  const alert = await db.alert.create({
    data: { deviceId, severity, message, status: "ACTIVE" },
    select: { id: true },
  });
  createdAlertIds.push(alert.id);
  return alert.id;
}

async function postChange(
  body: unknown
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const { POST } = await import("../../src/app/api/v1/changes/route");
  const response = await POST(
    new Request("http://localhost:3000/api/v1/changes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminJwt}`,
      },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, payload: (await response.json()) as Record<string, unknown> };
}

/** Wrap the shared client's $transaction so the next `count` tx calls fail
 *  with a P2002 on the number column before delegating (deterministic
 *  double-loss). Restores the original in every exit path. */
async function withInjectedNumberConflicts<T>(
  count: number,
  run: () => Promise<T>
): Promise<T> {
  const realTransaction = db.$transaction.bind(db);
  let remaining = count;
  (db as unknown as { $transaction: unknown }).$transaction = (
    fn: (tx: DbTx) => unknown,
    opts?: TxOptions
  ) =>
    realTransaction(async (tx: DbTx) => {
      if (remaining > 0) {
        remaining -= 1;
        throw new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`number`)",
          { code: "P2002", clientVersion: "rt014-test", meta: { target: ["number"] } }
        );
      }
      return fn(tx);
    }, opts);
  try {
    return await run();
  } finally {
    (db as unknown as { $transaction: unknown }).$transaction = realTransaction;
  }
}

beforeAll(async () => {
  const vendor = await db.vendor.upsert({
    where: { key: VENDOR_KEY },
    update: {},
    create: { key: VENDOR_KEY, name: "RT014 Test Vendor", adapterKey: "generic" },
  });
  vendorId = vendor.id;
  const device = await db.device.create({
    data: {
      hostname: `${DEVICE_HOST}-${Date.now()}`,
      mgmtIp: "192.0.2.77",
      status: "ONLINE",
      vendorId,
    },
    select: { id: true },
  });
  deviceId = device.id;
  const admin = await ensureAuditAdmin();
  adminJwt = await mintSessionJwt(admin);
});

afterAll(async () => {
  // Audits first (no FK to incident/change — reclaim explicitly), then the
  // linked rows (Incident/ChangeRequest deletes cascade their children;
  // Alert.incidentId is SetNull, so alerts go first regardless).
  await db.auditEvent.deleteMany({
    where: {
      createdAt: { gte: testStartedAt },
      OR: [
        { resourceType: "Incident", resourceId: { in: createdIncidentIds } },
        { resourceType: "Alert", resourceId: { in: createdAlertIds } },
        { resourceType: "ChangeRequest", resourceId: { in: createdChangeIds } },
      ],
    },
  });
  await db.alert.deleteMany({ where: { id: { in: createdAlertIds } } });
  await db.incident.deleteMany({ where: { id: { in: createdIncidentIds } } });
  await db.changeRequest.deleteMany({ where: { id: { in: createdChangeIds } } });
  await db.device.deleteMany({ where: { id: deviceId } });
  await db.vendor.deleteMany({ where: { key: VENDOR_KEY } });
});

describe("RT-014 number allocation retry on P2002", () => {
  test("concurrent incident creations both succeed (loser retried)", async () => {
    const [a1, a2] = await Promise.all([
      createAlert("HIGH", "rt014 concurrent A"),
      createAlert("HIGH", "rt014 concurrent B"),
    ]);
    const results = await Promise.all([
      createIncidentForAlert({
        alert: { id: a1, severity: "HIGH", message: "rt014 concurrent A", deviceId },
        device: { id: deviceId, hostname: `${DEVICE_HOST}-x` },
      }),
      createIncidentForAlert({
        alert: { id: a2, severity: "HIGH", message: "rt014 concurrent B", deviceId },
        device: { id: deviceId, hostname: `${DEVICE_HOST}-x` },
      }),
    ]);
    for (const result of results) {
      expect(result.created).toBe(true);
      expect(result.incident).not.toBeNull();
      createdIncidentIds.push(result.incident!.id);
    }
    const numbers = results.map((r) => r.incident!.number);
    expect(new Set(numbers).size).toBe(2);
    for (const number of numbers) {
      expect(number).toMatch(/^INC-\d{4}-\d{5}$/);
    }
  });

  test("staggered storm of 5 yields 5 distinct incident numbers", async () => {
    const results: CreateIncidentForAlertResult[] = [];
    for (let i = 0; i < 5; i += 1) {
      const alertId = await createAlert("MEDIUM", `rt014 storm ${i}`);
      // Small stagger ≈ an alert storm landing on one device.
      await new Promise((resolve) => setTimeout(resolve, 40));
      results.push(
        await createIncidentForAlert({
          alert: { id: alertId, severity: "MEDIUM", message: `rt014 storm ${i}`, deviceId },
          device: { id: deviceId, hostname: `${DEVICE_HOST}-x` },
        })
      );
    }
    const numbers = results.map((r) => r.incident!.number);
    createdIncidentIds.push(...results.map((r) => r.incident!.id));
    expect(new Set(numbers).size).toBe(5);
  });

  test("concurrent change creations both succeed with distinct CHG numbers", async () => {
    const [r1, r2] = await Promise.all([
      postChange({ title: "rt014 concurrent change A", type: "NORMAL", deviceIds: [deviceId] }),
      postChange({ title: "rt014 concurrent change B", type: "NORMAL", deviceIds: [deviceId] }),
    ]);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const n1 = (r1.payload.data as { change: { number: string; id: string } }).change;
    const n2 = (r2.payload.data as { change: { number: string; id: string } }).change;
    createdChangeIds.push(n1.id, n2.id);
    expect(n1.number).toMatch(/^CHG-\d{4}-\d{5}$/);
    expect(n2.number).toMatch(/^CHG-\d{4}-\d{5}$/);
    expect(n1.number).not.toBe(n2.number);
  });

  test("second consecutive conflict surfaces a typed error (no raw P2002)", async () => {
    const alertId = await createAlert("LOW", "rt014 double conflict");
    await expect(
      withInjectedNumberConflicts(2, () =>
        createIncidentForAlert({
          alert: { id: alertId, severity: "LOW", message: "rt014 double conflict", deviceId },
          device: { id: deviceId, hostname: `${DEVICE_HOST}-x` },
        })
      )
    ).rejects.toMatchObject({
      name: "IncidentNumberConflictError",
      code: "INCIDENT_NUMBER_CONFLICT",
    });
    // The failed txs rolled back — the alert must still be unlinked.
    const alert = await db.alert.findUnique({
      where: { id: alertId },
      select: { incidentId: true },
    });
    expect(alert?.incidentId).toBeNull();

    const change = await withInjectedNumberConflicts(2, () =>
      postChange({ title: "rt014 conflict change", type: "NORMAL", deviceIds: [deviceId] })
    );
    expect(change.status).toBe(409);
    expect((change.payload as { error?: { code?: string } }).error?.code).toBe(
      "CHANGE_NUMBER_CONFLICT"
    );
    expect(JSON.stringify(change.payload)).not.toMatch(/P2002/);
    // No partial change rows from the rolled-back attempts.
    const changes = await db.changeRequest.findMany({
      where: { title: "rt014 conflict change" },
      select: { id: true },
    });
    expect(changes).toHaveLength(0);
  });

  test("allocation reads inside the tx snapshot via the tx client", async () => {
    // Source assertion (config-hygiene style): guards the RACE CLASS, not
    // just the symptom — the helper must consume the tx client inside the
    // $transaction on both paths.
    const incidentSrc = readFileSync("src/lib/incidents/create.ts", "utf8");
    expect(incidentSrc).toMatch(/nextIncidentNumber\(\s*(client|tx|prisma)[^)]*\)/);
    expect(incidentSrc).toMatch(/const number = await nextIncidentNumber\(tx/);
    const txBlock = incidentSrc.slice(
      incidentSrc.indexOf("db.$transaction"),
      incidentSrc.indexOf("return created;")
    );
    expect(txBlock).toContain("nextIncidentNumber(tx");

    const changeSrc = readFileSync("src/app/api/v1/changes/route.ts", "utf8");
    expect(changeSrc).toMatch(/const number = await nextChangeNumber\(tx\)/);
    expect(changeSrc).toMatch(/CHANGE_NUMBER_CONFLICT/);
    expect(incidentSrc).toMatch(/INCIDENT_NUMBER_CONFLICT/);

    // The helper accepts a client param and still returns the padded format.
    const number = await nextIncidentNumber(db);
    expect(number).toMatch(/^INC-\d{4}-\d{5}$/);
  });

  test("existing single-threaded numbering unchanged (max+1 padded 5)", async () => {
    const first = await createIncidentForAlert({
      alert: {
        id: await createAlert("INFO", "rt014 sequential 1"),
        severity: "INFO",
        message: "rt014 sequential 1",
        deviceId,
      },
      device: { id: deviceId, hostname: `${DEVICE_HOST}-x` },
    });
    const second = await createIncidentForAlert({
      alert: {
        id: await createAlert("INFO", "rt014 sequential 2"),
        severity: "INFO",
        message: "rt014 sequential 2",
        deviceId,
      },
      device: { id: deviceId, hostname: `${DEVICE_HOST}-x` },
    });
    createdIncidentIds.push(first.incident!.id, second.incident!.id);
    const seq1 = Number.parseInt(first.incident!.number.slice(-5), 10);
    const seq2 = Number.parseInt(second.incident!.number.slice(-5), 10);
    expect(seq2).toBe(seq1 + 1);
    expect(first.incident!.number).toBe(
      `INC-${new Date().getFullYear()}-${String(seq1).padStart(5, "0")}`
    );
  });
});
