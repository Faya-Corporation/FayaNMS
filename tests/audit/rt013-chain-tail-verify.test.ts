/**
 * RT-013 / F-015 — verifyAuditChain must anchor its scan window at the
 * TAIL (newest maxRows rows), not the oldest prefix.
 *
 * Once AuditEvent outgrows the cap, a genesis-forward window proves only
 * ancient history; the fresh tail — the realistic tamper target — was
 * never walked. The verifier now fetches the NEWEST maxRows rows (then
 * reverses into chain order), walks forward from the window's oldest
 * hashed row when the genesis row predates the window, and resolves the
 * boundary link with one DB count (dangling → INVALID, continues
 * outside → PARTIALLY). Verdict semantics stay backward-compatible:
 * truncated walks still cap at PARTIALLY_VERIFIED.
 *
 * Test style: in-memory fake Prisma clients mirroring
 * tests/audit/chain.test.ts (deterministic, no DB writes) plus a
 * tail-faithful client that implements the real orderBy/take/count query
 * shapes the verifier issues.
 */

import { describe, expect, test } from "bun:test";

import {
  computeAuditHash,
  verifyAuditChain,
  type AuditChainFields,
} from "../../src/lib/audit/chain";
import type { PrismaClient } from "@prisma/client";

interface Row {
  id: string;
  createdAt: Date;
  action: string;
  actorName: string;
  resourceType: string;
  resourceId: string | null;
  result: string;
  correlationId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  hash: string | null;
  prevHash: string | null;
}

function baseFields(overrides: Partial<AuditChainFields>): AuditChainFields {
  return {
    prevHash: null,
    createdAt: new Date("2026-09-10T00:00:00.000Z"),
    action: "TEST_ACTION",
    actorName: "tester",
    resourceType: "Test",
    resourceId: "res-1",
    result: "SUCCESS",
    correlationId: null,
    beforeJson: null,
    afterJson: null,
    ...overrides,
  };
}

/** Build a valid chained set of rows; returns rows in CHAIN order. */
function buildChain(count: number, opts?: { unhashedTail?: number }): Row[] {
  const rows: Row[] = [];
  let prev: string | null = null;
  for (let index = 0; index < count; index += 1) {
    const unhashed = opts?.unhashedTail && index >= count - opts.unhashedTail;
    const createdAt = new Date(Date.parse("2026-09-10T00:00:00Z") + index * 1000);
    const resourceId = `res-${index}`;
    const fields = baseFields({
      prevHash: prev,
      createdAt,
      action: `ACT_${index}`,
      resourceId,
    });
    const hash = unhashed ? null : computeAuditHash(fields);
    rows.push({
      id: `row-${index}`,
      createdAt,
      action: `ACT_${index}`,
      actorName: "tester",
      resourceType: "Test",
      resourceId,
      result: "SUCCESS",
      correlationId: null,
      beforeJson: null,
      afterJson: null,
      hash,
      prevHash: unhashed ? null : prev,
    });
    prev = hash;
  }
  return rows;
}

/**
 * Fake client that answers the queries verifyAuditChain actually issues,
 * including the tail query shape (createdAt/id DESC + take) and exact-hash
 * existence counts used for the boundary prevHash resolution.
 */
function tailClient(rows: Row[], total?: number): PrismaClient {
  return {
    auditEvent: {
      count: async (args?: { where?: { hash?: unknown } }) => {
        const where = args?.where;
        if (where && "hash" in where) {
          const target = where.hash;
          if (target === null) return rows.filter((r) => !r.hash).length;
          if (
            typeof target === "object" &&
            target !== null &&
            "not" in target &&
            (target as { not: unknown }).not === null
          ) {
            return rows.filter((r) => r.hash !== null).length;
          }
          return rows.filter((r) => r.hash === target).length;
        }
        return total ?? rows.length;
      },
      findMany: async (args?: { take?: number }) => {
        const take = args?.take ?? rows.length;
        const sorted = [...rows].sort((a, b) => {
          const byTime = b.createdAt.getTime() - a.createdAt.getTime();
          if (byTime !== 0) return byTime;
          return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
        });
        return sorted.slice(0, take);
      },
    },
  } as unknown as PrismaClient;
}

