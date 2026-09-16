/**
 * TASK-OPS-003-A — Backup / DR drill (scripts/drill-restore.ts).
 *
 * Proves recoverability end-to-end against the LIVE database WITHOUT ever
 * writing to it:
 *
 *   1. PREFLIGHT — source reachable, drill role is superuser (ALTER DATABASE
 *      for FK-free load), table set enumerated, no writes to the source.
 *   2. BACKUP   — full logical dump: every public table serialized row-by-row
 *      with PG-SIDE to_jsonb (types incl. timestamps/bytea ride through JSON
 *      faithfully), plus a manifest (table row counts, git SHA, timing).
 *   3. RESTORE  — a FRESH scratch database (fayanms_drill_<ts>): schema via
 *      `prisma migrate deploy` (the production restore path), data loaded
 *      with jsonb_populate_recordset, sequence fix-ups applied.
 *   4. VERIFY   — per-table row counts source ≡ restored; health counts;
 *      simulator plane present; a REAL ConfigSnapshot decrypted from the
 *      restored database with the deployment KEK (integrity digest verified
 *      inside decryptSnapshotTexts).
 *   5. REPORT   — RPO/RTO measured and written next to the dump; interrupted-
 *      change and KEK-loss dispositions printed.
 *   6. CLEANUP  — the scratch database is DROPPED (name-pattern-guarded)
 *      unless --keep.
 *
 * pg_dump is unavailable in the embedded Zonky distribution (initdb/pg_ctl/
 * postgres only) — the drill therefore ships its own logical dumper. The
 * PRODUCTION runbook (docs/deploy, Phase D1) uses pg_dump -Fc + pg_restore
 * on a fresh host/container; this drill executes the same lifecycle with
 * zero additional tooling so the recoverability claim stays continuously
 * testable. Fresh-DB restore here; fresh-HOST restore is the runbook path.
 *
 * Usage:
 *   bun scripts/drill-restore.ts [--keep] [--source-url postgresql://...]
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { PrismaClient } from "@prisma/client";

import { decryptSnapshotTexts } from "../src/lib/config/crypto";

/* ── CLI ─────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const sourceUrlArg = args.includes("--source-url")
  ? args[args.indexOf("--source-url") + 1]
  : undefined;

const SOURCE_URL = sourceUrlArg ?? process.env.DATABASE_URL ?? "";
if (!SOURCE_URL.startsWith("postgresql://") && !SOURCE_URL.startsWith("postgres://")) {
  console.error(
    "[drill] DATABASE_URL (or --source-url) must be a postgres:// URL — refusing to guess. (Direct script runs do NOT auto-load .env — export DATABASE_URL explicitly.)",
  );
  process.exit(1);
}

const RUN_ID = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\..+/, "")
  .replace("T", "_");
const SCRATCH_DB = `fayanms_drill_${RUN_ID}`;
const SCRATCH_URL = SOURCE_URL.replace(/\/[^/?]+(\?|$)/, `/${SCRATCH_DB}$2`);
const WORK_DIR = join(tmpdir(), `fayanms-drill-${RUN_ID}`);

const tableOk = (name: string) => /^[A-Za-z0-9_]+$/.test(name);

const source = new PrismaClient({ datasources: { db: { url: SOURCE_URL } } });
const t0 = Date.now();
const timings: Record<string, number> = {};
const results: Array<{ check: string; detail: string; ok: boolean }> = [];

function record(check: string, detail: string, ok: boolean): void {
  results.push({ check, detail, ok });
  console.log(`  ${ok ? "✓" : "✗"} ${check} — ${detail}`);
  if (!ok) process.exitCode = 1;
}

/* ── 1. PREFLIGHT ────────────────────────────────────────────────────────── */

console.log(`[drill] run ${RUN_ID} — work dir ${WORK_DIR}`);
console.log("[drill] phase 1: PREFLIGHT (read-only against the source)");

const preflightStart = Date.now();
await source.$queryRawUnsafe("SELECT 1");
record("source reachable", "SELECT 1 ok", true);

const superRow = await source.$queryRawUnsafe<Array<{ rolsuper: boolean }>>(
  `SELECT rolsuper FROM pg_roles WHERE rolname = current_user`,
);
const isSuper = superRow[0]?.rolsuper === true;
record(
  "drill role privileges",
  isSuper ? "superuser — scratch load can disable FK triggers" : "NOT superuser — fresh-database FK-free load unavailable",
  isSuper,
);

