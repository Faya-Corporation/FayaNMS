/**
 * FayaNMS — SAFE-008/009: typed snapshot-exact restore (pure half).
 *
 * The external ULTRA audit's P0-004: the guarded restore route filed a
 * change whose PROSE named the target snapshot, but the execution engine
 * never consumed it — a "restore to snapshot vN" ran the generic
 * description-marker plan instead (i.e. an approved restore silently did
 * something else). SAFE-008 closes the defect:
 *
 *   1. The approved restore target travels as DATA on the change row
 *      (ChangeRequest.restoreSnapshotId — set once at creation, immutable
 *      afterwards, SetNull on snapshot deletion).
 *   2. The engine resolves that target BEFORE any device contact and
 *      classifies every unresolvable/tampered case into a typed refusal
 *      (classifyRestoreTarget) — the change fails closed, zero contact.
 *   3. The simulator data plane commits EXACTLY the approved snapshot text
 *      (worker /simulate/restore — sha-verified before commit) and the
 *      engine records the committed bytes as the job's POST_CHANGE
 *      snapshot, then asserts the commit echo (restoreCommitEchoOk):
 *      recorded sha256 === approved sha256.
 *   4. VALIDATE (SAFE-009) re-asserts the equality from the audit trail —
 *      a restore is only "validated" when the committed configuration IS
 *      the approved snapshot, byte for byte.
 *
 * The LIVE_SSH plane still refuses restore-flow changes fail-closed
 * (LIVE_RESTORE_NOT_CERTIFIED in live-plan.ts): its certified transport
 * surface is bounded description-marker deltas, not full-config pushes.
 *
 * Pure functions only — no DB, no worker calls, no clock. The engine owns
 * all I/O; these helpers own the decisions, so the tests pin the contract
 * without a database (mirrors apply-disposition.ts / execution-guard.ts).
 */

/* ───────────────────────── typed target resolution ──────────────────────── */

/** Machine-readable refusal codes surfaced in ChangeStep.error + audit. */
export type RestoreTargetCode =
  | "RESTORE_TARGET_UNSET" // RESTORE_SNAPSHOT change with no target column (legacy/defensive)
  | "RESTORE_TARGET_NOT_FOUND" // target snapshot row deleted (SetNull ⇒ id null) or vanished
  | "RESTORE_TARGET_CROSS_DEVICE" // target snapshot belongs to a device outside the change scope
  | "RESTORE_TARGET_INTEGRITY"; // stored text failed its own sha256 digest (decrypt layer threw)

/** The engine's typed refusal message prefix (greppable in step errors). */
export const RESTORE_TARGET_REFUSAL_PREFIX = "RESTORE_TARGET_UNRESOLVABLE";

/** Decrypted, verified target-snapshot data the engine hands to the classifier. */
export interface RestoreTargetData {
  id: string;
  deviceId: string;
  version: number;
  sha256: string;
  /** DECRYPTED raw text — digest-verified by the config-crypto layer. */
  rawText: string;
}

export type RestoreTargetVerdict =
  | { ok: true; target: RestoreTargetData }
  | { ok: false; code: RestoreTargetCode; message: string };

/**
 * Classify the approved restore target from already-loaded data.
 *
 * `rawTextPresent=false` models the decrypt/integrity failure (the crypto
 * layer throws CONFIG_INTEGRITY_FAIL on a digest mismatch — the engine maps
 * that to this classifier with the text withheld) so the whole resolution
 * contract is pinned without a database.
 */