/** Fake client that returns its rows verbatim (chain.test.ts style). */
function fixedClient(rows: Row[], total?: number): PrismaClient {
  return {
    auditEvent: {
      count: async (args?: { where?: { hash?: unknown } }) =>
        args?.where && "hash" in args.where
          ? rows.filter((row) => !row.hash).length
          : (total ?? rows.length),
      findMany: async () => rows,
    },
  } as unknown as PrismaClient;
}

describe("RT-013 audit chain tail-anchored verify", () => {
  test("small table walks the whole chain (FULLY_VERIFIED, window FULL)", async () => {
    const result = await verifyAuditChain(tailClient(buildChain(10)));
    expect(result.verdict).toBe("FULLY_VERIFIED");
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(10);
    expect(result.truncated).toBe(false);
    expect(result.window).toBe("FULL");
    expect(result.anchoredAt).toBeUndefined();
  });

  test("table beyond the cap proves the TAIL (newest maxRows rows)", async () => {
    const result = await verifyAuditChain(tailClient(buildChain(110)), 100);
    expect(result.truncated).toBe(true);
    expect(result.window).toBe("TAIL");
    expect(result.verdict).toBe("PARTIALLY_VERIFIED");
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(100);
    // The window's oldest row is the 11th row of 110 — the NEWEST 100 were
    // walked, not the oldest 100.
    expect(result.anchoredAt).toBe("row-10");
    expect(result.issues.join(" ")).toMatch(/Tail window: rows 0\.\.9 before row-10/);
    expect(result.issues.join(" ")).toMatch(/Scan cap reached/);
  });

  test("tampered tail row is detected (INVALID at the recent row)", async () => {
    const rows = buildChain(110);
    // The realistic attack: edit a RECENT row's payload, recompute nothing.
    rows[105].afterJson = '{"tampered":true}';
    const result = await verifyAuditChain(tailClient(rows), 100);
    expect(result.verdict).toBe("INVALID");
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.id).toBe("row-105");
    expect(result.brokenAt?.reason).toBe("hash-mismatch");
  });

  test("boundary anchor whose prevHash exists outside the window caps at PARTIALLY", async () => {
    // rows[10].prevHash = rows[9].hash → a real (older) row outside the
    // 100-row window: the link continues outside → PARTIALLY, never INVALID.
    const result = await verifyAuditChain(tailClient(buildChain(110)), 100);
    expect(result.verdict).toBe("PARTIALLY_VERIFIED");
    expect(result.valid).toBe(true);
    expect(result.anchoredAt).toBe("row-10");
  });

  test("dangling anchor prevHash is INVALID (negative case)", async () => {
    const rows = buildChain(110);
    // The window's oldest row now points at a hash NO row carries — a
    // broken/rewritten link at the boundary must stay INVALID.
    rows[10].prevHash = "dangling-deadbeef";
    const result = await verifyAuditChain(tailClient(rows), 100);
    expect(result.verdict).toBe("INVALID");
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.id).toBe("row-10");
    expect(result.brokenAt?.reason).toBe("prev-hash-mismatch");
    expect(result.issues.join(" ")).toMatch(/matches no audit row/);
  });

  test("unhashed rows inside the tail window still degrade/report as today", async () => {
    const result = await verifyAuditChain(
      tailClient(buildChain(110, { unhashedTail: 5 })),
      100
    );
    expect(result.verdict).toBe("PARTIALLY_VERIFIED");
    expect(result.valid).toBe(true);
    expect(result.window).toBe("TAIL");
    expect(result.checked).toBe(95);
    expect(result.unhashed).toBe(5);
    expect(result.issues.join(" ")).toMatch(/backfill/);
  });

  test("truncated window that still contains genesis keeps legacy semantics", async () => {
    // Backward compatibility: a capped window holding the genesis row walks
    // from genesis exactly as before (PARTIALLY, valid — never the tail
    // anchor branch, never a missing-genesis INVALID).
    const rows = buildChain(10);
    const result = await verifyAuditChain(fixedClient(rows.slice(0, 4), 10), 4);
    expect(result.truncated).toBe(true);
    expect(result.window).toBe("TAIL");
    expect(result.verdict).toBe("PARTIALLY_VERIFIED");
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(4);
  });
});