const tableRows = await source.$queryRawUnsafe<Array<{ tablename: string }>>(
  `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations' ORDER BY tablename`,
);
const TABLES = tableRows.map((r) => r.tablename).filter(tableOk);
record("table inventory", `${TABLES.length} public tables (excl. _prisma_migrations)`, TABLES.length > 0);
timings.preflightMs = Date.now() - preflightStart;

/* ── 2. BACKUP (logical dump) ────────────────────────────────────────────── */

console.log("[drill] phase 2: BACKUP (logical dump via PG-side to_jsonb)");
const backupStart = Date.now();
mkdirSync(WORK_DIR, { recursive: true });

const dumpCounts: Record<string, number> = {};
for (const table of TABLES) {
  const rows = await source.$queryRawUnsafe<Array<{ json: string }>>(
    `SELECT to_jsonb(t)::text AS json FROM "${table}" t`,
  );
  dumpCounts[table] = rows.length;
  if (rows.length > 0) {
    writeFileSync(
      join(WORK_DIR, `dump-${table}.ndjson`),
      rows.map((r) => r.json).join("\n"),
    );
  }
}
const totalRows = Object.values(dumpCounts).reduce((a, b) => a + b, 0);
record("logical dump", `${totalRows} rows across ${TABLES.length} tables → ${WORK_DIR}`, true);
timings.backupMs = Date.now() - backupStart;

let gitSha = "unknown";
try {
  gitSha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim() || "unknown";
} catch {
  /* non-repo run */
}

writeFileSync(
  join(WORK_DIR, "manifest.json"),
  JSON.stringify(
    {
      runId: RUN_ID,
      takenAt: new Date().toISOString(),
      sourceDb: SOURCE_URL.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@"),
      gitSha,
      method: "logical to_jsonb dump (pg_dump unavailable in the embedded Zonky distro; production runbook: pg_dump -Fc + pg_restore)",
      tables: dumpCounts,
      totalRows,
    },
    null,
    2,
  ),
);

/* ── 3. RESTORE into a FRESH scratch database ───────────────────────────── */

console.log(`[drill] phase 3: RESTORE (fresh database ${SCRATCH_DB})`);
const restoreStart = Date.now();

await source.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
if (isSuper) {
  // The scratch DB is drill-owned: FK triggers disabled for the bulk load
  // (database-wide default → every pooled connection inherits it).
  await source.$executeRawUnsafe(
    `ALTER DATABASE "${SCRATCH_DB}" SET session_replication_role = replica`,
  );
}

const schema = spawnSync("bunx", ["prisma", "migrate", "deploy"], {
  cwd: resolve(import.meta.dir, ".."),
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: SCRATCH_URL },
});
if (schema.status !== 0) {
  console.error(`[drill] migrate deploy failed:\n${schema.stdout}\n${schema.stderr}`);
  process.exit(1);
}
record("schema restore", "prisma migrate deploy (production restore path) on the fresh database", true);

const scratch = new PrismaClient({ datasources: { db: { url: SCRATCH_URL } } });
await scratch.$queryRawUnsafe("SELECT 1");

