import { describe, expect, test } from "bun:test";

import {
  computeAuditHash,
  verifyAuditChain,
  type AuditChainFields,
} from "../../src/lib/audit/chain";
import type { PrismaClient } from "@prisma/client";

/**
 * Audit-chain verifier tests (Phase 19-C / audit AUD-101): the verifier
 * must follow the prevHash→hash LINKS (not the createdAt sort), reject
 * forks/parallel chains/dangling links, and distinguish FULLY vs
 * PARTIALLY vs INVALID instead of returning an unqualified success after
 * a capped scan.
 */

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
    // Sign with EXACTLY the fields the row will store (the verifier
    // recomputes from the stored row projection).
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

function fakeClient(rows: Row[], total?: number): PrismaClient {
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

describe("audit chain verifier (link walk)", () => {
  test("an intact chain is FULLY_VERIFIED even when createdAt order disagrees with link order", async () => {
    // The AUD-101 concurrency residual: a later-chained row can carry an
    // EARLIER timestamp (write B commits, write A loses the tail race,
    // retries and chains AFTER B). The link order (r0 → r1 → r2) then
    // disagrees with the (createdAt, id) sort — a timestamp-sorting
    // verifier would flag a false break. Build exactly that: swap the
    // createdAt of rows 1 and 2 and RE-SIGN both rows so every stored hash
    // is valid for its own (swapped) timestamp.
    const rows = buildChain(3);
    const t1 = rows[1].createdAt;
    const t2 = rows[2].createdAt;
    rows[1].createdAt = t2;
    rows[2].createdAt = t1;
    // Re-sign row-1 FIRST (its hash changes), then re-point row-2's prevHash
    // at the new hash and re-sign row-2 — exactly what the retry path does.
    rows[1].hash = computeAuditHash(baseFields({
      prevHash: rows[1].prevHash,
      createdAt: rows[1].createdAt,
      action: rows[1].action,
      resourceId: rows[1].resourceId,
    }));
    rows[2].prevHash = rows[1].hash;
    rows[2].hash = computeAuditHash(baseFields({
      prevHash: rows[2].prevHash,
      createdAt: rows[2].createdAt,
      action: rows[2].action,
      resourceId: rows[2].resourceId,
    }));
    // Link order: row-0 → row-1 → row-2 (preserved via prevHash), while the
    // timestamp sort would order row-0 → row-2 → row-1.
    expect(rows[2].createdAt.getTime()).toBeLessThan(rows[1].createdAt.getTime());
    const result = await verifyAuditChain(fakeClient(rows));
    expect(result.verdict).toBe("FULLY_VERIFIED");
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
  });

  test("a tampered payload is INVALID with a hash-mismatch break", async () => {
    const rows = buildChain(4);
    rows[2].afterJson = '{"tampered":true}';
    const result = await verifyAuditChain(fakeClient(rows));
    expect(result.verdict).toBe("INVALID");
    expect(result.valid).toBe(false);
    expect(result.brokenAt?.reason).toBe("hash-mismatch");
    expect(result.brokenAt?.id).toBe("row-2");
  });

  test("unhashed backfill-pending rows cap the verdict at PARTIALLY_VERIFIED", async () => {
    const rows = buildChain(5, { unhashedTail: 2 });
    const result = await verifyAuditChain(fakeClient(rows));
    expect(result.verdict).toBe("PARTIALLY_VERIFIED");
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(3);
    expect(result.unhashed).toBe(2);
    expect(result.issues.join(" ")).toMatch(/backfill/);
  });

  test("two parallel chains (multiple genesis) are INVALID", async () => {
    const rows = buildChain(3);
    // A second chain rooted at GENESIS with plausible hashes.
    const intruder = baseFields({
      createdAt: new Date("2026-09-11T00:00:00.000Z"),
      action: "INTRUDER",
    });
    rows.push({
      id: "intruder",
      createdAt: intruder.createdAt as Date,
      action: "INTRUDER",
      actorName: "tester",
      resourceType: "Test",
      resourceId: "res-x",
      result: "SUCCESS",
      correlationId: null,
      beforeJson: null,
      afterJson: null,
      hash: computeAuditHash(intruder),
      prevHash: null,
    });
    const result = await verifyAuditChain(fakeClient(rows));
    expect(result.verdict).toBe("INVALID");
    expect(result.issues.join(" ")).toMatch(/genesis/);
  });

  test("a planted parallel chain forked mid-history is INVALID", async () => {
    const rows = buildChain(4);
    // Fork from row-1's hash: two children claim the same prevHash.
    const fields = baseFields({
      prevHash: rows[1].hash,
      createdAt: new Date("2026-09-12T00:00:00.000Z"),
      action: "FORK",
    });
    rows.push({
      id: "fork",
      createdAt: fields.createdAt as Date,
      action: "FORK",
      actorName: "tester",
      resourceType: "Test",
      resourceId: "res-f",
      result: "SUCCESS",
      correlationId: null,
      beforeJson: null,
      afterJson: null,
      hash: computeAuditHash(fields),
      prevHash: rows[1].hash,
    });
    const result = await verifyAuditChain(fakeClient(rows));
    expect(result.verdict).toBe("INVALID");
    expect(result.issues.join(" ")).toMatch(/Fork/);
  });

  test("a scan cap caps the verdict at PARTIALLY_VERIFIED (never unqualified success)", async () => {
    const rows = buildChain(10);
    // Pretend the table holds more rows than we scanned.
    const result = await verifyAuditChain(fakeClient(rows.slice(0, 4), 10), 4);
    expect(result.truncated).toBe(true);
    expect(result.verdict).toBe("PARTIALLY_VERIFIED");
    expect(result.valid).toBe(true);
  });

  test("an empty table is FULLY_VERIFIED (nothing to verify)", async () => {
    const result = await verifyAuditChain(fakeClient([]));
    expect(result.verdict).toBe("FULLY_VERIFIED");
    expect(result.checked).toBe(0);
  });
});
