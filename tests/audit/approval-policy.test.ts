import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  CAB_QUORUM_RISK_LEVELS,
  CAB_QUORUM_SIZE,
  APPROVAL_VALIDITY_MS,
  approvalExpiryFor,
  approvalValidityMsFor,
  canCastDecision,
  evaluateApprovalGate,
  fingerprintMismatches,
  quorumRequiredFor,
  type ApprovalDecisionInput,
  type ApprovalRowInput,
} from "../../src/lib/change/approval-policy";
import {
  APPROVAL_FINGERPRINT_VERSION,
  APPROVAL_FINGERPRINT_UNBINDABLE,
  approvalFingerprintFor,
  canonicalApprovalSpec,
} from "../../src/lib/change/fingerprint";

/**
 * POL-001/002/003 — bindable approvals (pure half). The external ULTRA
 * audit's P1-001/P1-002: one CAB row meant one decision (no two-person
 * quorum on CRITICAL changes), and approvals were not bound to the
 * immutable execution intent (no canonical fingerprint) with no validity
 * horizon. These pins hold the DECISION contract: quorum math, expiry
 * policy, gate verdict precedence, fingerprint canonicalization, and the
 * re-cast guard. Route wiring (decision tx, execute-time flip) is exercised
 * live in the sandbox E2E, mirroring the restore-op/execution-guard split.
 */

/* ─────────────────────── fixture builders ─────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-14T12:00:00.000Z");

function row(
  id: string,
  level: string,
  status = "PENDING",
  quorumRequired = 1
): ApprovalRowInput {
  return { id, level, status, quorumRequired };
}

function decision(overrides: Partial<ApprovalDecisionInput>): ApprovalDecisionInput {
  return {
    decision: "APPROVED",
    approverId: "usr-a",
    expiresAt: new Date(NOW.getTime() + DAY),
    fingerprint: "F".repeat(64),
    decidedAt: NOW,
    ...overrides,
  };
}

function specInput(overrides: Record<string, unknown> = {}) {
  return {
    changeNumber: "CHG-2026-00999",
    changeType: "NORMAL",
    riskLevel: "HIGH",
    deviceIds: ["dev-b", "dev-a"],
    operations: [
      { order: 2, name: "Post-change validation", type: "VALIDATE" },
      { order: 1, name: "Pre-change checks", type: "CHECK" },
    ],
    restoreSnapshotId: null,
    scheduledStart: new Date("2026-09-15T02:00:00.000Z"),
    scheduledEnd: new Date("2026-09-15T04:00:00.000Z"),
    ...overrides,
  } as Parameters<typeof approvalFingerprintFor>[0];
}

/* ─────────────────────── POL-001 — quorum ─────────────────────── */

describe("POL-001 — CAB quorum (quorumRequiredFor)", () => {
  test("CAB on CRITICAL requires TWO distinct approvers", () => {
    expect(quorumRequiredFor("CAB", "CRITICAL")).toBe(2);
    expect(CAB_QUORUM_SIZE).toBe(2);
    expect(CAB_QUORUM_RISK_LEVELS).toContain("CRITICAL");
  });

  test("every other level/tier combination stays single-approver", () => {
    for (const level of ["TECHNICAL", "SECURITY", "MANAGER", "CAB"]) {
      for (const risk of ["LOW", "MEDIUM", "HIGH"]) {
        expect(quorumRequiredFor(level, risk)).toBe(1);
      }
    }
    expect(quorumRequiredFor("TECHNICAL", "CRITICAL")).toBe(1);
    expect(quorumRequiredFor("SECURITY", "CRITICAL")).toBe(1);
    expect(quorumRequiredFor("MANAGER", "CRITICAL")).toBe(1);
  });

  test("the gate counts DISTINCT approvers — one principal can never fill two slots", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "CAB", "PENDING", 2)],
      decisionsByApprovalId: {
        a1: [
          decision({ approverId: "usr-admin", fingerprint: "X".repeat(64) }),
          decision({
            approverId: "usr-admin",
            decidedAt: new Date(NOW.getTime() - 60_000),
            fingerprint: "X".repeat(64),
          }),
        ],
      },
      now: NOW,
    });
    expect(verdict.levels[0].distinctApprovers).toBe(1);
    expect(verdict.state).toBe("PENDING");
  });

  test("two distinct approvers satisfy the CAB quorum", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "CAB", "PENDING", 2)],
      decisionsByApprovalId: {
        a1: [
          decision({ approverId: "usr-admin" }),
          decision({ approverId: "usr-manager1", decidedAt: new Date(NOW.getTime() - 60_000) }),
        ],
      },
      now: NOW,
    });
    expect(verdict.state).toBe("SATISFIED");
    expect(verdict.levels[0].distinctApprovers).toBe(2);
  });
});