// FK-free bulk load, pool-proof: DISABLE/ENABLE TRIGGER ALL is PERSISTENT
// TABLE STATE (not a session GUC), so every pooled connection obeys it. A
// topological insert order is applied anyway as defense in depth. Requires
// superuser (preflight-enforced); pg_restore's --disable-triggers does the
// equivalent on the production runbook path.
const fkRows = await scratch.$queryRawUnsafe<Array<{ tbl: string; ref: string }>>(
  `SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS ref
     FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace`,
);
const deps = new Map<string, Set<string>>();
for (const table of TABLES) deps.set(table, new Set());
for (const fk of fkRows) {
  const tbl = fk.tbl.replace(/"/g, "");
  const ref = fk.ref.replace(/"/g, "");
  if (deps.has(tbl) && deps.has(ref) && tbl !== ref) deps.get(tbl)!.add(ref);
}
const INSERT_ORDER: string[] = [];
const remaining = new Set(TABLES);
let cycleNote: string | null = null;
while (remaining.size > 0) {
  const ready = TABLES.filter(
    (t) => remaining.has(t) && [...deps.get(t)!].every((d) => !remaining.has(d)),
  );
  if (ready.length === 0) {
    // Genuine FK cycle (bidirectional relations). The per-table trigger
    // disabling below is the load-bearing mechanism — order is advisory.
    cycleNote = [...remaining].sort().join(", ");
    for (const t of TABLES) {
      if (remaining.has(t)) INSERT_ORDER.push(t);
    }
    break;
  }
  for (const t of ready) {
    INSERT_ORDER.push(t);
    remaining.delete(t);
  }
}
if (cycleNote) {
  console.log(`[drill] FK cycle (loaded under disabled triggers): ${cycleNote}`);
}

let restoredRows = 0;
for (const table of INSERT_ORDER) {
  const dumpPath = join(WORK_DIR, `dump-${table}.ndjson`);
  if (!(await Bun.file(dumpPath).exists())) continue; // empty table — nothing dumped
  const raw = await Bun.file(dumpPath).text();
  if (!raw.trim()) continue;
  await scratch.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`);
  try {
    const lines = raw.split("\n");
    const CHUNK = 400;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = `[${lines.slice(i, i + CHUNK).join(",")}]`;
      await scratch.$queryRawUnsafe(
        `INSERT INTO "${table}" SELECT * FROM jsonb_populate_recordset(null::"${table}", $1::jsonb)`,
        chunk,
      );
    }
    restoredRows += lines.length;
  } finally {
    await scratch.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER ALL`);
  }
}
record("data restore", `${restoredRows} rows loaded (FK triggers disabled per table, topological order)`, restoredRows === totalRows);

// Sequence fix-ups (no-op when every id is app-assigned, e.g. cuid).
const seqs = await scratch.$queryRawUnsafe<Array<{ sequencename: string; tbl: string; col: string }>>(
  `SELECT s.sequencename, d.refobjid::regclass::text AS tbl, a.attname AS col
     FROM pg_sequences s
     JOIN pg_class c ON c.relname = s.sequencename AND c.relnamespace = 'public'::regnamespace
     JOIN pg_depend d ON d.objid = c.oid AND d.deptype = 'a'
     JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE s.schemaname = 'public'`,
);
for (const seq of seqs) {
  if (!tableOk(seq.tbl) || !tableOk(seq.col)) continue;
  await scratch.$executeRawUnsafe(
    `SELECT setval(pg_get_serial_sequence('"${seq.tbl}"', '${seq.col}'), COALESCE((SELECT MAX("${seq.col}") FROM "${seq.tbl}"), 0) + 1, false)`,
  );
}
record("sequence fix-ups", `${seqs.length} serial sequence(s) advanced`, true);
timings.restoreMs = Date.now() - restoreStart;

/* ── 4. VERIFY ───────────────────────────────────────────────────────────── */

console.log("[drill] phase 4: VERIFY (counts, health, simulator plane, snapshot decrypt)");
const verifyStart = Date.now();

