/**
 * FayaNMS — bindable approval gate loader (server-side companion to
 * approval-policy.ts). ONE implementation for both consumers:
 *   - POST /api/v1/changes/[id]/approvals (decision recording + gate
 *     re-evaluation), and
 *   - POST /api/v1/changes/[id]/execute (execution-time re-verification),
 * so the cached ChangeApproval.status and the execute verdict can never
 * drift apart.
 *
 * Server-only (imports the db client + node:crypto via fingerprint.ts).
 */

import { db } from "@/lib/db";
import {
  evaluateApprovalGate,
  fingerprintMismatches,
  type ApprovalDecisionInput,
  type ApprovalGateVerdict,
  type ApprovalRowInput,
} from "./approval-policy";
import { approvalFingerprintFor } from "./fingerprint";

/**
 * The transaction client handed to interactive `db.$transaction` callbacks.
 * Deliberately EXTRACTED from the client rather than spelled
 * `Prisma.TransactionClient`: the exported `db` is an $extends-wrapped
 * client (audit hash-chain stamping), and its tx delegates carry the
 * extension's type parameters — the plain base type is not assignable.
 */
type DbTx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

export interface ApprovalGateSnapshot {
  change: {
    id: string;
    number: string;
    status: string;
    riskLevel: string;
    approvalFingerprint: string | null;
  };
  /** Current spec fingerprint (recomputed from the live rows). */
  currentFingerprint: string;
  rows: ApprovalRowInput[];
  decisionsByApprovalId: Record<string, ApprovalDecisionInput[]>;
  verdict: ApprovalGateVerdict;
  /** SATISFIED levels whose counting decisions disagree with the current
   * fingerprint (POL-002 fail-closed — empty when bindings hold). */
  mismatchedLevels: string[];
}

/** Load change spec + approval rows + decisions and evaluate the gate. */
export async function loadApprovalGate(
  changeId: string,
  now: Date,
  client?: DbTx
): Promise<ApprovalGateSnapshot | null> {
  const tx = client ?? db;

  const change = await tx.changeRequest.findUnique({
    where: { id: changeId },
    select: {
      id: true,
      number: true,
      status: true,
      riskLevel: true,
      type: true,
      restoreSnapshotId: true,
      scheduledStart: true,
      scheduledEnd: true,
      approvalFingerprint: true,
      devices: { select: { deviceId: true } },
      steps: { select: { order: true, name: true, type: true }, orderBy: { order: "asc" } },
    },
  });
  if (!change) return null;

  const rows = await tx.changeApproval.findMany({
    where: { changeId: change.id },
    select: { id: true, level: true, status: true, quorumRequired: true },
  });

  const decisions = rows.length
    ? await tx.changeApprovalDecision.findMany({
        where: { approvalId: { in: rows.map((row) => row.id) } },
        select: {
          approvalId: true,
          decision: true,
          approverId: true,
          approverName: true,
          fingerprint: true,
          decidedAt: true,
          expiresAt: true,
        },
        orderBy: { decidedAt: "asc" },
      })
    : [];

  const decisionsByApprovalId: Record<string, ApprovalDecisionInput[]> = {};
  for (const decision of decisions) {
    (decisionsByApprovalId[decision.approvalId] ??= []).push({
      decision: decision.decision,
      approverId: decision.approverId,
      approverName: decision.approverName,
      fingerprint: decision.fingerprint,
      decidedAt: decision.decidedAt,
      expiresAt: decision.expiresAt,
    });
  }

  const currentFingerprint = approvalFingerprintFor({
    changeNumber: change.number,
    changeType: change.type,
    riskLevel: change.riskLevel,
    deviceIds: change.devices.map((device) => device.deviceId),
    operations: change.steps.map((step) => ({
      order: step.order,
      name: step.name,
      type: step.type,
    })),
    restoreSnapshotId: change.restoreSnapshotId,
    scheduledStart: change.scheduledStart,
    scheduledEnd: change.scheduledEnd,
  });

  const verdict = evaluateApprovalGate({ rows, decisionsByApprovalId, now });
  const mismatchedLevels = fingerprintMismatches(
    verdict,
    rows,
    decisionsByApprovalId,
    now,
    currentFingerprint
  );

  return {
    change: {
      id: change.id,
      number: change.number,
      status: change.status,
      riskLevel: change.riskLevel,
      approvalFingerprint: change.approvalFingerprint,
    },
    currentFingerprint,
    rows,
    decisionsByApprovalId,
    verdict,
    mismatchedLevels,
  };
}
