import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

/**
 * RT-006 (F-007, SEC-ENV-001) — OCI compose least-privilege env split.
 *
 * The confirmed finding: deploy/oci/compose.yml attached the monolithic
 * host `.env` to ALL FIVE services (`env_file: .env` on postgres, migrate,
 * app, worker AND caddy), so the KEK (FAYANMS_CONFIG_ENC_KEY), the session
 * secret (NEXTAUTH_SECRET) and the DB password (POSTGRES_PASSWORD/
 * DATABASE_URL) leaked into the worker, postgres and caddy containers — a
 * caddy/pg compromise yielded the config-encryption KEK, and the worker's
 * own boot policy (warnWorkerSecretScope) refuses out-of-zone variables
 * after the documented deprecation window, which would break deploys.
 *
 * Pinned here, structurally (parsing the real files, not formatting):
 *
 *   1. deploy/oci/compose.yml maps each service to ITS zone: app → .env.app,
 *      worker → .env.worker, postgres/migrate/caddy → NO env_file (their
 *      environment is composed from the host-side --env-file interpolation);
 *   2. the worker service never sees app-zone material (no KEK/session/DB
 *      keys in its env_file or environment map) and caddy/postgres receive
 *      no secret-bearing environment at all;
 *   3. deploy/oci/env.example documents the three-file layout with the
 *      zone contract (host block: interpolation only; app block: no vault
 *      keys; worker block: no session/KEK/DB keys);
 *   4. the required-var interpolation contracts survive (services cannot
 *      silently boot with empty secrets);
 *   5. deploy.sh refuses a stale host layout BEFORE half-booting the stack;
 *   6. bootstrap.sh enforces mode 600 on all three host env files.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const OCI_SERVICES = ["postgres", "migrate", "app", "worker", "caddy"] as const;

/** Slice one top-level service block out of compose.yml (2-space keys). */
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

/** All env_file entries of a section — scalar (`env_file: x`) and list form. */
function envFileValues(section: string): string[] {
  const values: string[] = [];
  const lines = section.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const scalar = /^\s*env_file:\s*(.+?)\s*$/.exec(lines[i]);
    if (scalar) {
      values.push(scalar[1]);
      continue;
    }
    if (/^\s*env_file:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const item = /^\s+-\s*(.+?)\s*$/.exec(lines[j]);
        if (!item) break;
        values.push(item[1]);
      }
    }
  }
  return values;
}

/** UPPERCASE_KEY entries of a section's `environment:` map (in order). */
function environmentKeys(section: string): string[] {
  const lines = section.split("\n");
  const start = lines.findIndex((line) => /^\s*environment:\s*$/.test(line));
  if (start === -1) return [];
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s+([A-Z_][A-Z0-9_]*):\s/.exec(lines[i]);
    if (!m) break;
    keys.push(m[1]);
  }
  return keys;
}

/** KEY=VALUE lines only — comments and blanks are guidance, not config. */
function activeEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    keys.push(line.slice(0, eq).trim());
  }
  return keys;
}

/**
 * Split deploy/oci/env.example into its documented per-file blocks.
 * Block headers are the `# ===== FILE: <path> =====` markers.
 */
function envExampleBlocks(content: string): Record<string, string> {
  const blocks: Record<string, string> = {};
  const marker = /^# =+ FILE: (.+?) =+$/;
  let current = "";
  for (const line of content.split("\n")) {
    const m = marker.exec(line);
    if (m) {
      current = m[1].trim();
      blocks[current] = "";
      continue;
    }
    if (current) blocks[current] += `${line}\n`;
  }
  return blocks;
}

const HOST_BLOCK = "/opt/fayanms/.env";
const APP_BLOCK = "/opt/fayanms/.env.app";
const WORKER_BLOCK = "/opt/fayanms/.env.worker";

