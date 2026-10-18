import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

// FNM-2026-107/108 (2026-10-18 independent re-audit) — Wave R3 pins.
//
// FNM-2026-107: PITR needs a PHYSICAL base backup chain — the shipped
// backup sidecar now produces encrypted pg_basebackup tars on their own
// cadence alongside the logical dumps, under the same dual-status +
// atomic-promotion + health-state contract.
//
// FNM-2026-108: release promotion validates sha-<commit> TAGS (mutable),
// not digests. deploy.sh now verifies the build-time revision label of
// every certified image and records the resolved registry digests; the
// staging workflow verifies certification provenance for manual SHAs.

const ROOT = path.resolve(import.meta.dir, "../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

describe("FNM-2026-107 — the shipped sidecar produces the physical base-backup chain", () => {
  const sh = read("deploy/oci/backup-sidecar/entrypoint.sh");

  test("pg_basebackup runs with tar output and fetch WAL (stdout constraint honored)", () => {
    expect(sh).toMatch(
      /pg_basebackup --format=tar --wal-method=fetch --checkpoint=fast/
    );
    expect(sh).toContain("--no-password -h postgres -U fayanms -D -");
    // The reason is documented in-file (stream-in-tar-to-stdout is refused).
    expect(sh).toContain("refuses `stream` in tar mode to stdout");
  });

  test("the physical pipeline collects BOTH statuses like the logical one", () => {
    expect(sh).toContain("( set +e; pg_basebackup");
    expect(sh).toContain('echo $? > "$BACKUP_DIR/.pgstatus-base-$pstamp"');
    expect(sh).toMatch(
      /age --recipient "\$FAYANMS_BACKUP_AGE_RECIPIENT" --output "\$ppartial"\n\s*age_status=\$\?/
    );
  });

  test("success requires both statuses AND a non-trivial base size", () => {
    expect(sh).toContain(
      '[ "$base_status" -eq 0 ] && [ "$age_status" -eq 0 ] && [ "$base_bytes" -ge "$MIN_BASE_BYTES" ]'
    );
    expect(sh).toMatch(/MIN_BASE_BYTES=\d+/);
  });

  test("physical artifacts are promoted atomically and never left partial", () => {
    expect(sh).toContain('.partial-fayanms-base-$pstamp.tar.age');
    expect(sh).toMatch(/mv -f "\$ppartial" "\$pfinal"/);
    expect(sh).toMatch(/else\n\s*rm -f "\$ppartial"/);
  });

  test("the health state file carries an independent physical plane for alerting", () => {
    expect(sh).toContain("physical_last_result=");
    expect(sh).toContain("physical_consecutive_failures=");
    expect(sh).toContain("physical_last_exit_detail=");
  });

  test("the physical cadence has a floor and an explicit disable", () => {
    expect(sh).toMatch(/FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS:-86400/);
    expect(sh).toContain('[ "$PHYSICAL_INTERVAL" -eq 0 ] || [ "$PHYSICAL_INTERVAL" -ge 3600 ]');
    expect(sh).toContain("next_physical_at=");
  });

  test("physical retention is separate from logical retention", () => {
    expect(sh).toContain("fayanms-base-*.tar.age");
    expect(sh).toContain("fayanms-base-*.tar.age.sha256");
    expect(sh).toMatch(/FAYANMS_BACKUP_BASE_RETENTION_DAYS:-7/);
  });

  test("compose plumbs the knob; env.example documents it", () => {
    const compose = read("deploy/oci/compose.yml");
    expect(compose).toMatch(
      /FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS: \$\{FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS:-86400\}/
    );
    const env = read("deploy/oci/env.example");
    expect(env).toMatch(/FAYANMS_BACKUP_PHYSICAL_INTERVAL_SECONDS=86400/);
  });

  test("the DR runbook documents the shipped physical chain + restore-to-timestamp", () => {
    const runbook = read("docs/runbooks/disaster-recovery.md");
    expect(runbook).toContain("fayanms-base-<timestamp>.tar.age");
    expect(runbook).toContain("FNM-2026-107");
    expect(runbook).toContain("recovery_target_time");
    expect(runbook).toContain("recovery.signal");
    expect(runbook).toContain("restore-drill.sh");
  });
});

describe("FNM-2026-108 — promotion integrity: provenance + resolved digests", () => {
  test("deploy.sh refuses an image whose build-time revision ≠ the deployed commit", () => {
    const deploy = read("deploy/oci/deploy.sh");
    expect(deploy).toContain('org.opencontainers.image.revision');
    expect(deploy).toContain("Provenance mismatch");
    // The check covers ALL FOUR certified images.
    expect(deploy).toMatch(
      /for ref in "\$FAYANMS_IMAGE" "\$FAYANMS_WORKER_IMAGE" "\$FAYANMS_MIGRATOR_IMAGE" "\$FAYANMS_BACKUP_IMAGE"; do/
    );
  });

  test("deploy.sh records the resolved registry digests as the deploy inventory", () => {
    const deploy = read("deploy/oci/deploy.sh");
    expect(deploy).toContain("digest-manifest.env");
    expect(deploy).toContain("RepoDigests 0");
  });

  test("manual staging promotions verify certification provenance first", () => {
    const wf = read(".github/workflows/deploy-staging.yml");
    expect(wf).toContain("Verify certification provenance for manual promotions");
    expect(wf).toContain('if: github.event_name == \'workflow_dispatch\'');
    expect(wf).toContain("Container certification and publication");
    expect(wf).toContain("refusing manual promotion (FNM-2026-108)");
    // Reading run history needs actions:read on top of contents:read.
    expect(wf).toMatch(/actions: read/);
  });

  test("the certification workflow stamps the revision label on the backup image too", () => {
    const cert = read(".github/workflows/container.yml");
    const backupMeta = cert.slice(cert.indexOf("id: backup-meta"));
    expect(backupMeta).toContain("org.opencontainers.image.revision=${{ github.event.workflow_run.head_sha }}");
  });
});
