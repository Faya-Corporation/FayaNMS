import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// GA-OPS (Task 10, final wave) — cross-platform fresh-install operations.
// Pins the ops/ entry surface so Linux (bash) and Windows (PowerShell/bat)
// stay in lockstep forever: command parity, line-ending discipline, the
// byte-strict postgres digest, and the no-secrets rule.

const ROOT = path.resolve(import.meta.dir, "../..");
const OPS = path.join(ROOT, "ops");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function commandListFromSh(sh: string): string[] {
  const m = sh.replace(/\r\n/g, "\n").match(/readonly OPS_COMMANDS=\(\n([\s\S]*?)\n\)/);
  expect(m, "ops.sh must declare readonly OPS_COMMANDS=( ... )").toBeTruthy();
  return (m as RegExpMatchArray)[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function commandListFromPs1(ps1: string): string[] {
  // Normalize line endings first: *.ps1 is checked out with CRLF everywhere
  // (that is the whole point of the .gitattributes eol discipline), so the
  // parser must not assume a bare-LF working tree (Windows checkouts would
  // otherwise fail this parity pin by construction).
  const m = ps1
    .replace(/\r\n/g, "\n")
    .match(/\$Script:OpsCommands\s*=\s*@\(\n([\s\S]*?)\n\)/);
  expect(m, "ops.ps1 must declare $Script:OpsCommands = @( ... )").toBeTruthy();
  return (m as RegExpMatchArray)[1]
    .split("\n")
    .map((l) => l.trim().replace(/['"],?$/g, "").replace(/^['"]/, "").replace(/[',"]+$/g, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

describe("GA-OPS: cross-platform fresh-install operator surface", () => {
  const shPath = path.join(OPS, "ops.sh");
  const ps1Path = path.join(OPS, "ops.ps1");
  const batPath = path.join(OPS, "ops.bat");

  test("ops entry files exist (ops.sh + ops.ps1 + ops.bat + dev compose + README)", () => {
    for (const f of [
      "ops/ops.sh",
      "ops/ops.ps1",
      "ops/ops.bat",
      "ops/docker-compose.dev.yml",
      "ops/README.md",
    ]) {
      expect(existsSync(path.join(ROOT, f)), `${f} must exist`).toBe(true);
    }
  });

  test("ops.sh is executable, bash, and fail-closed", () => {
    const mode = statSync(shPath).mode;
    expect(mode & 0o111, "ops.sh must carry the executable bit").toBeTruthy();
    const sh = read("ops/ops.sh");
    expect(sh.startsWith("#!/usr/bin/env bash")).toBe(true);
    expect(sh).toContain("set -euo pipefail");
  });

  test("command surface parity: ops.sh and ops.ps1 declare the SAME command list", () => {
    const shCmds = commandListFromSh(read("ops/ops.sh"));
    const psCmds = commandListFromPs1(read("ops/ops.ps1"));
    expect(shCmds.length, "surface must not be empty").toBeGreaterThan(10);
    expect(psCmds).toEqual(shCmds);
    // every declared command is actually dispatched in BOTH scripts
    for (const cmd of shCmds) {
      expect(read("ops/ops.sh")).toContain(`${cmd})`);
      expect(read("ops/ops.ps1")).toContain(`'${cmd}'`);
    }
  });

  test("help covers every command in both implementations", () => {
    const sh = read("ops/ops.sh");
    const ps1 = read("ops/ops.ps1");
    for (const cmd of commandListFromSh(sh)) {
      expect(ps1).toContain(cmd);
    }
    // the bash help text is generated from the array — smoke it for real
    const out = execSync("bash ops/ops.sh help", { cwd: ROOT, encoding: "utf8" });
    for (const cmd of commandListFromSh(sh)) {
      expect(out).toContain(cmd);
    }
  });

  test("ops.bat is CRLF-only, dispatcher-style, and references ops.ps1", () => {
    const bat = read("ops/ops.bat");
    expect(bat.startsWith("@echo off")).toBe(true);
    expect(bat, "ops.bat must reference ops.ps1").toContain("ops.ps1");
    expect(bat, "ops.bat must use CRLF line endings").toMatch(/\r\n/);
    expect(bat, "ops.bat must not contain a bare LF").not.toMatch(/(^|[^\r])\n/);
  });

  test("gitattributes enforces eol discipline for the ops surface", () => {
    const ga = read(".gitattributes");
    expect(ga).toMatch(/\*\.bat[^\n]*eol=crlf/);
    expect(ga).toMatch(/\*\.cmd[^\n]*eol=crlf/);
    expect(ga).toMatch(/\*\.sh[^\n]*eol=lf/);
  });

  test("dev compose pins the SAME byte-strict postgres digest as CI and oci compose", () => {
    const digestRe = /postgres:16-alpine@sha256:[0-9a-f]{64}/g;
    const dev = (read("ops/docker-compose.dev.yml").match(digestRe) ?? [])[0];
    const oci = (read("deploy/oci/compose.yml").match(digestRe) ?? [])[0];
    const ci = (read(".github/workflows/ci.yml").match(digestRe) ?? [])[0];
    expect(dev, "dev compose must pin postgres:16-alpine by digest").toBeTruthy();
    expect(dev).toBe(oci);
    expect(dev).toBe(ci);
    expect(read("ops/docker-compose.dev.yml")).toContain("5433:5432");
    expect(read("ops/docker-compose.dev.yml")).toContain("pg_isready");
  });

  test("bash -n accepts ops.sh; help + an unknown command behave correctly", () => {
    execSync("bash -n ops/ops.sh", { cwd: ROOT });
    const out = execSync("bash ops/ops.sh help", { cwd: ROOT, encoding: "utf8" });
    expect(out).toContain("install");
    expect(out).toContain("docker:up");
    let threw = false;
    try {
      execSync("bash ops/ops.sh definitely-not-a-command", { cwd: ROOT, stdio: "pipe" });
    } catch {
      threw = true;
    }
    expect(threw, "unknown command must fail closed").toBe(true);
  });

  test("PowerShell surface parses (skipped where pwsh is unavailable)", () => {
    let pwsh: string | null = null;
    for (const candidate of ["pwsh", "powershell"]) {
      try {
        execSync(`command -v ${candidate}`, { stdio: "pipe" });
        pwsh = candidate;
        break;
      } catch {
        /* not present */
      }
    }
    if (!pwsh) {
      console.log("    (pwsh not on PATH — parse pin skipped; parity pins above still apply)");
      return;
    }
    execSync(
      `${pwsh} -NoProfile -Command "$t=$null;$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('ops/ops.ps1',[ref]$t,[ref]$e)|Out-Null;if($e.Count){$e|ForEach-Object{Write-Host $_.Message};exit 1}"`,
      { cwd: ROOT, stdio: "pipe" },
    );
  });

  test("ops scripts carry no secrets and no absolute host paths", () => {
    for (const f of ["ops/ops.sh", "ops/ops.ps1", "ops/ops.bat"]) {
      const content = read(f);
      expect(content, `${f} must not embed the CI NEXTAUTH_SECRET`).not.toContain("6b1f0f4c");
      expect(content, `${f} must not embed absolute sandbox paths`).not.toMatch(/\/home\/|\/root\/|C:\\Users\\/);
    }
  });

  test("README documents the fresh-install matrix for Linux, Windows and Docker", () => {
    const r = read("README.md");
    expect(r).toContain("Fresh installation");
    expect(r).toContain("ops/ops.sh");
    expect(r).toContain("ops\\ops.bat");
    expect(r).toContain("docker");
  });

  test("dev identity bootstrap: generated material is valid, quoted, idempotent, and gitignored", () => {
    // gitignore pins the local identity dir
    expect(read(".gitignore")).toContain(".fayanms/");
    // both entries reference the bootstrap
    expect(read("ops/ops.sh")).toContain("bootstrap-dev-identity");
    expect(read("ops/ops.ps1")).toContain("bootstrap-dev-identity");
    // generate into a temp file (never the repo working tree) and inspect
    const tmp = path.join(ROOT, ".fayanms-test-tmp.env");
    try {
      execSync(`bun ops/bootstrap-dev-identity.ts --out "${tmp}"`, { cwd: ROOT, stdio: "pipe" });
      const content = readFileSync(tmp, "utf8");
      const keys = [
        "DEV_NEXTAUTH_SECRET",
        "DEV_CONFIG_ENC_KEY",
        "DEV_CONTROL_PRIVATE_KEY",
        "DEV_CONTROL_PUBLIC_KEY",
        "DEV_WORKER_PRIVATE_KEY",
        "DEV_WORKER_PUBLIC_KEY",
      ];
      const values: Record<string, string> = {};
      for (const line of content.split("\n")) {
        if (line.startsWith("#") || !line.includes("=")) continue;
        const k = line.split("=", 1)[0];
        const v = line.slice(line.indexOf("=") + 1);
        expect(keys, `unexpected key ${k}`).toContain(k);
        expect(v.startsWith('"') && v.endsWith('"'), `${k} must be double-quoted`).toBe(true);
        values[k] = v.slice(1, -1);
      }
      for (const k of keys) {
        expect(values[k], `${k} must be non-empty`).toBeTruthy();
      }
      // PEM material: escaped-newline single-line PKCS8, Ed25519 header
      expect(values.DEV_CONTROL_PRIVATE_KEY).toContain("-----BEGIN PRIVATE KEY-----");
      expect(values.DEV_CONTROL_PRIVATE_KEY).not.toContain("\n");
      expect(values.DEV_WORKER_PRIVATE_KEY).toContain("-----BEGIN PRIVATE KEY-----");
      // the two planes use DISTINCT keypairs
      expect(values.DEV_CONTROL_PUBLIC_KEY).not.toBe(values.DEV_WORKER_PUBLIC_KEY);
      expect(values.DEV_CONTROL_PUBLIC_KEY).not.toBe(values.DEV_CONTROL_PRIVATE_KEY);
      // secrets are random per install (64-hex)
      expect(values.DEV_NEXTAUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
      expect(values.DEV_CONFIG_ENC_KEY).toMatch(/^[0-9a-f]{64}$/);
      // idempotent: a second run leaves the file untouched
      const before = readFileSync(tmp, "utf8");
      execSync(`bun ops/bootstrap-dev-identity.ts --out "${tmp}"`, { cwd: ROOT, stdio: "pipe" });
      expect(readFileSync(tmp, "utf8")).toBe(before);
    } finally {
      try {
        execSync(`rm -f "${tmp}"`);
      } catch {
        /* cleanup best-effort */
      }
    }
  });

  test("worker self-call trust posture is documented in the ops dev path", () => {
    // STATE.md ground truth: the worker's FAYANMS_SERVICE_PUBLIC_KEYS must
    // include BOTH the control public key AND its own (self-call plane).
    const sh = read("ops/ops.sh");
    expect(sh).toContain('$DEV_CONTROL_PUBLIC_KEY,$DEV_WORKER_PUBLIC_KEY');
    const ps1 = read("ops/ops.ps1");
    expect(ps1).toContain('$Script:DEV_CONTROL_PUBLIC_KEY),$($Script:DEV_WORKER_PUBLIC_KEY)');
  });
});
