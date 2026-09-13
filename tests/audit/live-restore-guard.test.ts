import { describe, expect, test } from "bun:test";

import {
  CHANGE_OPERATION_KINDS,
  isRestoreOperation,
  LIVE_RESTORE_NOT_CERTIFIED,
} from "../../src/lib/change/live-plan";

/**
 * SAFE-007 (production-safety sprint) — typed operation kind + live-restore
 * fail-closed guard. The external ULTRA audit's P0-004: the restore flow
 * files a change whose prose names the target snapshot, but the engine's
 * live APPLY plane runs the generic description-marker plan — an approved
 * "restore to snapshot vN" would silently do something else. Until typed
 * snapshot-exact restore exists (SAFE-008/009), restore-flow changes must
 * be refused on the LIVE plane BEFORE any device contact.
 *
 * The route guard is `isRestoreOperation(change.operationKind) &&
 * change.devices.some(isLiveDeviceLink)` — this suite pins the pure half
 * (the kind classifier + refusal contract) so legacy GENERIC rows can
 * never be accidentally swept into the guard, and unknown kinds fail OPEN
 * for GENERIC semantics but never classify as restore.
 */
describe("SAFE-007 — live restore guard", () => {
  test("operation kind catalog is exactly GENERIC | RESTORE_SNAPSHOT", () => {
    expect([...CHANGE_OPERATION_KINDS].sort()).toEqual([
      "GENERIC",
      "RESTORE_SNAPSHOT",
    ]);
  });

  test("RESTORE_SNAPSHOT is classified as a restore operation", () => {
    expect(isRestoreOperation("RESTORE_SNAPSHOT")).toBe(true);
  });

  test("GENERIC (and legacy null/undefined rows) never classify as restore", () => {
    expect(isRestoreOperation("GENERIC")).toBe(false);
    expect(isRestoreOperation(null)).toBe(false);
    expect(isRestoreOperation(undefined)).toBe(false);
    expect(isRestoreOperation("")).toBe(false);
  });

  test("unknown kinds fail open toward GENERIC (never as restore)", () => {
    // The guard must require the explicitly stamped kind; any other value
    // behaves like the historical default so pre-SAFE-007 rows execute
    // exactly as before.
    expect(isRestoreOperation("SOMETHING_ELSE")).toBe(false);
    expect(isRestoreOperation("restore_snapshot")).toBe(false); // case-sensitive stamp
  });

  test("refusal is a typed, greppable engine error naming the SAFE IDs", () => {
    // The step error surfaces in ChangeStep.error and the operator UI —
    // it must identify the guard (LIVE_RESTORE_NOT_CERTIFIED) and the
    // follow-up work (SAFE-008/009), and state the no-contact invariant.
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("LIVE_RESTORE_NOT_CERTIFIED");
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("SAFE-008/009");
    expect(LIVE_RESTORE_NOT_CERTIFIED).toContain("no device was contacted");
  });
});
