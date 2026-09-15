/**
 * TASK-DEMO-FLEET-001 — public demo device fleet governance pins.
 *
 * The demo fleet probe (scripts/demo-fleet-probe.ts) is the zero-cost
 * real-device evidence plane for CERT-HW-001. These pins keep it honest:
 *
 *   - the catalog only ever maps devices to CERTIFIED LIVE_SSH flavors
 *     (un-certified devices are marked reference-only, never enrollable);
 *   - credential material can never enter the repository (env-only policy,
 *     literal scan, named-variable refusals);
 *   - the tool stays strictly READ-ONLY (no config/reload/erase command
 *     literals may ever appear — public demo devices are shared);
 *   - the typed pre-network refusal is functional (exit 2 before any
 *     connection when the SSH stage lacks its env);
 *   - the docs claim only the tier actually evidenced (public-demo
 *     auth/read; the T3 lab classification for the full matrix stands).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEMO_SSH_ENV,
  PUBLIC_DEMO_FLEET,
  resolveDemoSshCreds,
} from "../../scripts/demo-fleet-probe";
import { LIVE_SSH_FLAVORS } from "../../mini-services/worker/live-ssh";

function readRepoFile(relativePath: string): string {
  return readFileSync(join(import.meta.dir, "../..", relativePath), "utf8");
}

const PROBE_SCRIPT = "scripts/demo-fleet-probe.ts";

describe("demo fleet — catalog integrity", () => {
  test("the fleet is cataloged with source URLs and cisco.com public hosts", () => {
    expect(PUBLIC_DEMO_FLEET.length).toBeGreaterThanOrEqual(2);
    for (const device of PUBLIC_DEMO_FLEET) {
      expect(device.host.endsWith(".cisco.com")).toBe(true);
      expect(device.port).toBe(22);
      expect(device.credentialSourceUrl.startsWith("https://")).toBe(true);
      expect(device.notes.length).toBeGreaterThan(20);
      expect(["devnet-aaa-per-user", "none"]).toContain(device.credentialModel);
    }
  });

  test("the IOS-XE entry is enrollable via the certified cisco flavor", () => {
    const xe = PUBLIC_DEMO_FLEET.find((d) => d.id === "devnet-cat8000-iosxe");
    expect(xe).toBeDefined();
    expect(xe?.host).toBe("devnetsandboxiosxe.cisco.com");
    expect(xe?.liveSshFlavor).toBe("cisco");
    expect(xe?.credentialModel).toBe("devnet-aaa-per-user");
  });

  test("HONESTY: no catalog entry maps to a flavor outside LIVE_SSH_FLAVORS", () => {
    for (const device of PUBLIC_DEMO_FLEET) {
      if (device.liveSshFlavor !== null) {
        expect(Object.keys(LIVE_SSH_FLAVORS)).toContain(device.liveSshFlavor);
      }
    }
    // NX-OS has NO certified flavor — it must be cataloged as reference-only.
    const nxos = PUBLIC_DEMO_FLEET.find((d) => d.id === "devnet-nxos");
    expect(nxos?.liveSshFlavor).toBeNull();
  });
});

describe("demo fleet — credential policy (env-only, never in the repo)", () => {
  test("the env variable contract is pinned", () => {
    expect(DEMO_SSH_ENV.host).toBe("FAYANMS_DEMO_SSH_HOST");
    expect(DEMO_SSH_ENV.port).toBe("FAYANMS_DEMO_SSH_PORT");
    expect(DEMO_SSH_ENV.user).toBe("FAYANMS_DEMO_SSH_USER");
    expect(DEMO_SSH_ENV.pass).toBe("FAYANMS_DEMO_SSH_PASS");
  });

  test("the script contains NO credential literals (only env var NAMES may appear as strings)", () => {
    const source = readRepoFile(PROBE_SCRIPT);
    const literalPattern = /(pass(word)?|pwd|secret)\s*[:=]\s*["']([^"']*)["']/gi;
    const matches = [...source.matchAll(literalPattern)];
    expect(matches.length).toBeGreaterThan(0); // the env-name map itself must match
    for (const match of matches) {
      const literal = match[3] ?? "";
      expect(
        literal.startsWith("FAYANMS_"),
        `credential-shaped literal "${literal}" must never be committed`,
      ).toBe(true);
    }
  });

  test("READ-ONLY discipline: the only device commands are the read-only allowlist", () => {
    const source = readRepoFile(PROBE_SCRIPT);
    expect(source).toContain("show version");
    // No mutation-shaped command literals may ever enter this tool —
    // public demo devices are SHARED infrastructure.
    expect(/conf(igure)?\s+terminal|conf\s+t\b/i.test(source)).toBe(false);
    expect(/\breload\b/i.test(source)).toBe(false);
    expect(/\bwrite\s+(mem|erase|running)/i.test(source)).toBe(false);
    expect(/\bcopy\s+running/i.test(source)).toBe(false);
    expect(/\berase\b/i.test(source)).toBe(false);
    expect(/\breboot\b/i.test(source)).toBe(false);
  });
});

describe("demo fleet — typed credential resolver", () => {
  test("empty env → refusal naming ALL required variables", () => {
    const result = resolveDemoSshCreds({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("FAYANMS_DEMO_SSH_HOST");
      expect(result.missing).toContain("FAYANMS_DEMO_SSH_USER");
      expect(result.missing).toContain("FAYANMS_DEMO_SSH_PASS");
    }
  });

  test("partial env → refusal names exactly the missing variables", () => {
    const result = resolveDemoSshCreds({
      FAYANMS_DEMO_SSH_HOST: "devnetsandboxiosxe.cisco.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["FAYANMS_DEMO_SSH_USER", "FAYANMS_DEMO_SSH_PASS"]);
    }
  });

  test("complete env → credentials carried, default port 22", () => {
    const result = resolveDemoSshCreds({
      FAYANMS_DEMO_SSH_HOST: "devnetsandboxiosxe.cisco.com",
      FAYANMS_DEMO_SSH_USER: "operator",
      FAYANMS_DEMO_SSH_PASS: "not-a-real-credential",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.creds.host).toBe("devnetsandboxiosxe.cisco.com");
      expect(result.creds.username).toBe("operator");
      expect(result.creds.port).toBe(22);
    }
  });

  test("malformed port → refusal naming the PORT variable", () => {
    for (const badPort of ["abc", "0", "99999", "-1"]) {
      const result = resolveDemoSshCreds({
        FAYANMS_DEMO_SSH_HOST: "h",
        FAYANMS_DEMO_SSH_USER: "u",
        FAYANMS_DEMO_SSH_PASS: "p",
        FAYANMS_DEMO_SSH_PORT: badPort,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.missing[0]).toContain("FAYANMS_DEMO_SSH_PORT");
      }
    }
  });

  test("valid explicit port is honored", () => {
    const result = resolveDemoSshCreds({
      FAYANMS_DEMO_SSH_HOST: "h",
      FAYANMS_DEMO_SSH_USER: "u",
      FAYANMS_DEMO_SSH_PASS: "p",
      FAYANMS_DEMO_SSH_PORT: "8181",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.creds.port).toBe(8181);
  });
});

describe("demo fleet — functional pre-network refusal", () => {
  test("`--ssh` without env exits 2 BEFORE any network activity", async () => {
    const cleanEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && !key.startsWith("FAYANMS_DEMO_SSH")) cleanEnv[key] = value;
    }
    const proc = Bun.spawn(["bun", PROBE_SCRIPT, "--ssh"], {
      cwd: join(import.meta.dir, "../.."),
      env: cleanEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("DEMO_SSH_CREDS_MISSING");
    expect(stderr).toContain("FAYANMS_DEMO_SSH_HOST");
    // The refusal must happen BEFORE the preflight touches the network.
    expect(stderr).not.toContain("TCP preflight");
  }, 20_000);
});

describe("demo fleet — docs governance (claim only the evidenced tier)", () => {
  test("the public-demo procedure document exists and states its boundaries", () => {
    const doc = readRepoFile("docs/certification/PUBLIC-DEMO-DEVICES.md");
    expect(doc).toContain("READ-ONLY");
    expect(doc).toContain("devnet-aaa-per-user");
    expect(doc).toContain("2025-09-16"); // the shared-credential retirement citation
    expect(doc).toContain("PUBLIC DEMO EVIDENCE LOG");
    // The doc must never upgrade public-demo evidence into lab tiers.
    expect(/recorded\s+T3|T3\s+row\s+signed|restore\s+certified/i.test(doc)).toBe(false);
  });

  test("the certification matrix keeps the lab classification and links the demo plane", () => {
    const matrix = readRepoFile("docs/certification/MATRIX.md");
    expect(matrix).toContain("PUBLIC-DEMO-DEVICES.md");
    expect(matrix).toContain("CERT-HW-001-A");
    // The full-matrix classification stands: public-demo evidence is auth/read only.
    expect(matrix).toContain("REAL-HARDWARE BLOCKED");
  });

  test("the probe is wired as a package script", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["demo:fleet"]).toBe("bun scripts/demo-fleet-probe.ts");
  });
});
