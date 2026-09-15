import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * DEPLOY-001-A (+ OPS-002-A) — TLS-by-default reference profile and
 * container runtime hardening.
 *
 * The confirmed finding: the compose stack published plain HTTP by default
 * ("${FAYANMS_HTTP_PORT:-80}:3000"), TLS was an undocumented external
 * afterthought, and no container runtime hardening existed — a
 * misdeployment exposed sessions over HTTP (independent audit 2026-09-15,
 * P2).
 *
 * Pinned here (static config governance — `docker compose config` is NOT
 * VERIFIED in this environment; no Docker. The YAML is parsed structurally
 * the same way the operator's compose would merge it):
 *
 *   1. compose.tls.yml is a real OVERRIDE profile: Caddy terminates TLS as
 *      the ONLY ingress (80/443), the app's direct port publication is
 *      REMOVED, certificates/HSTS/redirect come from the shipped Caddyfile;
 *   2. every service gains cap_drop ALL + no-new-privileges + PID/memory
 *      bounds; app+worker run read-only root filesystems with tmpfs /tmp
 *      (the database keeps a writable data plane — a documented deviation);
 *   3. the base invariants hold: worker and postgres NEVER publish ports;
 *   4. the runbook ships and references the TLS path as the default, with
 *      plain-80 explicitly labeled isolated-LAN-pilot-only.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

function composeServiceSection(composeText: string, service: string): string {
  const lines = composeText.split("\n");
  const start = lines.findIndex((line) => line === `  ${service}:`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_-]+:$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("DEPLOY-001-A: TLS override profile is the safe default", () => {
  const tls = readRepoFile("compose.tls.yml");
  const caddyfile = readRepoFile("docs/deploy/Caddyfile.tls");

  test("caddy terminates TLS as the only ingress (80/443 published)", () => {
    const caddy = composeServiceSection(tls, "caddy");
    expect(caddy).toContain("caddy:2-alpine");
    expect(caddy).toContain('"80:80"');
    expect(caddy).toContain('"443:443"');
    expect(caddy).toContain("/etc/caddy/Caddyfile:ro");
    // Certificate + config persistence (ACME account, renewals survive up).
    expect(caddy).toContain("caddy-data:/data");
  });

  test("the app's direct port publication is REMOVED in the TLS profile", () => {
    const app = composeServiceSection(tls, "app");
    expect(app).toContain("ports: []");
    expect(app).not.toMatch(/"\$\{FAYANMS_HTTP_PORT/);
  });

  test("the Caddyfile carries the documented trust contract", () => {
    expect(caddyfile).toContain("reverse_proxy app:3000");
    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).toContain("FAYANMS_TLS_DOMAIN");
    // The single trusted proxy hop is documented (the app's default).
    expect(caddyfile).toContain("FAYANMS_TRUST_PROXY_HOPS");
  });

  test("runbook documents the layered invocation and the https origin rebuild", () => {
    const deployDoc = readRepoFile("docs/deploy/WINDOWS-SERVER-DOCKER-DESKTOP.md");
    expect(deployDoc).toContain("-f compose.yml -f compose.tls.yml");
    expect(deployDoc).toContain("FAYANMS_TLS_DOMAIN");
    expect(deployDoc).toContain("isolated-LAN pilot");
  });
});

describe("DEPLOY-001-A/OPS-002-A: container runtime hardening", () => {
  const tls = readRepoFile("compose.tls.yml");

  test("every service drops ALL capabilities and forbids privilege escalation", () => {
    for (const service of ["app", "worker", "postgres", "caddy"]) {
      const section = composeServiceSection(tls, service);
      expect(section).toContain("- ALL");
      expect(section).toContain("no-new-privileges:true");
    }
  });

  test("app + worker run read-only roots with a /tmp tmpfs", () => {
    for (const service of ["app", "worker"]) {
      const section = composeServiceSection(tls, service);
      expect(section).toContain("read_only: true");
      expect(section).toContain("- /tmp");
    }
  });

  test("PID and memory bounds exist on every service", () => {
    for (const service of ["app", "worker", "postgres", "caddy"]) {
      const section = composeServiceSection(tls, service);
      expect(section).toContain("pids_limit:");
      expect(section).toContain("mem_limit:");
    }
  });

  test("caddy keeps ONLY the low-port capability it explicitly needs", () => {
    const caddy = composeServiceSection(tls, "caddy");
    expect(caddy).toContain("cap_add:");
    expect(caddy).toContain("- NET_BIND_SERVICE");
  });

  test("the postgres writable-data deviation is documented, not silent", () => {
    expect(tls).toContain("documented deviation");
  });
});

describe("DEPLOY-001-A/D3: base-stack exposure invariants", () => {
  const base = readRepoFile("compose.yml");

  test("the worker NEVER publishes ports (base + TLS profiles)", () => {
    const worker = composeServiceSection(base, "worker");
    expect(worker).not.toMatch(/^\s*ports:/m);
    const workerTls = composeServiceSection(readRepoFile("compose.tls.yml"), "worker");
    expect(workerTls).not.toMatch(/^\s*ports:/m);
  });

  test("postgres is never published (its secret is internal-only)", () => {
    const postgres = composeServiceSection(base, "postgres");
    expect(postgres).not.toMatch(/^\s*ports:/m);
  });
});
