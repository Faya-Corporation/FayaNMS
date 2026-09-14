/**
 * FayaNMS — approval fingerprint over the canonical approved spec (POL-002,
 * external ULTRA audit P1-002).
 *
 * The audit's requirement: approvals must be bound to "a canonical execution
 * fingerprint containing device IDs, operations, restore target, template
 * version and schedule", computed as SHA-256 over canonical JSON, and
 * re-verified at execute time. An approval authorizes EXACTLY the spec it
 * saw — not whatever the change rows happen to hold later.
 *
 * PURE module (deterministic string/bytes handling). The only import is
 * node:crypto, so this module is SERVER-SIDE (API routes, worker, seed,
 * tests) — never import it from client components.
 *
 * Canonical form (v1, versioned so future fields cannot silently re-mean
 * old fingerprints):
 *   - top-level envelope { version: 1, spec } with every key SORTED;
 *   - deviceIds sorted + de-duplicated (approval scope is a set);
 *   - operations sorted by (order, name, type) — wizard/restore steps are
 *     authored in order, but the canonical form must not depend on insert
 *     order;
 *   - schedule as ISO-8601 UTC strings (Date.toISOString), null when unset;
 *   - riskLevel/changeType included (they gate the approval policy itself);
 *   - riskScore deliberately EXCLUDED (derived display value; including it
 *     would churn fingerprints when scoring factors are tuned).
 */

import { createHash } from "node:crypto";

export const APPROVAL_FINGERPRINT_VERSION = 1;

/** The approved execution intent the fingerprint binds. */
export interface ApprovalSpecInput {
  changeNumber: string;
  changeType: string;
  riskLevel: string;
  deviceIds: string[];
  /** Typed operations (change steps): order/name/type triplets. */
  operations: Array<{ order: number; name: string; type: string }>;
  /** Approved restore target (SAFE-008), null on GENERIC changes. */
  restoreSnapshotId: string | null;
  scheduledStart: Date | string | null;
  scheduledEnd: Date | string | null;
}

/** RFC-3339/ISO normalization — Date or date-string or null. */
function isoOrNull(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  // Invalid dates must fail loudly, not serialize as "Invalid Date".
  if (Number.isNaN(date.getTime())) {
    throw new Error("APPROVAL_SPEC_INVALID_DATE: schedule field is not a valid date");
  }
  return date.toISOString();
}

/**
 * Stable recursive key-sort serializer. Arrays keep their order (callers
 * sort semantically first); object keys are sorted; strings/numbers/booleans
 * and nulls pass through. Not a general JSON replacement — the input is the
 * typed envelope built by canonicalApprovalSpec below.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Canonical spec object (versioned envelope). Deterministic: two inputs
 * that differ only in key insertion order, device order or operation order
 * produce IDENTICAL output.
 */
export function canonicalApprovalSpec(input: ApprovalSpecInput): unknown {
  const deviceIds = Array.from(new Set(input.deviceIds)).sort();
  const operations = [...input.operations].sort(
    (a, b) =>
      a.order - b.order ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)
  );
  return {
    version: APPROVAL_FINGERPRINT_VERSION,
    changeNumber: input.changeNumber,
    changeType: input.changeType,
    riskLevel: input.riskLevel,
    deviceIds,
    operations: operations.map((op) => ({
      order: op.order,
      name: op.name,
      type: op.type,
    })),
    restoreSnapshotId: input.restoreSnapshotId ?? null,
    scheduledStart: isoOrNull(input.scheduledStart),
    scheduledEnd: isoOrNull(input.scheduledEnd),
  };
}

/**
 * SHA-256 hex fingerprint over the canonical spec. Uppercase hex — matches
 * the snapshot digest convention used across the codebase.
 */
export function approvalFingerprintFor(input: ApprovalSpecInput): string {
  const canonical = stableStringify(canonicalApprovalSpec(input));
  return createHash("sha256").update(canonical, "utf8").digest("hex").toUpperCase();
}

/**
 * Greppable shared prefix for fingerprint verification failures — every
 * refusal path (change-stamp drift, decision-stamp drift) uses this marker
 * so audit greps and runbook triage find the whole family (same convention
 * as RESTORE_TARGET_UNRESOLVABLE).
 */
export const APPROVAL_FINGERPRINT_UNBINDABLE = "APPROVAL_FINGERPRINT_UNBINDABLE";
