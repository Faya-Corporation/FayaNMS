/**
 * RT-001 / F-001 — root-suppressed child alerts must re-activate when the
 * root alert resolves, and auto-resolve when their own condition recovers.
 *
 * Before the fix, `suppressedByRoot` in src/lib/alerts/evaluate.ts was a
 * dead variable: pass 1's reactivation branch only handled maintenance-window
 * expiry and pass 2's status filter (`ACTIVE`/`ACKNOWLEDGED` only) kept
 * SUPPRESSED rows out of the resolve walk forever. A root-suppressed child
 * was therefore a silent blind spot while its condition still breached and a
 * zombie SUPPRESSED row once it recovered.
 *
 * Test style: the pure-logic branch predicates are exported from the engine
 * and pinned here (the suite's DB is shared with the live demo fleet, so a
 * full `runAlertEvaluation()` pass would evaluate and mutate unrelated demo
 * alerts — the wiring itself is pinned by the source-contract tests below,
 * mirroring tests/protocol-ingest.test.ts / tests/flow-retention-api.test.ts).
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  ROOT_SUPPRESS_PREFIX,
  isAutoResolveCandidate,
  isRootSuppressed,
  isWindowSuppressed,
  shouldReactivateSuppressedRow,
} from "../../src/lib/alerts/evaluate";

const ROOT_REASON = `${ROOT_SUPPRESS_PREFIX}A1`;
const WINDOW_REASON = "Maintenance window: nightly patch";

/* ── pass 1: reactivation policy ──────────────────────────────────────── */

test("reactivates root-suppressed child when root resolved and condition still breaching", () => {
  // Root gone (no open AVAILABILITY alert), no maintenance window, and the
  // row only reached pass 1 because its own condition is still breaching.
  expect(shouldReactivateSuppressedRow("SUPPRESSED", ROOT_REASON, false, false)).toBe(true);
});

test("keeps root-suppressed child suppressed while device is in a maintenance window", () => {
  // Maintenance precedence: an active window owns the row even after the
  // root released it.
  expect(shouldReactivateSuppressedRow("SUPPRESSED", ROOT_REASON, true, false)).toBe(false);
});

test("keeps root-suppressed child suppressed while a root is still open", () => {
  expect(shouldReactivateSuppressedRow("SUPPRESSED", ROOT_REASON, false, true)).toBe(false);
});

test("window-expiry reactivation keeps working (existing behavior pin)", () => {
  expect(shouldReactivateSuppressedRow("SUPPRESSED", WINDOW_REASON, false, false)).toBe(true);
  expect(shouldReactivateSuppressedRow("SUPPRESSED", WINDOW_REASON, true, false)).toBe(false);
});

test("unknown suppression reasons are never re-activated", () => {
  expect(shouldReactivateSuppressedRow("SUPPRESSED", "Manual: operator", false, false)).toBe(false);
  expect(shouldReactivateSuppressedRow("SUPPRESSED", null, false, false)).toBe(false);
  expect(shouldReactivateSuppressedRow("ACTIVE", ROOT_REASON, false, false)).toBe(false);
});

test("classification helpers separate window vs root suppression", () => {
  expect(isWindowSuppressed("SUPPRESSED", WINDOW_REASON)).toBe(true);
  expect(isWindowSuppressed("SUPPRESSED", ROOT_REASON)).toBe(false);
  expect(isRootSuppressed("SUPPRESSED", ROOT_REASON)).toBe(true);
  expect(isRootSuppressed("SUPPRESSED", WINDOW_REASON)).toBe(false);
  expect(isRootSuppressed("ACTIVE", ROOT_REASON)).toBe(false);
});

/* ── pass 2: auto-resolve eligibility ─────────────────────────────────── */

test("resolves recovered root-suppressed child", () => {
  // The recovered-condition check itself is unchanged; the fix is that a
  // root-suppressed row is now ELIGIBLE for the resolve walk at all.
  expect(isAutoResolveCandidate("SUPPRESSED", ROOT_REASON)).toBe(true);
});

test("does not auto-resolve maintenance-suppressed rows", () => {
  // Negative case: maintenance-owned rows stay skipped by pass 2.
  expect(isAutoResolveCandidate("SUPPRESSED", WINDOW_REASON)).toBe(false);
});

test("active and acknowledged rows remain resolve candidates (existing behavior pin)", () => {
  expect(isAutoResolveCandidate("ACTIVE", null)).toBe(true);
  expect(isAutoResolveCandidate("ACKNOWLEDGED", null)).toBe(true);
  expect(isAutoResolveCandidate("RESOLVED", null)).toBe(false);
  expect(isAutoResolveCandidate("SUPPRESSED", "Manual: operator")).toBe(false);
});

/* ── wiring contracts (the dead variable must be consumed) ────────────── */

const engine = () => readFileSync("src/lib/alerts/evaluate.ts", "utf8");

/** Whitespace-collapsed view of the source — robust against line wraps. */
const compact = (source: string): string => source.replace(/\s+/g, " ");

test("engine consumes the suppression classification in both passes", () => {
  const source = compact(engine());
  // Pass 1 — reactivation uses the shared predicate with the live
  // maintenance check and the root-release lookup.
  expect(source).toContain(
    "shouldReactivateSuppressedRow( existing.status, existing.suppressReason, maintenanceFor(device) !== null, await openRootExists(device) )"
  );
  // Pass 2 — resolve eligibility goes through the shared predicate.
  expect(source).toContain("isAutoResolveCandidate(existing.status, existing.suppressReason)");
  // The old inline pass-2 status-only gate is gone.
  expect(source).not.toContain(
    'if (existing.status !== "ACTIVE" && existing.status !== "ACKNOWLEDGED") continue;'
  );
});

test("engine re-activation clears the suppression and the parent link", () => {
  const source = compact(engine());
  const start = source.indexOf("shouldReactivateSuppressedRow( existing.status");
  const reactivateBlock = source.slice(start, start + 1_200);
  expect(reactivateBlock).toContain('status: "ACTIVE"');
  expect(reactivateBlock).toContain("suppressReason: null");
  expect(reactivateBlock).toContain("parentAlertId: null");
});

test("engine root-release check queries for an open AVAILABILITY root", () => {
  const source = engine();
  expect(source).toContain('dedupKey: { contains: ":AVAILABILITY:" }');
  expect(source).toContain('status: { in: ["ACTIVE", "ACKNOWLEDGED"] }');
});

test("engine resolve of a suppressed child clears its stale parent link", () => {
  const source = engine();
  expect(source).toContain(
    '...(existing.status === "SUPPRESSED" ? { parentAlertId: null } : {})'
  );
});

test("summary audit reports the reactivated count", () => {
  const source = engine();
  expect(source).toContain("reactivated: number");
  expect(source).toContain("reactivated: summary.reactivated");
});

test("worker completion contract accepts the reactivated counter", () => {
  const complete = readFileSync("src/app/api/v1/worker/complete/route.ts", "utf8");
  expect(complete).toContain("reactivated: z.number().int().nonnegative().optional()");
});