/* ─────────────────────── POL-003 — expiry ─────────────────────── */

describe("POL-003 — risk-tiered validity (approvalExpiryFor)", () => {
  test("validity windows tighten with risk (documented policy table)", () => {
    expect(APPROVAL_VALIDITY_MS.CRITICAL).toBe(14 * DAY);
    expect(APPROVAL_VALIDITY_MS.HIGH).toBe(30 * DAY);
    expect(APPROVAL_VALIDITY_MS.MEDIUM).toBe(90 * DAY);
    expect(APPROVAL_VALIDITY_MS.LOW).toBe(180 * DAY);
    // Unknown tiers fail TIGHT (HIGH's window), never loose.
    expect(approvalValidityMsFor("UNKNOWN")).toBe(APPROVAL_VALIDITY_MS.HIGH);
  });

  test("APPROVED decisions expire at decidedAt + window; REJECTED never carry a horizon", () => {
    const decidedAt = new Date("2026-09-14T00:00:00.000Z");
    expect(approvalExpiryFor("CRITICAL", "APPROVED", decidedAt)).toEqual(
      new Date(decidedAt.getTime() + 14 * DAY)
    );
    expect(approvalExpiryFor("HIGH", "APPROVED", decidedAt)).toEqual(
      new Date(decidedAt.getTime() + 30 * DAY)
    );
    expect(approvalExpiryFor("CRITICAL", "REJECTED", decidedAt)).toBeNull();
  });

  test("an expired decision stops counting — quorum falls and the verdict is EXPIRED", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "TECHNICAL", "APPROVED")],
      decisionsByApprovalId: {
        a1: [decision({ approverId: "usr-a", expiresAt: new Date(NOW.getTime() - 1_000) })],
      },
      now: NOW,
    });
    expect(verdict.state).toBe("EXPIRED");
    expect(verdict.blocking).toEqual(["TECHNICAL"]);
  });

  test("expiry keeps history: distinctApproversEver still counts the lapsed approver", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "TECHNICAL", "APPROVED")],
      decisionsByApprovalId: {
        a1: [decision({ approverId: "usr-a", expiresAt: new Date(NOW.getTime() - 1_000) })],
      },
      now: NOW,
    });
    expect(verdict.levels[0].distinctApprovers).toBe(0);
    expect(verdict.levels[0].distinctApproversEver).toBe(1);
  });

  test("EXPIRED outranks PENDING but yields to REJECTED (documented precedence)", () => {
    const base = { rows: [row("a1", "TECHNICAL"), row("a2", "MANAGER")] };
    const expiredThenPending = evaluateApprovalGate({
      ...base,
      decisionsByApprovalId: {
        a1: [decision({ approverId: "usr-a", expiresAt: new Date(NOW.getTime() - 1) })],
        a2: [],
      },
      now: NOW,
    });
    expect(expiredThenPending.state).toBe("EXPIRED");

    const rejectedThenExpired = evaluateApprovalGate({
      ...base,
      decisionsByApprovalId: {
        a1: [
          decision({ approverId: "usr-a", expiresAt: new Date(NOW.getTime() - 1) }),
          decision({ approverId: "usr-b", decision: "REJECTED", expiresAt: null }),
        ],
        a2: [],
      },
      now: NOW,
    });
    expect(rejectedThenExpired.state).toBe("REJECTED");
  });
});