export function classifyRestoreTarget(input: {
  restoreSnapshotId: string | null | undefined;
  target: RestoreTargetData | null;
  rawTextPresent: boolean;
  changeDeviceIds: string[];
}): RestoreTargetVerdict {
  const { restoreSnapshotId, target, rawTextPresent, changeDeviceIds } = input;

  if (!restoreSnapshotId) {
    return {
      ok: false,
      code: "RESTORE_TARGET_UNSET",
      message:
        `${RESTORE_TARGET_REFUSAL_PREFIX}: the change is stamped RESTORE_SNAPSHOT but carries ` +
        `no approved restore target (restoreSnapshotId is null) — refusing to guess a substitute`,
    };
  }
  if (!target) {
    return {
      ok: false,
      code: "RESTORE_TARGET_NOT_FOUND",
      message:
        `${RESTORE_TARGET_REFUSAL_PREFIX}: the approved restore snapshot (${restoreSnapshotId}) ` +
        `no longer exists — refusing to execute a restore without its approved target`,
    };
  }
  if (!rawTextPresent) {
    return {
      ok: false,
      code: "RESTORE_TARGET_INTEGRITY",
      message:
        `${RESTORE_TARGET_REFUSAL_PREFIX}: the approved restore snapshot v${target.version} ` +
        `failed its stored sha256 digest (possible ciphertext substitution) — refusing to push ` +
        `unverified bytes to any device`,
    };
  }
  if (!changeDeviceIds.includes(target.deviceId)) {
    return {
      ok: false,
      code: "RESTORE_TARGET_CROSS_DEVICE",
      message:
        `${RESTORE_TARGET_REFUSAL_PREFIX}: the approved restore snapshot v${target.version} belongs ` +
        `to a device outside this change's scope — refusing a cross-device restore`,
    };
  }
  return { ok: true, target };
}

/* ───────────────────────── commit-echo integrity (SAFE-009) ─────────────── */

/**
 * The commit echo is verified ONLY on exact sha256 equality (canonical
 * lowercase hex, as produced by the config-crypto layer and the worker's
 * node:crypto digest). A null/empty committed sha is never a match.
 */
export function restoreCommitEchoOk(
  committedSha: string | null | undefined,
  targetSha: string
): boolean {
  if (!committedSha) return false;
  return committedSha === targetSha;
}

/* ───────────────────────────── size bound ───────────────────────────────── */

/**
 * Upper bound for a simulator-plane restore commit (256 KiB of UTF-8).
 * Real running configs for the certified flavors sit well below this; the
 * bound keeps a hostile/faulty target from streaming unbounded payloads at
 * the worker, and is re-checked app-side on the echo.
 */
export const RESTORE_COMMIT_MAX_BYTES = 262_144;

export function isRestoreCommitSizeOk(configText: string): boolean {
  return Buffer.byteLength(configText, "utf8") <= RESTORE_COMMIT_MAX_BYTES;
}

/* ───────────────────────────── audit actions ────────────────────────────── */

/** Successful snapshot-exact restore commit (per change, in the apply tx). */
export const RESTORE_APPLIED_AUDIT_ACTION = "RESTORE_APPLIED";

/** Fail-closed restore refusal (target resolution, live boundary, echo). */
export const RESTORE_REFUSED_AUDIT_ACTION = "RESTORE_REFUSED";

/* ─────────────────────── VALIDATE output builder (SAFE-009) ─────────────── */

export interface RestoreValidateRow {
  hostname: string;
  /** sha256 of the job's recorded POST_CHANGE snapshot (the commit echo). */
  committedSha: string | null;
  /** sha256 of the approved target snapshot. */
  targetSha: string;
}

/** One truthful, deterministic output line per device (input order kept). */
export function buildRestoreValidateOutputs(rows: RestoreValidateRow[]): string[] {
  return rows.map((row) =>
    restoreCommitEchoOk(row.committedSha, row.targetSha)
      ? `${row.hostname} — running config verified byte-exact vs approved snapshot (sha ${shortSha(row.targetSha)})`
      : `${row.hostname} — MISMATCH: committed config (sha ${row.committedSha ? shortSha(row.committedSha) : "none"}) does not equal the approved snapshot (sha ${shortSha(row.targetSha)})`
  );
}

function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}
