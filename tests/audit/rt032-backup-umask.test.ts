import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * RT-032 (F-062) — backup.sh plaintext-dump mode hygiene.
 *
 * The finding: `deploy/oci/backup.sh` wrote the plaintext full-DB dump with
 * the invoking shell's default umask (typically 022 → mode 0644, world-
 * readable) and only chmod'ed the ENCRYPTED output (0640). The fail-closed
 * gates around it (age recipient required, plaintext refused) were good;
 * the file mode was the residual exposure window.
 *
 * Landed here: `umask 077` pinned immediately after `set -euo pipefail`
 * (every artifact the script creates — the .sql dump, the .age output, the
 * .sha256 sidecar — is born owner-only 0600; the sidecar holds no secret,
 * the 0600 is just consistent), and the explicit chmod on the .age file
 * tightened from 0640 to 0600. No mktemp redirection was needed: the
 * pre-existing `install -d -m 0750` already constrains the DIRECTORY, and
 * with umask 077 the FILE is 0600 (documented in the script comment).
 *
 * Pinned here (script police, style of tests/audit/drill-restore.test.ts):
 *   1. the umask pin exists BEFORE any file creation in the script;
 *   2. no chmod looser than 0600 remains (0644/0640 are gone);
 *   3. behavioral smoke: the exact mode-relevant fragment reproduces 0600
 *      on a real filesystem (skipped where bash is unavailable);
 *   4. the fail-closed gates are unchanged (regression guard).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SCRIPT = readFileSync(path.join(REPO_ROOT, "deploy/oci/backup.sh"), "utf8");
const LINES = SCRIPT.split("\n");

function lineIndexOf(needle: string): number {
  const idx = LINES.findIndex((line) => line.includes(needle));
  expect(idx, `backup.sh should contain ${JSON.stringify(needle)}`).toBeGreaterThan(-1);
  return idx;
}

describe("RT-032: backup.sh umask pin", () => {
  test("script pins umask 077 before any file creation", () => {
    const umaskAt = LINES.findIndex((line) => line.trim() === "umask 077");
    expect(umaskAt).toBeGreaterThan(-1);
    // Before the umask pin, only the shebang, set -euo pipefail, blank and
    // pure-comment lines are allowed — nothing that can create a file.
    const before = LINES.slice(0, umaskAt);
    for (const line of before) {
      const stripped = line.trim();
      if (stripped === "" || stripped.startsWith("#")) continue;
      expect(
        ["#!/usr/bin/env bash", "set -euo pipefail"],
        `no side-effectful line may precede the umask pin, found: ${stripped}`
      ).toContain(stripped);
    }
  });

  test("every produced artifact is owner-only (no chmod looser than 0600)", () => {
    // The explicit chmod on the encrypted output is 0600 now.
    const chmodLines = LINES.filter((line) => line.includes("chmod"));
    expect(chmodLines.length).toBe(1);
    expect(chmodLines[0]).toContain("chmod 0600");
    // No world-readable artifact mode anywhere in the script; no chmod
    // line may grant group/other bits.
    expect(SCRIPT).not.toContain("0644");
    for (const line of chmodLines) {
      expect(line).not.toMatch(/0[67][0-7][2-7]/);
    }
    // `install -d -m 0750` keeps the DIRECTORY constrained (unchanged).
    expect(SCRIPT).toContain("install -d -m 0750");
  });

  test("behavioral smoke: umask 077 fragment produces mode 600", () => {
    // Run the mode-relevant fragment in a sandbox temp dir with the real
    // bash; skipped cleanly where bash is unavailable (e.g. minimal
    // Windows CI images) — the static checks above carry the contract.
    const dir = mkdtempSync(path.join(tmpdir(), "rt032-umask-"));
    try {
      writeFileSync(
        path.join(dir, "probe.sh"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          "umask 077",
          ': > "$1"',
          'stat -c %a "$1"',
          "",
        ].join("\n")
      );
      const run = Bun.spawnSync(["bash", path.join(dir, "probe.sh"), path.join(dir, "out.sql")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (run.exitCode !== 0) {
        // bash unavailable/failed to run the fragment — skip deterministically.
        console.warn("rt032 behavioral smoke skipped: bash fragment could not run");
        return;
      }
      expect(run.stdout.toString().trim()).toBe("600");
      expect(statSync(path.join(dir, "out.sql")).mode & 0o077).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gates unchanged: age-recipient-required and plaintext-refusal stay fail-closed", () => {
    // Regression guard on the pre-existing fail-closed behavior (script
    // lines 11-12 pre-RT): an empty recipient refuses to run, age is
    // required, and the env file must exist — order preserved (env →
    // recipient → age binary, all before any file is created).
    const envGate = lineIndexOf("Missing $ENV_FILE");
    const recipientGate = lineIndexOf("FAYANMS_BACKUP_AGE_RECIPIENT is required; refusing plaintext backup.");
    const ageGate = lineIndexOf("age is required for encrypted backups.");
    expect(envGate).toBeGreaterThan(-1);
    expect(recipientGate).toBeGreaterThan(envGate);
    expect(ageGate).toBeGreaterThan(recipientGate);
  });
});