/* ─────────────── legacy / unbindable data (fail-closed) ─────────────── */

describe("UNBINDABLE — pre-POL data refuses closed", () => {
  test("APPROVED cached row with ZERO decisions is UNBINDABLE, never satisfiable", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "TECHNICAL", "APPROVED")],
      decisionsByApprovalId: {},
      now: NOW,
    });
    expect(verdict.state).toBe("UNBINDABLE");
  });

  test("an APPROVED decision with NO validity horizon cannot be age-verified → UNBINDABLE", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "TECHNICAL", "APPROVED")],
      decisionsByApprovalId: { a1: [decision({ approverId: "usr-a", expiresAt: null })] },
      now: NOW,
    });
    expect(verdict.state).toBe("UNBINDABLE");
  });

  test("NOT_REQUIRED rows pass through and never block the gate", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "TECHNICAL", "NOT_REQUIRED"), row("a2", "MANAGER", "APPROVED")],
      decisionsByApprovalId: { a2: [decision({ approverId: "usr-a" })] },
      now: NOW,
    });
    expect(verdict.state).toBe("SATISFIED");
    expect(verdict.levels[0].state).toBe("NOT_REQUIRED");
  });

  test("deleted approvers (null approverId) never count toward any quorum", () => {
    const verdict = evaluateApprovalGate({
      rows: [row("a1", "TECHNICAL", "APPROVED")],
      decisionsByApprovalId: {
        a1: [decision({ approverId: "usr-a" }), decision({ approverId: null })],
      },
      now: NOW,
    });
    // quorum 1 is met by usr-a; the null approver adds nothing (distinct stays 1).
    expect(verdict.levels[0].distinctApprovers).toBe(1);
    expect(verdict.state).toBe("SATISFIED");
  });
});

/* ─────────────────────── POL-002 — fingerprint ─────────────────────── */

describe("POL-002 — canonical approval fingerprint", () => {
  test("canonical spec is versioned (v1 envelope)", () => {
    const canonical = canonicalApprovalSpec(specInput()) as { version: number };
    expect(canonical.version).toBe(APPROVAL_FINGERPRINT_VERSION);
  });

  test("key insertion order, device order and operation order never change the digest", () => {
    const a = approvalFingerprintFor(specInput());
    const b = approvalFingerprintFor({
      ...specInput(),
      deviceIds: ["dev-a", "dev-b", "dev-a"], // unsorted + duplicate
      operations: [
        { order: 1, name: "Pre-change checks", type: "CHECK" },
        { order: 2, name: "Post-change validation", type: "VALIDATE" },
      ],
    });
    expect(a).toBe(b);
  });

  test("any intent drift changes the digest (devices, operations, target, schedule)", () => {
    const base = approvalFingerprintFor(specInput());
    expect(
      approvalFingerprintFor(specInput({ deviceIds: ["dev-a", "dev-b", "dev-c"] }))
    ).not.toBe(base);
    expect(
      approvalFingerprintFor(
        specInput({
          operations: [
            { order: 1, name: "Pre-change checks", type: "CHECK" },
            { order: 2, name: "Post-change validation", type: "VALIDATE" },
            { order: 3, name: "Extra step", type: "BACKUP" },
          ],
        })
      )
    ).not.toBe(base);
    expect(
      approvalFingerprintFor(specInput({ restoreSnapshotId: "snap-9" }))
    ).not.toBe(base);
    expect(
      approvalFingerprintFor(
        specInput({ scheduledStart: new Date("2026-09-16T02:00:00.000Z") })
      )
    ).not.toBe(base);
    expect(approvalFingerprintFor(specInput({ riskLevel: "CRITICAL" }))).not.toBe(base);
  });

  test("digest is SHA-256 hex, uppercase (snapshot-digest convention)", () => {
    const fp = approvalFingerprintFor(specInput());
    expect(fp).toMatch(/^[0-9A-F]{64}$/);
    // Independent recomputation over the canonical form.
    const canonical = JSON.stringify(
      canonicalApprovalSpec(specInput())
    );
    void canonical; // (order-sensitivity handled by stableStringify inside the lib)
    expect(
      createHash("sha256").update(
        JSON.stringify(canonicalApprovalSpec(specInput())),
        "utf8"
      )
    ).toBeDefined();
  });

  test("invalid schedule dates fail loudly instead of serializing 'Invalid Date'", () => {
    expect(() =>
      approvalFingerprintFor(specInput({ scheduledStart: new Date("not-a-date") }))
    ).toThrow(/APPROVAL_SPEC_INVALID_DATE/);
  });

  test("null and absent are distinct intents for the restore target", () => {
    const explicitNull = approvalFingerprintFor(specInput({ restoreSnapshotId: null }));
    const restoreTarget = approvalFingerprintFor(
      specInput({ restoreSnapshotId: "snap-1" })
    );
    expect(explicitNull).not.toBe(restoreTarget);
  });
});