describe("RT-006: no service mounts the monolithic env file", () => {
  const compose = readRepoFile("deploy/oci/compose.yml");

  test("the only runtime env_files in the stack are .env.app and .env.worker", () => {
    const allEnvFiles = OCI_SERVICES.flatMap((service) =>
      envFileValues(composeServiceSection(compose, service))
    );
    // Exact set: the app-zone and worker-zone files, nothing else.
    expect([...allEnvFiles].sort()).toEqual([".env.app", ".env.worker"]);
    for (const value of allEnvFiles) {
      expect(value).not.toBe(".env");
      expect(value.endsWith("/.env")).toBeFalse();
    }
  });

  test("app is the ONLY app-zone container (env_file: .env.app)", () => {
    expect(envFileValues(composeServiceSection(compose, "app"))).toEqual([".env.app"]);
  });

  test("worker is the ONLY worker-zone container (env_file: .env.worker)", () => {
    expect(envFileValues(composeServiceSection(compose, "worker"))).toEqual([
      ".env.worker",
    ]);
  });

  test("postgres/migrate/caddy receive NO env_file at all", () => {
    for (const service of ["postgres", "migrate", "caddy"] as const) {
      expect(envFileValues(composeServiceSection(compose, service))).toEqual([]);
    }
  });
});

describe("RT-006: per-service environment maps stay inside their zone", () => {
  const compose = readRepoFile("deploy/oci/compose.yml");

  test("worker env map carries NO app-zone material (KEK/session/DB/proxy knobs)", () => {
    const worker = composeServiceSection(compose, "worker");
    expect(environmentKeys(worker)).toEqual(["NODE_ENV", "NEXT_BASE_URL"]);
    // Raw-substring guard: neither the env_file nor the environment map may
    // name the app-zone secrets (catches future inline-map pollution too).
    expect(worker).not.toContain("FAYANMS_CONFIG_ENC_KEY");
    expect(worker).not.toContain("NEXTAUTH_SECRET");
    expect(worker).not.toContain("POSTGRES_PASSWORD");
    expect(worker).not.toContain("DATABASE_URL");
  });

  test("postgres receives ONLY POSTGRES_* keys (interpolated, no env_file)", () => {
    const postgres = composeServiceSection(compose, "postgres");
    const keys = environmentKeys(postgres);
    expect(keys).toEqual(["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_PASSWORD"]);
    for (const key of keys) expect(key.startsWith("POSTGRES_")).toBeTrue();
  });

  test("caddy receives ONLY the TLS domain — zero secrets reach the edge proxy", () => {
    const caddy = composeServiceSection(compose, "caddy");
    expect(environmentKeys(caddy)).toEqual(["FAYANMS_TLS_DOMAIN"]);
    expect(caddy).not.toContain("FAYANMS_CONFIG_ENC_KEY");
    expect(caddy).not.toContain("NEXTAUTH_SECRET");
  });

  test("migrate receives ONLY NODE_ENV + the interpolated DATABASE_URL", () => {
    expect(environmentKeys(composeServiceSection(compose, "migrate"))).toEqual([
      "NODE_ENV",
      "DATABASE_URL",
    ]);
  });

  test("app keeps the composed DATABASE_URL/NEXTAUTH_URL environment next to .env.app", () => {
    const app = composeServiceSection(compose, "app");
    expect(envFileValues(app)).toEqual([".env.app"]);
    expect(app).toContain("DATABASE_URL");
    expect(app).toContain("NEXTAUTH_URL");
    expect(app).toContain("NEXT_PUBLIC_SITE_URL");
  });
});

