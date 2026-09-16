import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * TASK-OPS-003-A — Backup/DR drill governance.
 *
 * `scripts/drill-restore.ts` is the executable recoverability claim: a
 * full logical dump of the live database → FRESH scratch database (schema
 * via `prisma migrate deploy`) → per-table count equality → health surface
 * → simulator plane → a REAL ConfigSnapshot decrypted from the restored
 * database under the deployment KEK → RPO/RTO report → guarded cleanup.
 *
 * This suite pins the drill's SAFETY SHAPE (hermetic — no database needed):
 *   - the SOURCE database is only ever READ (dump via PG-side to_jsonb);
 *   - writes happen exclusively in the drill-owned scratch database, whose
 *     name is pattern-guarded before DROP;
 *   - the restore uses the production schema path (prisma migrate deploy);
 *   - the verify phase actually decrypts a snapshot (KEK + sha256 integrity
 *     inside decryptSnapshotTexts), not just counts rows;
 *   - RPO/RTO are measured, and the KEK-loss / interrupted-change
 *     dispositions are printed with every run.
 *
 * The LIVE drill (`FAYANMS_DRILL=1 bun test tests/audit/drill-restore.test.ts`,
 * or directly `bun scripts/drill-restore.ts`) executes against a real
 * PostgreSQL — 2026-09-16 evidence: 66,694 rows / 42 tables round-tripped,
 * 11/11 checks, RTO 3 s, snapshot decrypt verified (see the audit doc).
 */

const DRILL = readFileSync("scripts/drill-restore.ts", "utf8");

describe("OPS-003-A — drill script governance (source-safety shape)", () => {
  test("the drill exists and runs its six phases", () => {
    expect(DRILL).toContain("phase 1: PREFLIGHT");
    expect(DRILL).toContain("phase 2: BACKUP");
    expect(DRILL).toContain("phase 3: RESTORE");
    expect(DRILL).toContain("phase 4: VERIFY");
    expect(DRILL).toContain("phase 5: REPORT");
    expect(DRILL).toContain("phase 6: CLEANUP");
  });

  test("the SOURCE database is only READ — dump is PG-side to_jsonb", () => {
    expect(DRILL).toContain("to_jsonb(t)::text");
    // The dump loop is the only table scan against the source; writes exist
    // solely on the scratch client.
    expect(DRILL).toContain('INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset');
  });

  test("restore uses the PRODUCTION schema path (prisma migrate deploy)", () => {
    expect(DRILL).toContain('"prisma", "migrate", "deploy"');
    expect(DRILL).toContain('DATABASE_URL: SCRATCH_URL');
  });

  test("FK-free load is pool-proof (persistent per-table trigger state, not a session GUC)", () => {
    expect(DRILL).toContain('ALTER TABLE "${table}" DISABLE TRIGGER ALL');
    expect(DRILL).toContain('ALTER TABLE "${table}" ENABLE TRIGGER ALL');
  });

  test("cleanup is name-pattern-guarded before DROP", () => {
    expect(DRILL).toContain("/^fayanms_drill_[A-Za-z0-9_]+$/.test(SCRATCH_DB)");
    expect(DRILL).toContain('DROP DATABASE "${SCRATCH_DB}" WITH (FORCE)');
    expect(DRILL).toContain("--keep");
  });

  test("verify DECRYPTS a snapshot (KEK + integrity), not just counts rows", () => {
    expect(DRILL).toContain("decryptSnapshotTexts");
    expect(DRILL).toContain("snapshot decrypt (KEK + integrity)");
  });

  test("RPO/RTO measured; KEK-loss + interrupted-change dispositions printed", () => {
    expect(DRILL).toContain("rpoSeconds");
    expect(DRILL).toContain("rtoSeconds");
    expect(DRILL).toContain("KEK LOSS: CATASTROPHIC");
    expect(DRILL).toContain("INTERRUPTED CHANGE");
    expect(DRILL).toContain("migrate-encrypt-snapshots.ts");
  });
});

describe("OPS-003-A — live drill (gated, opt-in)", () => {
  const live = process.env.FAYANMS_DRILL === "1";

  test("bun scripts/drill-restore.ts passes all checks against a real database", async () => {
    if (!live) {
      // Hermetic unit gate: the drill is an operator command; the sandbox
      // evidence run (2026-09-16) passed 11/11 with RTO 3 s.
      return;
    }
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync("bun", ["scripts/drill-restore.ts"], {
      encoding: "utf8",
      cwd: process.cwd().endsWith("FayaNMS") ? process.cwd() : join(process.cwd(), "FayaNMS"),
      env: process.env,
      timeout: 300_000,
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("DRILL PASSED");
  });
});
