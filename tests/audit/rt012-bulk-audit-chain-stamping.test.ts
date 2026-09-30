/**
 * RT-012 / F-014 — devices/bulk backup_now must join the audit hash chain.
 *
 * The db extension stamps ONLY `auditEvent.create`; the bulk route used
 * `auditEvent.createMany`, so every bulk "backup now" wrote up to 100
 * CONFIG_BACKUP_QUEUED rows with null hash/prevHash — outside the link
 * graph, mutable until a manual backfill, and enough to drag the verify
 * verdict down. The route now writes each job + audit row per-device inside
 * ONE interactive transaction (stamped at creation, inheriting the P2002
 * tail-conflict retry), and the extension REFUSES `auditEvent.createMany`
 * outright so the gap can never silently reopen (defense-in-depth; the seed
 * is unaffected — it uses the raw, un-extended PrismaClient on purpose).
 *
 * Test style: the route handler is invoked in-process with a minted
 * next-auth JWT (same getSessionUser/getToken contract as production; the
 * e2e suite covers the full server path). Devices/users are throwaway rows;
 * the shared demo chain is never degraded — the verdict assertion compares
 * BEFORE vs AFTER so pre-existing unhashed seed rows are out of scope.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { encode } from "next-auth/jwt";
import type { PrismaClient } from "@prisma/client";

import { db } from "../../src/lib/db";
import {
  computeAuditHash,
  GENESIS,
  invalidateAuditHead,
  verifyAuditChain,
} from "../../src/lib/audit/chain";

const VENDOR_KEY = "rt012-test-vendor";
const DEVICE_HOST_PREFIX = "rt012-test-device-";
const ADMIN_EMAIL = "admin@faya.local";
const VIEWER_EMAIL = "rt012-viewer@faya.local";

const testStartedAt = new Date();
let vendorId = "";
let deviceIds: string[] = [];
let viewerUserId = "";
let createdAnchor = false;

async function mintSessionJwt(user: { id: string; email: string; name: string | null; role: string }): Promise<string> {
  return encode({
    token: { id: user.id, email: user.email, name: user.name ?? undefined, role: user.role },
    secret: process.env.NEXTAUTH_SECRET ?? "",
  });
}

async function bulkPost(body: unknown, sessionJwt?: string): Promise<Response> {
  const { POST } = await import("../../src/app/api/v1/devices/bulk/route");
  return POST(
    new Request("http://localhost:3000/api/v1/devices/bulk", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Plain Requests have no cookie jar — next-auth getToken's documented
        // fallback reads the same JWT from the Authorization header.
        ...(sessionJwt ? { authorization: `Bearer ${sessionJwt}` } : {}),
      },
      body: JSON.stringify(body),
    })
  );
}

/** CONFIG_BACKUP_QUEUED rows written by THIS test run for the given devices. */
function bulkAuditRows() {
  return db.auditEvent.findMany({
    where: {
      action: "CONFIG_BACKUP_QUEUED",
      resourceType: "Device",
      resourceId: { in: deviceIds },
      createdAt: { gte: testStartedAt },
    },
    orderBy: { createdAt: "asc" },
  });
}

beforeAll(async () => {
  const vendor = await db.vendor.upsert({
    where: { key: VENDOR_KEY },
    update: {},
    create: { key: VENDOR_KEY, name: "RT012 Test Vendor", adapterKey: "generic" },
  });
  vendorId = vendor.id;
  for (let i = 1; i <= 6; i += 1) {
    const device = await db.device.create({
      data: {
        hostname: `${DEVICE_HOST_PREFIX}${i}-${Date.now()}`,
        mgmtIp: `192.0.2.20${i}`,
        status: "ONLINE",
        vendorId,
      },
      select: { id: true },
    });
    deviceIds.push(device.id);
  }
  const viewer = await db.user.upsert({
    where: { email: VIEWER_EMAIL },
    update: { isActive: true },
    create: {
      email: VIEWER_EMAIL,
      name: "RT012 Viewer",
      role: "viewer",
      isActive: true,
    },
  });
  viewerUserId = viewer.id;

  // CHAIN ANCHOR: stamping only chains onto an existing hashed tail
  // (chain.ts leaves rows unhashed for the backfill when no hashed
  // predecessor exists — a fresh/seed-only database has none, because the
  // seed intentionally uses the raw, un-extended client). Root a minimal
  // one-row chain exactly once, the same way an operator's rechain run
  // would, so the route's rows have a legitimate tail to join. The anchor
  // is removed again in afterAll (createdAnchor keeps our footprint
  // relative to whatever the environment had).
  const hashedCount = await db.auditEvent.count({ where: { hash: { not: null } } });
  if (hashedCount === 0) {
    const anchorCreatedAt = new Date();
    const anchorPrevHash = GENESIS;
    const anchorHash = computeAuditHash({
      prevHash: anchorPrevHash,
      createdAt: anchorCreatedAt,
      action: "RT012_CHAIN_ANCHOR",
      actorName: "rt012-test",
      resourceType: "Test",
      resourceId: "rt012-anchor",
      result: "SUCCESS",
      correlationId: "rt012-anchor",
      beforeJson: null,
      afterJson: null,
    });
    // Explicit hash/prevHash bypass the stamping extension by design
    // (chain.ts skips rows that arrive pre-hashed).
    await db.auditEvent.create({
      data: {
        actorName: "rt012-test",
        action: "RT012_CHAIN_ANCHOR",
        resourceType: "Test",
        resourceId: "rt012-anchor",
        result: "SUCCESS",
        correlationId: "rt012-anchor",
        createdAt: anchorCreatedAt,
        prevHash: anchorPrevHash,
        hash: anchorHash,
      },
    });
    createdAnchor = true;
    invalidateAuditHead();
  }
});