describe("RT-006: env.example documents the three-file layout with the zone contract", () => {
  const content = readRepoFile("deploy/oci/env.example");
  const blocks = envExampleBlocks(content);

  test("all three blocks are present", () => {
    expect(Object.keys(blocks).sort()).toEqual([HOST_BLOCK, APP_BLOCK, WORKER_BLOCK].sort());
  });

  test("host block carries the interpolation values compose needs", () => {
    const keys = activeEnvKeys(blocks[HOST_BLOCK] ?? "");
    for (const key of [
      "FAYANMS_IMAGE",
      "FAYANMS_WORKER_IMAGE",
      "FAYANMS_MIGRATOR_IMAGE",
      "FAYANMS_TLS_DOMAIN",
      "NEXTAUTH_URL",
      "NEXT_PUBLIC_SITE_URL",
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
    ]) {
      expect(keys).toContain(key);
    }
  });

  test("host block carries NO runtime secret material (no KEK/session/keypair/vault)", () => {
    const keys = activeEnvKeys(blocks[HOST_BLOCK] ?? "");
    for (const key of [
      "NEXTAUTH_SECRET",
      "FAYANMS_CONFIG_ENC_KEY",
      "FAYANMS_CONFIG_ENC_KEY_ID",
      "FAYANMS_SERVICE_PRIVATE_KEY",
      "FAYANMS_SERVICE_PUBLIC_KEYS",
      "FAYANMS_SERVICE_SECRET",
    ]) {
      expect(keys).not.toContain(key);
    }
    for (const key of keys) {
      expect(key.startsWith("FAYANMS_VAULT_")).toBeFalse();
    }
  });

  test("app block is app-zone only (session, KEK, CONTROL keypair, proxy knobs, metrics token)", () => {
    const keys = activeEnvKeys(blocks[APP_BLOCK] ?? "");
    for (const key of [
      "NEXTAUTH_SECRET",
      "FAYANMS_CONFIG_ENC_KEY",
      "FAYANMS_CONFIG_ENC_KEY_ID",
      "FAYANMS_SERVICE_PRIVATE_KEY",
      "FAYANMS_SERVICE_PUBLIC_KEYS",
      "FAYANMS_TRUST_PROXY_HOPS",
      "FAYANMS_METRICS_TOKEN",
    ]) {
      expect(keys).toContain(key);
    }
  });

  test("app block carries NO worker-zone material (vault keys, CA pin, worker hops, DB)", () => {
    const keys = activeEnvKeys(blocks[APP_BLOCK] ?? "");
    for (const key of keys) {
      expect(key.startsWith("FAYANMS_VAULT_")).toBeFalse();
    }
    for (const key of [
      "FAYANMS_WEBAPI_CA_PEM",
      "NEXT_BASE_URL",
      "SELF_BASE_URL",
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  test("worker block is worker-zone only (WORKER keypair, vault, CA pin, metrics token)", () => {
    const keys = activeEnvKeys(blocks[WORKER_BLOCK] ?? "");
    for (const key of [
      "FAYANMS_SERVICE_PRIVATE_KEY",
      "FAYANMS_SERVICE_PUBLIC_KEYS",
      "FAYANMS_VAULT_PROVIDER",
      "FAYANMS_METRICS_TOKEN",
    ]) {
      expect(keys).toContain(key);
    }
  });

  test("worker block carries NO app-zone material (session, KEK, DB, proxy/login knobs)", () => {
    const keys = activeEnvKeys(blocks[WORKER_BLOCK] ?? "");
    for (const key of [
      "NEXTAUTH_SECRET",
      "NEXTAUTH_URL",
      "FAYANMS_CONFIG_ENC_KEY",
      "FAYANMS_CONFIG_ENC_KEY_ID",
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "FAYANMS_TRUST_PROXY_HOPS",
      "NEXT_PUBLIC_SITE_URL",
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  test("documents the one-time operator migration (cp snippet + chmod 600 of all three)", () => {
    expect(content).toContain("cp .env .env.pre-rt006");
    expect(content).toContain(
      "chmod 600 /opt/fayanms/.env /opt/fayanms/.env.app /opt/fayanms/.env.worker"
    );
  });
});

describe("RT-006: required-var interpolation contracts survive", () => {
  const compose = readRepoFile("deploy/oci/compose.yml");

  test("secrets cannot silently boot empty (every :? guard still in place)", () => {
    expect(compose).toContain(
      "${DATABASE_URL:?DATABASE_URL must be set in /opt/fayanms/.env}"
    );
    expect(compose).toContain("${NEXTAUTH_URL:?NEXTAUTH_URL must be set in /opt/fayanms/.env}");
    expect(compose).toContain(
      "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in /opt/fayanms/.env}"
    );
    expect(compose).toContain(
      "${FAYANMS_TLS_DOMAIN:?FAYANMS_TLS_DOMAIN must be set in /opt/fayanms/.env}"
    );
    expect(compose).toContain(
      "${FAYANMS_IMAGE:?FAYANMS_IMAGE must be an immutable GHCR reference}"
    );
    expect(compose).toContain(
      "${FAYANMS_WORKER_IMAGE:?FAYANMS_WORKER_IMAGE must be an immutable GHCR reference}"
    );
    expect(compose).toContain(
      "${FAYANMS_MIGRATOR_IMAGE:?FAYANMS_MIGRATOR_IMAGE must be an immutable GHCR reference}"
    );
  });
});

describe("RT-006: deploy.sh refuses a stale host layout before half-booting", () => {
  const deployScript = readRepoFile("deploy/oci/deploy.sh");

  test("preflight source-guards both split files with a pointer to env.example", () => {
    expect(deployScript).toContain("for split_file in .env.app .env.worker");
    expect(deployScript).toMatch(/\[\[ -r "\$ROOT\/\$split_file" \]\]/);
    expect(deployScript).toContain("exit 1");
    expect(deployScript).toContain("deploy/oci/env.example");
    // The preflight runs BEFORE the compose invocations (the actual
    // invocations all use `docker compose --env-file`; plain "docker compose"
    // also appears in the preflight's own comment).
    const preflightAt = deployScript.indexOf("for split_file in .env.app .env.worker");
    const composeAt = deployScript.indexOf("docker compose --env-file");
    expect(preflightAt).toBeGreaterThan(-1);
    expect(composeAt).toBeGreaterThan(preflightAt);
  });

  test("behaviorally exits nonzero when .env.app/.env.worker are missing", () => {
    if (!Bun.which("bash")) {
      console.warn("rt006 deploy preflight skipped: bash unavailable");
      return;
    }
    const deployPath = path.join(REPO_ROOT, "deploy/oci/deploy.sh");
    const sha = "a".repeat(40);
    const runDeploy = (root: string) =>
      Bun.spawnSync(["bash", deployPath, sha], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          FAYANMS_ROOT: root,
          FAYANMS_STATE_DIR: path.join(root, "state"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });

    const dir = mkdtempSync(path.join(os.tmpdir(), "rt006-preflight-"));
    try {
      // Stale monolithic layout: host .env exists (readable), split files don't.
      writeFileSync(path.join(dir, ".env"), "FAYANMS_IMAGE=x\n");
      chmodSync(path.join(dir, ".env"), 0o600);

      let run = runDeploy(dir);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain(".env.app");

      // Progressive case: .env.app present but .env.worker missing → still refused.
      writeFileSync(path.join(dir, ".env.app"), "NEXTAUTH_SECRET=x\n");
      run = runDeploy(dir);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain(".env.worker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RT-006: bootstrap enforces mode 600 on all three host env files", () => {
  const bootstrap = readRepoFile("deploy/oci/bootstrap.sh");

  test("the 600 loop covers .env, .env.app and .env.worker", () => {
    expect(bootstrap).toContain(
      "for env_file in /opt/fayanms/.env /opt/fayanms/.env.app /opt/fayanms/.env.worker"
    );
    expect(bootstrap).toContain("stat -c '%a' \"$env_file\"");
    expect(bootstrap).toContain('"$mode" != "600"');
    expect(bootstrap).toContain("must be mode 600");
  });

  test("bootstrap points operators at env.example for the split layout", () => {
    expect(bootstrap).toContain("deploy/oci/env.example");
  });
});
