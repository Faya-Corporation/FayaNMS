import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * RT-033 (F-063) — restore-drill.sh keeps the database URL off the command
 * line.
 *
 * The finding: `pg_restore --dbname "$TARGET_DATABASE_URL"` and
 * `psql "$TARGET_DATABASE_URL"` put the connection string (with embedded
 * credentials) into argv, where host `ps`/audit logs capture it for the
 * duration of the drill. The script was otherwise fail-closed (approval
 * flag, isolated target, cleanup trap).
 *
 * Landed here: the canonical URL (deploy/oci/env.example:14 shape) is
 * parsed into libpq environment variables (PGHOST/PGPORT/PGUSER/PGPASSWORD/
 * PGDATABASE) by deploy/oci/pg-url.sh (sourced by the drill script), and
 * both pg_restore and psql receive `--dbname="$PGDATABASE"` — the bare DB
 * name. The parser is fail-loud on anything but the canonical shape: it
 * exits nonzero BEFORE any restore step (never half-parse credentials).
 * A .pgpass file is deliberately NOT used (env-var transport needs no
 * file cleanup); the pre-existing cleanup trap additionally unsets the
 * password export.
 *
 * Pinned here (script police + functional fragment, style of
 * tests/audit/drill-restore.test.ts):
 *   1. no URL in argv — pg_restore/psql consume env-derived parts;
 *   2. the parser handles the canonical shape (executed for real via bash);
 *   3. malformed URLs are refused nonzero before any restore;
 *   4. the existing fail-closed gates survive, ordered before any
 *      connection attempt;
 *   5. no pgpass file mechanism exists to leak (env-var approach).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const DRILL = readFileSync(path.join(REPO_ROOT, "deploy/oci/restore-drill.sh"), "utf8");
const PARSER = readFileSync(path.join(REPO_ROOT, "deploy/oci/pg-url.sh"), "utf8");
const DRILL_LINES = DRILL.split("\n");

function lineIndexOf(needle: string): number {
  const idx = DRILL_LINES.findIndex((line) => line.includes(needle));
  expect(idx, `restore-drill.sh should contain ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return idx;
}

/** bash availability probe — the behavioral fragments skip if absent. */
function bashAvailable(): boolean {
  try {
    return Bun.spawnSync(["bash", "-c", "true"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  } catch {
    return false;
  }
}

describe("RT-033: restore-drill argv hygiene", () => {
  test("no URL in argv — pg_restore/psql consume env-derived parts", () => {
    // The offending argv forms are gone.
    expect(DRILL).not.toContain('--dbname "$TARGET_DATABASE_URL"');
    expect(DRILL).not.toContain('psql "$TARGET_DATABASE_URL"');
    expect(DRILL).not.toMatch(/--dbname=?"?\$\{?TARGET_DATABASE_URL/);
    // The parser is wired in and both clients take the bare DB name.
    expect(DRILL).toContain('parse_pg_url "$TARGET_DATABASE_URL"');
    expect(DRILL).toContain('--dbname="$PGDATABASE"');
    // The libpq env exports exist (PGPASSWORD=/PGHOST= in the parser).
    expect(PARSER).toMatch(/export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD/);
    // psql has no inline URL or password — connection is env-driven.
    expect(DRILL).toMatch(/psql --dbname="\$PGDATABASE"/);
  });

  test("URL parser handles the canonical shape", () => {
    if (!bashAvailable()) {
      console.warn("rt033 parser fragment skipped: bash unavailable");
      return;
    }
    const run = Bun.spawnSync(
      [
        "bash",
        "-c",
        [
          `source ${path.join(REPO_ROOT, "deploy/oci/pg-url.sh")}`,
          'parse_pg_url "postgresql://fayanms:pw@db.host:5433/fayanms"',
          'echo "$PGHOST|$PGPORT|$PGUSER|$PGPASSWORD|$PGDATABASE"',
        ].join("; "),
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim()).toBe("db.host|5433|fayanms|pw|fayanms");
  });

  test("malformed URL refused nonzero BEFORE any restore", () => {
    // Source-level: the shape guard lives in the parser and the parse
    // call happens before mktemp/age/pg_restore in the drill script.
    expect(PARSER).toMatch(/refusing to half-parse credentials/);
    const parseAt = lineIndexOf('parse_pg_url "$TARGET_DATABASE_URL"');
    const tmpAt = lineIndexOf("mktemp");
    expect(parseAt).toBeLessThan(tmpAt);
    // Behavioral: both negative shapes exit nonzero (exit 2), including
    // the two cases the RT names — no `://` and no credentials.
    if (!bashAvailable()) {
      console.warn("rt033 malformed-URL fragment skipped: bash unavailable");
      return;
    }
    for (const bad of [
      "fayanms@db.host:5433/fayanms", // no scheme
      "postgresql://db.host:5433/fayanms", // no credentials
      "postgresql://fayanms:pw@db.host:5433/fayanms?sslmode=require", // query params
    ]) {
      const run = Bun.spawnSync(
        [
          "bash",
          "-c",
          [
            `source ${path.join(REPO_ROOT, "deploy/oci/pg-url.sh")}`,
            `parse_pg_url '${bad}'`,
          ].join("; "),
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      expect(run.exitCode === 0 ? "exit 0" : `exit ${run.exitCode ?? "?"}`).not.toBe("exit 0");
    }
  });

  test("existing gates unchanged and ordered before any connection attempt", () => {
    // The pre-RT fail-closed gates (usage/exists/url/identity/approval/bins)
    // are all still present.
    const usageGate = lineIndexOf('[[ ! "$BACKUP_FILE" =~ \\.sql\\.age$ ]]');
    const existsGate = lineIndexOf('Backup does not exist." >&2; exit 1');
    const urlGate = lineIndexOf('RESTORE_TARGET_DATABASE_URL is required." >&2; exit 1');
    const identityGate = lineIndexOf('Restore identity file is required." >&2; exit 1');
    const approvalGate = lineIndexOf("Set RESTORE_DRILL_APPROVED=1 for an isolated target only.");
    const ageGate = lineIndexOf('command -v age >/dev/null');
    const gatesEnd = Math.max(usageGate, existsGate, urlGate, identityGate, approvalGate, ageGate);
    // The approval flag is strict (== 1), the drill is opt-in.
    expect(DRILL).toContain("[[ ${RESTORE_DRILL_APPROVED:-0} == 1 ]]");
    // Gates run before the parser call (the first connection-related step).
    expect(gatesEnd).toBeLessThan(lineIndexOf('parse_pg_url "$TARGET_DATABASE_URL"'));
  });

  test("no pgpass file left behind (env-var transport only)", () => {
    // The env-var approach was chosen deliberately: no .pgpass/mktemp'ed
    // credential file exists that could survive a crash — the only mktemp
    // is the decrypted dump, removed by the existing trap.
    expect(DRILL).not.toMatch(/\bpgpass\b|\.pgpass|PGPASSFILE/i);
    expect(PARSER).not.toMatch(/\bpgpass\b|\.pgpass|PGPASSFILE|mktemp/i);
    // The cleanup trap still removes the dump tmp file AND unsets the
    // password export.
    expect(DRILL).toMatch(/cleanup\(\)\{[\s\S]*?rm -f "\$tmp"[\s\S]*?unset PGPASSWORD[\s\S]*?\}/);
  });
});