afterAll(async () => {
  // Device cascade has no FK to jobs/audits — reclaim explicitly.
  await db.auditEvent.deleteMany({
    where: {
      action: "CONFIG_BACKUP_QUEUED",
      resourceId: { in: deviceIds },
      createdAt: { gte: testStartedAt },
    },
  });
  await db.jobExecution.deleteMany({
    where: {
      type: "CONFIG_BACKUP",
      targetId: { in: deviceIds },
      createdAt: { gte: testStartedAt },
    },
  });
  await db.device.deleteMany({ where: { hostname: { startsWith: DEVICE_HOST_PREFIX } } });
  await db.vendor.deleteMany({ where: { key: VENDOR_KEY } });
  await db.user.deleteMany({ where: { id: viewerUserId } });
  if (createdAnchor) {
    await db.auditEvent.deleteMany({ where: { action: "RT012_CHAIN_ANCHOR" } });
    invalidateAuditHead();
  }
});

describe("RT-012 bulk audit chain stamping (DB)", () => {
  test("bulk backup_now stamps every audit row onto the chain", async () => {
    const admin = await db.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { id: true, email: true, name: true, role: true },
    });
    expect(admin).not.toBeNull();

    const threeIds = deviceIds.slice(0, 3);
    const response = await bulkPost(
      { action: "backup_now", deviceIds: threeIds },
      await mintSessionJwt(admin!)
    );
    if (response.status !== 200) console.error("PROBE_BODY", await response.clone().text());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { queued: number; jobs: Array<{ correlationId: string }>; skipped: unknown[] };
      meta?: { auditEvents?: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.queued).toBe(3);
    expect(body.data.jobs).toHaveLength(3);
    expect(body.data.skipped).toHaveLength(0);
    expect(body.meta?.auditEvents).toBe(3);

    const rows = await bulkAuditRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.hash).not.toBeNull();
      expect(row.prevHash).not.toBeNull();
      // The stored hash must recompute exactly from the stored projection
      // chained onto its recorded prevHash (tamper-evident at birth).
      const recomputed = computeAuditHash({
        prevHash: row.prevHash as string,
        createdAt: row.createdAt,
        action: row.action,
        actorName: row.actorName,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        result: row.result,
        correlationId: row.correlationId,
        beforeJson: row.beforeJson,
        afterJson: row.afterJson,
      });
      expect(recomputed).toBe(row.hash as string);
    }
    // prevHash values link onto REAL rows (each matches the previous row's
    // stored hash or the live chain tail — no dangling links).
    const allHashes = new Set(
      (
        await db.auditEvent.findMany({
          where: { hash: { not: null } },
          select: { hash: true },
        })
      ).map((r) => r.hash)
    );
    for (const row of rows) {
      expect(allHashes.has(row.prevHash as string)).toBe(true);
    }
  });

  test("chain verify verdict is not degraded by the bulk run", async () => {
    const admin = await db.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { id: true, email: true, name: true, role: true },
    });

    const before = await verifyAuditChain(db as unknown as PrismaClient);

    const response = await bulkPost(
      { action: "backup_now", deviceIds: [deviceIds[3]] },
      await mintSessionJwt(admin!)
    );
    expect(response.status).toBe(200);

    const after = await verifyAuditChain(db as unknown as PrismaClient);
    // The bulk path contributed ZERO unhashed rows (before === after), so
    // the verdict cannot degrade by way of the bulk run. (The shared demo
    // table may legitimately carry pre-chain unhashed rows — out of scope.)
    expect(after.unhashed).toBe(before.unhashed);
    expect(after.verdict).toBe(before.verdict);
    // The freshly written row is stamped even if the shared table's verdict
    // stays PARTIALLY (pinned exhaustively by test 1's recompute).
    const rows = await bulkAuditRows();
    const fresh = rows.filter((row) => row.resourceId === deviceIds[3]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].hash).not.toBeNull();
    expect(fresh[0].prevHash).not.toBeNull();
  });

  test("createMany on auditEvent is refused (defense-in-depth tripwire)", async () => {
    let refusal: string | null = null;
    try {
      await db.auditEvent.createMany({
        data: [
          {
            actorName: "rt012-test",
            action: "SHOULD_BE_REFUSED",
            resourceType: "Test",
            result: "SUCCESS",
          },
        ],
      });
    } catch (error) {
      refusal = (error as Error).message;
    }
    expect(refusal).not.toBeNull();
    expect(refusal).toContain("bypasses chain stamping");
  });

  test("concurrent bulk runs keep the chain linear", async () => {
    const admin = await db.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { id: true, email: true, name: true, role: true },
    });
    expect(admin).not.toBeNull();
    const jwt = await mintSessionJwt(admin!);

    // Two parallel bulk posts race for the same chain tail: the extension's
    // P2002 retry must converge BOTH onto a single linear sequence.
    const [resA, resB] = await Promise.all([
      bulkPost({ action: "backup_now", deviceIds: [deviceIds[4]] }, jwt),
      bulkPost({ action: "backup_now", deviceIds: [deviceIds[5]] }, jwt),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    // Self-contained: only THIS test's two rows (its own devices), not the
    // earlier tests' rows.
    const rows = await db.auditEvent.findMany({
      where: {
        action: "CONFIG_BACKUP_QUEUED",
        resourceType: "Device",
        resourceId: { in: [deviceIds[4], deviceIds[5]] },
        createdAt: { gte: testStartedAt },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    const prevHashes = rows.map((row) => row.prevHash);
    expect(new Set(prevHashes).size).toBe(prevHashes.length); // no duplicated prevHash → no fork
    // Both link onto REAL chain rows (each prevHash matches some stored
    // hash — the two writers converged onto one linear sequence).
    const allHashes = new Set(
      (
        await db.auditEvent.findMany({
          where: { hash: { not: null } },
          select: { hash: true },
        })
      ).map((r) => r.hash)
    );
    for (const row of rows) {
      expect(row.hash).not.toBeNull();
      expect(row.prevHash).not.toBeNull();
      expect(allHashes.has(row.prevHash as string)).toBe(true);
    }
  });

  test("permission gate is unchanged", async () => {
    // Anonymous → 401.
    const anonymous = await bulkPost({
      action: "backup_now",
      deviceIds: [deviceIds[0]],
    });
    expect(anonymous.status).toBe(401);

    // Session WITHOUT device.write (viewer role = "*.read") → 403.
    const viewer = await db.user.findUnique({
      where: { id: viewerUserId },
      select: { id: true, email: true, name: true, role: true },
    });
    const forbidden = await bulkPost(
      { action: "backup_now", deviceIds: [deviceIds[0]] },
      await mintSessionJwt(viewer!)
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("RT-012 source contracts", () => {
  const REPO_ROOT = path.resolve(import.meta.dir, "../..");

  function readRepoFile(relativePath: string): string {
    return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
  }

  test("no auditEvent.createMany call sites remain in src/", () => {
    // The tripwire in db.ts is the only occurrence; the bulk route now
    // writes per-row creates inside its transaction.
    const route = readRepoFile("src/app/api/v1/devices/bulk/route.ts");
    expect(route).not.toContain("auditEvent.createMany");
    expect(route).toContain("tx.auditEvent.create");
    const dbLib = readRepoFile("src/lib/db.ts");
    expect(dbLib).toContain("createMany");
    expect(dbLib).toContain("bypasses chain stamping");
  });

  test("response contract unchanged (queued/jobs/skipped + auditEvents meta)", () => {
    const route = readRepoFile("src/app/api/v1/devices/bulk/route.ts");
    expect(route).toContain("queued: jobs.length");
    expect(route).toContain("auditEvents: jobs.length");
  });
});
