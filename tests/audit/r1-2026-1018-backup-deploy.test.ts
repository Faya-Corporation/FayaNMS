import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// FNM-2026-101/102/103/109 (2026-10-18 independent re-audit) — Wave R1 pins.
//
// The audit proved (source-level) that the backup/deployment plane could
// report false success: a POSIX `pg_dump | age` pipeline returns only age's
// status; the env template omitted the MANDATORY FAYANMS_BACKUP_IMAGE; the
// standard deploy sequence never started the backup/WAL services it ships;
// and backup.sh could strand a plaintext dump when age failed. These pins
// lock the corrected invariants so none of them can silently regress.

const ROOT = path.resolve(import.meta.dir, "../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

describe("FNM-2026-101 — backup sidecar collects BOTH pipeline statuses (no false success)", () => {
  const sh = read("deploy/oci/backup-sidecar/entrypoint.sh");

  test("no bare `if pg_dump ... | age` success test remains", () => {
    // The audited false-success shape: an `if` whose condition is the whole
    // pipeline (final-command status only).
    expect(sh).not.toMatch(/if\s+pg_dump[^\n]*\|\s*age/);
  });

  test("pg_dump runs in a subshell that records its own exit status", () => {
    expect(sh).toContain("( set +e; pg_dump");
    expect(sh).toContain('echo $? > "$BACKUP_DIR/.pgstatus-$stamp"');
  });

  test("age status is captured separately from the pipeline", () => {
    expect(sh).toMatch(/age --recipient[^\n]*--output "\$partial"\n\s*age_status=\$\?/);
  });

  test("BOTH statuses AND the artifact size gate the success branch", () => {
    expect(sh).toContain(
      '[ "$pg_status" -eq 0 ] && [ "$age_status" -eq 0 ] && [ "$artifact_bytes" -ge "$MIN_ARTIFACT_BYTES" ]'
    );
    expect(sh).toMatch(/MIN_ARTIFACT_BYTES=\d+/);
  });

  test("artifacts are promoted atomically via a .partial- file + mv", () => {
    expect(sh).toContain('.partial-fayanms-$stamp.sql.age');
    expect(sh).toMatch(/mv -f "\$partial" "\$final"/);
  });

  test("failure path removes the partial artifact and records the failure", () => {
    expect(sh).toMatch(/else\n\s*rm -f "\$partial"/);
    expect(sh).toContain("record_failure");
  });

  test("a machine-readable health state file is maintained for alerting", () => {
    expect(sh).toContain("backup-health.state");
    expect(sh).toContain("consecutive_failures=");
    expect(sh).toContain("last_result=");
  });

  test("the checksum sidecar is written only for the PROMOTED file", () => {
    expect(sh).toMatch(/sha256sum "\$final" > "\$final\.sha256"/);
  });

  test("documented honesty note: in-container content validation is status+size; pg_restore --list belongs to the restore drill", () => {
    expect(sh).toContain("restore drill");
    expect(sh).toContain("pg_restore --list");
  });
});

describe("FNM-2026-109 — host backup.sh cannot strand plaintext on failure", () => {
  const sh = read("deploy/oci/backup.sh");

  test("an EXIT trap removes the plaintext dump on every exit path", () => {
    expect(sh).toMatch(/cleanup_plain\(\)\s*\{\s*rm -f "\$plain";\s*\}/);
    expect(sh).toContain("trap cleanup_plain EXIT");
  });

  test("success path unsets the trap after removing the plaintext file", () => {
    expect(sh).toContain("rm -f \"$plain\"");
    expect(sh).toContain("trap - EXIT");
  });

  test("an empty encrypted artifact is treated as a failure", () => {
    expect(sh).toMatch(/\[\[ -s "\$encrypted" \]\] \|\|/);
  });
});

describe("FNM-2026-102 — env template and deploy preflight require the backup image", () => {
  test("env.example ships FAYANMS_BACKUP_IMAGE (and the age recipient)", () => {
    const env = read("deploy/oci/env.example");
    expect(env).toMatch(/^FAYANMS_BACKUP_IMAGE=ghcr\.io\/faya-corporation\/fayanms-backup:/m);
    expect(env).toMatch(/^FAYANMS_BACKUP_AGE_RECIPIENT=/m);
  });

  test("compose.yml keeps the mandatory interpolation (regression guard)", () => {
    const compose = read("deploy/oci/compose.yml");
    expect(compose).toMatch(/\$\{FAYANMS_BACKUP_IMAGE:\?/);
  });

  test("deploy.sh requires FAYANMS_BACKUP_IMAGE + recipient BEFORE compose config", () => {
    const deploy = read("deploy/oci/deploy.sh");
    const requirePos = deploy.indexOf('FAYANMS_BACKUP_IMAGE:?FAYANMS_BACKUP_IMAGE is required');
    const configPos = deploy.indexOf('compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config -q');
    expect(requirePos).toBeGreaterThan(-1);
    expect(configPos).toBeGreaterThan(requirePos);
    expect(deploy).toContain(
      'FAYANMS_BACKUP_AGE_RECIPIENT:?FAYANMS_BACKUP_AGE_RECIPIENT is required'
    );
  });

  test("deploy.sh enforces the sha-<VERSION> tag shape on the backup image too", () => {
    const deploy = read("deploy/oci/deploy.sh");
    expect(deploy).toMatch(
      /for image in "\$FAYANMS_IMAGE" "\$FAYANMS_WORKER_IMAGE" "\$FAYANMS_MIGRATOR_IMAGE" "\$FAYANMS_BACKUP_IMAGE"; do/
    );
  });

  test("the certification workflow builds+scans+publishes the backup image", () => {
    const wf = read(".github/workflows/container.yml");
    expect(wf).toContain("deploy/oci/backup-sidecar/**"); // PR paths trigger
    expect(wf).toContain("fayanms-backup:arm64-${CANDIDATE_SHA}");
    expect(wf).toContain("fayanms-backup:gate");
    expect(wf).toContain("images: ghcr.io/faya-corporation/fayanms-backup");
    expect(wf).toContain("Scan ARM64 backup image");
    expect(wf).toContain("Scan built backup image (HIGH/CRITICAL fatal)");
    expect(wf).toContain("Build and push immutable backup image");
  });
});

describe("FNM-2026-103 — the automated deploy path starts and verifies its recovery services", () => {
  const deploy = read("deploy/oci/deploy.sh");

  test("wal-init and backup-init one-shots run BEFORE any service start", () => {
    const initPos = deploy.indexOf("--profile provision run --rm wal-init");
    const backupInitPos = deploy.indexOf("--profile provision run --rm backup-init");
    const upPos = deploy.indexOf("up -d postgres backup worker app caddy");
    expect(initPos).toBeGreaterThan(-1);
    expect(backupInitPos).toBeGreaterThan(initPos);
    expect(upPos).toBeGreaterThan(backupInitPos);
  });

  test("the production `up` includes the backup service", () => {
    expect(deploy).toContain("up -d postgres backup worker app caddy");
  });

  test("the deploy gate fails when WAL archiving fails or the sidecar is down", () => {
    expect(deploy).toContain("pg_stat_archiver");
    expect(deploy).toContain("failed_count");
    expect(deploy).toContain("backup sidecar is not running");
    expect(deploy).toMatch(/ps --status running backup/);
  });

  test("the health gate includes the backup service and archiver check", () => {
    const health = read("deploy/oci/health-check.sh");
    expect(health).toMatch(/ps --status running backup/);
    expect(health).toContain("pg_stat_archiver");
  });
});