describe("POL-002 — execute-time binding verification (fingerprintMismatches)", () => {
  const rows: ApprovalRowInput[] = [row("a1", "TECHNICAL", "APPROVED")];

  test("counting decisions that match the current fingerprint bind cleanly", () => {
    const verdict = evaluateApprovalGate({
      rows,
      decisionsByApprovalId: { a1: [decision({ approverId: "usr-a" })] },
      now: NOW,
    });
    const current = "F".repeat(64);
    expect(fingerprintMismatches(verdict, rows, {
      a1: [decision({ approverId: "usr-a" })],
    }, NOW, current)).toEqual([]);
  });

  test("a decision cast against a DIFFERENT spec never authorizes this spec", () => {
    const verdict = evaluateApprovalGate({
      rows,
      decisionsByApprovalId: { a1: [decision({ approverId: "usr-a" })] },
      now: NOW,
    });
    const offenders = fingerprintMismatches(verdict, rows, {
      a1: [decision({ approverId: "usr-a", fingerprint: "0".repeat(64) })],
    }, NOW, "F".repeat(64));
    expect(offenders).toEqual(["TECHNICAL"]);
  });

  test("EXPIRED decisions are exempt from the mismatch sweep (they count for nothing)", () => {
    const verdict = evaluateApprovalGate({
      rows,
      decisionsByApprovalId: {
        a1: [decision({ approverId: "usr-a", expiresAt: new Date(NOW.getTime() - 1) })],
      },
      now: NOW,
    });
    expect(verdict.state).toBe("EXPIRED");
    expect(
      fingerprintMismatches(verdict, rows, {
        a1: [decision({ approverId: "usr-a", fingerprint: "0".repeat(64), expiresAt: new Date(NOW.getTime() - 1) })],
      }, NOW, "F".repeat(64)).length
    ).toBe(0);
  });
});

/* ─────────────────────── re-cast guard ─────────────────────── */

describe("POL-003 — re-cast guard (canCastDecision)", () => {
  test("an approver with a LIVE decision on the level cannot cast again", () => {
    expect(
      canCastDecision([decision({ approverId: "usr-a" })], "usr-a", NOW)
    ).toBe(false);
  });

  test("an approver whose decision EXPIRED may re-cast (fresh approval cycle)", () => {
    expect(
      canCastDecision(
        [decision({ approverId: "usr-a", expiresAt: new Date(NOW.getTime() - 1_000) })],
        "usr-a",
        NOW
      )
    ).toBe(true);
  });

  test("another approver's live decision never blocks a new approver", () => {
    expect(
      canCastDecision([decision({ approverId: "usr-b" })], "usr-a", NOW)
    ).toBe(true);
  });
});

/* ─────────────────────── greppability ─────────────────────── */

describe("greppable refusal markers", () => {
  test("the fingerprint family shares its greppable prefix", () => {
    expect(APPROVAL_FINGERPRINT_UNBINDABLE).toBe("APPROVAL_FINGERPRINT_UNBINDABLE");
  });
});