let countMismatches = 0;
for (const table of TABLES) {
  const srcCount = await source.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
  const rstCount = await scratch.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "${table}"`);
  const a = Number(srcCount[0].n);
  const b = Number(rstCount[0].n);
  if (a !== b) {
    countMismatches += 1;
    record(`count ${table}`, `source=${a} restored=${b}`, false);
  }
}
record(
  "row counts source ≡ restored",
  countMismatches === 0 ? `all ${TABLES.length} tables match` : `${countMismatches} mismatched table(s)`,
  countMismatches === 0,
);

const health = await scratch.$queryRawUnsafe<Array<{ users: bigint; devices: bigint; audits: bigint; jobs: bigint; snapshots: bigint }>>(
  `SELECT (SELECT COUNT(*) FROM "User")::bigint AS users,
          (SELECT COUNT(*) FROM "Device")::bigint AS devices,
          (SELECT COUNT(*) FROM "AuditEvent")::bigint AS audits,
          (SELECT COUNT(*) FROM "JobExecution")::bigint AS jobs,
          (SELECT COUNT(*) FROM "ConfigSnapshot")::bigint AS snapshots`,
);
const h = health[0];
record(
  "restored health surface",
  `users=${Number(h.users)} devices=${Number(h.devices)} audits=${Number(h.audits)} jobs=${Number(h.jobs)} snapshots=${Number(h.snapshots)}`,
  Number(h.users) > 0 && Number(h.devices) > 0,
);

const simDevices = await scratch.$queryRawUnsafe<Array<{ n: bigint }>>(
  `SELECT COUNT(*)::bigint AS n FROM "Device" WHERE "dataSource" = 'SIMULATOR'`,
);
record(
  "simulator plane restored",
  `${Number(simDevices[0].n)} SIMULATOR device(s) present`,
  Number(simDevices[0].n) > 0,
);

const snapshot = await scratch.$queryRawUnsafe<
  Array<{
    id: string;
    deviceId: string;
    version: number;
    rawText: string;
    normalizedText: string | null;
    sha256: string | null;
    encKeyId: string | null;
    encIv: string | null;
    encTag: string | null;
    normIv: string | null;
    normTag: string | null;
    wrappedDek: string | null;
    wrapIv: string | null;
    wrapTag: string | null;
    encAad: string | null;
  }>
>(`SELECT * FROM "ConfigSnapshot" ORDER BY "createdAt" DESC LIMIT 1`);
if (snapshot.length === 0) {
  record("snapshot decrypt", "no ConfigSnapshot rows exist — decrypt check not applicable", true);
} else {
  try {
    const row = snapshot[0];
    const decrypted = decryptSnapshotTexts(row);
    const size = Buffer.byteLength(decrypted.rawText, "utf8");
    const digestOk = decrypted.rawText.length > 0;
    record(
      "snapshot decrypt (KEK + integrity)",
      `snapshot ${row.id} v${row.version} decrypted from the RESTORED database — ${size} bytes, sha256 digest ${row.sha256 ? "verified" : "unpinned (legacy)"}`,
      digestOk,
    );
  } catch (error) {
    record("snapshot decrypt (KEK + integrity)", (error as Error).message.slice(0, 160), false);
  }
}
timings.verifyMs = Date.now() - verifyStart;

/* ── 5. REPORT (RPO/RTO + dispositions) ─────────────────────────────────── */

const totalMs = Date.now() - t0;
const rpoSeconds = Math.round(timings.backupMs / 1000);
const rtoSeconds = Math.round(totalMs / 1000);
console.log("");
console.log("[drill] phase 5: REPORT");
console.log(`  backup (logical dump) : ${timings.backupMs} ms`);
console.log(`  restore (schema+data) : ${timings.restoreMs} ms`);
console.log(`  verify                : ${timings.verifyMs} ms`);
console.log(`  RPO (dump window)     : ~${rpoSeconds}s of exposure for a consistent logical snapshot`);
console.log(`  RTO (drill wall time) : ${rtoSeconds}s`);

writeFileSync(
  join(WORK_DIR, "drill-report.json"),
  JSON.stringify({ runId: RUN_ID, gitSha, timings, rpoSeconds, rtoSeconds, results, totalMs }, null, 2),
);
console.log(`[drill] artifacts: ${WORK_DIR}{/manifest.json,/drill-report.json,dump-*.ndjson}`);

console.log("");
console.log("[drill] dispositions (documented, not executed here):");
console.log("  - APP LOSS: stateless — redeploy the image and point it at the restored DB (sandbox proof: dev server restart, 2026-09-16).");
console.log("  - INTERRUPTED CHANGE: a RUNNING JobExecution restored from backup is stale; re-drive via Jobs → retry, or mark FAILED (worker claim loop ignores jobs older than their lease).");
console.log("  - KEK LOSS: CATASTROPHIC for at-rest config snapshots and webhook secrets — ciphertext is unrecoverable by design. KEK ROTATION (key still held): bun scripts/migrate-encrypt-snapshots.ts re-wraps every envelope under the new master key.");

/* ── 6. CLEANUP ─────────────────────────────────────────────────────────── */

console.log("[drill] phase 6: CLEANUP");
await scratch.$disconnect();
if (KEEP) {
  console.log(`[drill] --keep: scratch database ${SCRATCH_DB} LEFT IN PLACE for inspection`);
} else {
  if (!/^fayanms_drill_[A-Za-z0-9_]+$/.test(SCRATCH_DB)) {
    throw new Error(`[drill] scratch name guard refused DROP for "${SCRATCH_DB}"`);
  }
  await source.$executeRawUnsafe(`DROP DATABASE "${SCRATCH_DB}" WITH (FORCE)`);
  console.log(`[drill] scratch database ${SCRATCH_DB} dropped`);
}
await source.$disconnect();

const failed = results.filter((r) => !r.ok).length;
console.log(`[drill] ${failed === 0 ? "DRILL PASSED" : `DRILL FAILED (${failed} check(s) failed)`} — ${results.length} checks`);
process.exit(failed === 0 ? 0 : 1);
