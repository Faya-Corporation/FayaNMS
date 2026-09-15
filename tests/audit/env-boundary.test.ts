import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  APP_ZONE_FORBIDDEN_VARS,
  findAppSecretScopeWarnings,
} from "../../src/lib/startup/security-policy";
import {
  WORKER_ZONE_FORBIDDEN_VARS,
  findWorkerSecretScopeWarnings,
} from "../../mini-services/worker/identity-boot";

/**
 * SEC-ENV-001 (TASK-SEC-ENV-001-A) — per-service secret-scope boundary.
 *
 * The confirmed finding: ONE `.env.production` served as the runtime
 * `env_file` of the app, the worker AND the one-off provision container, so
 * every process received secret material it never touches:
 *
 *   - the worker received NEXTAUTH_SECRET / FAYANMS_CONFIG_ENC_KEY (the KEK)
 *     / POSTGRES_PASSWORD / DATABASE_URL — it NEVER touches PostgreSQL or
 *     browser sessions, all persistence goes through the app API;
 *   - the app received FAYANMS_VAULT_* device credentials — it only ever
 *     stores vault REFERENCES (CredentialProfile.secretRef); the WORKER
 *     resolves the actual secrets;
 *   - provision received everything.
 *
 * Pinned here, structurally (parsing the real files, not formatting):
 *
 *   1. compose.yml maps each service to ITS OWN env file — the shared
 *      `.env.production` is no longer any container's runtime env; it is
 *      the host-side --env-file (interpolation) only;
 *   2. the interpolation template carries only host-side values;
 *   3. the app template carries app-zone material only;
 *   4. the worker template carries worker-zone material only;
 *   5. both runtimes WARN at boot on out-of-zone variables (deprecation
 *      path — refuses after the documented window), never echoing values;
 *   6. provision receives no env_file at all (its DATABASE_URL is composed
 *      by compose; demo-mode is an explicit -e override of the run command).
 */

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
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

function envFileValues(section: string): string[] {
  const values: string[] = [];
  for (const line of section.split("\n")) {
    const m = /^\s*env_file:\s*(.+?)\s*$/.exec(line);
    if (m) values.push(m[1]);
  }
  return values;
}

/** Test env literals are partial — ProcessEnv requires NODE_ENV (R33 lesson). */
const appWarnings = (env: Record<string, string>) =>
  findAppSecretScopeWarnings(env as NodeJS.ProcessEnv);
const workerWarnings = (env: Record<string, string>) =>
  findWorkerSecretScopeWarnings(env as NodeJS.ProcessEnv);

describe("SEC-ENV-001: compose.yml maps each service to its own env file", () => {
  const compose = readRepoFile("compose.yml");

  test("the shared .env.production is no longer any service's runtime env_file", () => {
    const allEnvFiles = [...compose.matchAll(/^\s*env_file:\s*(.+?)\s*$/gm)].map((m) => m[1]);
    expect(allEnvFiles.length).toBe(2);
    for (const value of allEnvFiles) {
      // Exact-match guard: .env.production must not survive as a runtime
      // env_file (.env.production.app / .env.production.worker are correct).
      expect(value.endsWith(".env.production")).toBeFalse();
    }
  });

  test("app runtime env_file is .env.production.app", () => {
    expect(envFileValues(composeServiceSection(compose, "app"))).toEqual([
      ".env.production.app",
    ]);
  });

  test("worker runtime env_file is .env.production.worker", () => {
    expect(envFileValues(composeServiceSection(compose, "worker"))).toEqual([
      ".env.production.worker",
    ]);
  });

  test("provision receives NO env_file (DATABASE_URL is composed; demo-mode is a -e override)", () => {
    const provision = composeServiceSection(compose, "provision");
    expect(envFileValues(provision)).toEqual([]);
    expect(provision).toContain("DATABASE_URL");
  });

  test("postgres receives no env_file (its only secret is interpolated POSTGRES_PASSWORD)", () => {
    const postgres = composeServiceSection(compose, "postgres");
    expect(envFileValues(postgres)).toEqual([]);
    expect(postgres).toContain("POSTGRES_PASSWORD");
  });

  test("the app still gets its composed DATABASE_URL via compose environment (external-DB path preserved)", () => {
    const app = composeServiceSection(compose, "app");
    expect(app).toContain("DATABASE_URL");
    expect(app).toContain("POSTGRES_PASSWORD");
  });
});

describe("SEC-ENV-001: host-side interpolation template stays host-side", () => {
  const content = readRepoFile("docs/deploy/env.production.example");
  const keys = activeEnvKeys(content);

  test("carries the host-side values compose interpolates", () => {
    expect(keys).toContain("NEXT_PUBLIC_SITE_URL");
    expect(keys).toContain("POSTGRES_PASSWORD");
  });

  test("carries NO app/worker runtime secret material", () => {
    const forbiddenExact = [
      "NEXTAUTH_SECRET",
      "NEXTAUTH_URL",
      "FAYANMS_CONFIG_ENC_KEY",
      "FAYANMS_CONFIG_ENC_KEY_ID",
      "FAYANMS_SERVICE_PRIVATE_KEY",
      "FAYANMS_SERVICE_PUBLIC_KEYS",
      "FAYANMS_SERVICE_SECRET",
      "FAYANMS_SERVICE_SECRETS",
      "FAYANMS_WEBAPI_CA_PEM",
      "FAYANMS_DEMO_MODE",
    ];
    for (const key of keys) {
      expect(forbiddenExact).not.toContain(key);
      expect(key.startsWith("FAYANMS_VAULT_")).toBeFalse();
    }
  });

  test("documents the per-service split and the two runtime env files", () => {
    expect(content).toContain(".env.production.app");
    expect(content).toContain(".env.production.worker");
  });
});

describe("SEC-ENV-001: app template is app-zone only", () => {
  const content = readRepoFile("docs/deploy/env.app.production.example");
  const keys = activeEnvKeys(content);

  test("carries the app-required material (session, KEK, service identity)", () => {
    for (const key of [
      "NEXTAUTH_URL",
      "NEXTAUTH_SECRET",
      "FAYANMS_CONFIG_ENC_KEY",
      "FAYANMS_CONFIG_ENC_KEY_ID",
      "FAYANMS_SERVICE_PRIVATE_KEY",
      "FAYANMS_SERVICE_PUBLIC_KEYS",
    ]) {
      expect(keys).toContain(key);
    }
  });

  test("carries NO device-vault credentials (the app stores references, the worker resolves)", () => {
    for (const key of keys) {
      expect(key.startsWith("FAYANMS_VAULT_")).toBeFalse();
    }
    expect(keys).not.toContain("FAYANMS_WEBAPI_CA_PEM");
  });

  test("carries NO worker/DB/session-cross-zone material", () => {
    for (const key of [
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "NEXT_BASE_URL",
      "SELF_BASE_URL",
      "FAYANMS_DEMO_MODE",
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  test("documents WHICH keypair lives here (CONTROL) and that public keys are the worker's", () => {
    expect(content).toContain("CONTROL");
    expect(content).toContain("WORKER");
  });
});

describe("SEC-ENV-001: worker template is worker-zone only", () => {
  const content = readRepoFile("docs/deploy/env.worker.production.example");
  const keys = activeEnvKeys(content);

  test("carries the worker-required identity material", () => {
    expect(keys).toContain("FAYANMS_SERVICE_PRIVATE_KEY");
    expect(keys).toContain("FAYANMS_SERVICE_PUBLIC_KEYS");
  });

  test("carries NO app-zone material (sessions, KEK, DB, proxy/login knobs)", () => {
    for (const key of [
      "NEXTAUTH_SECRET",
      "NEXTAUTH_URL",
      "FAYANMS_CONFIG_ENC_KEY",
      "FAYANMS_CONFIG_ENC_KEY_ID",
      "POSTGRES_PASSWORD",
      "DATABASE_URL",
      "FAYANMS_TRUST_PROXY_HOPS",
      "FAYANMS_LOGIN_WINDOW_SECONDS",
      "FAYANMS_LOGIN_MAX_ATTEMPTS_PER_SOURCE",
      "FAYANMS_LOGIN_MAX_ATTEMPTS_PER_ACCOUNT",
      "FAYANMS_DEMO_MODE",
      "NEXT_PUBLIC_SITE_URL",
      "WORKER_BASE_URL",
      "FAYANMS_DB_QUERY_LOG",
    ]) {
      expect(keys).not.toContain(key);
    }
  });

  test("documents the device-vault naming rule and the WORKER keypair ownership", () => {
    expect(content).toContain("FAYANMS_VAULT_");
    expect(content).toContain("WORKER");
    expect(content).toContain("CONTROL");
  });
});

describe("SEC-ENV-001: app boot warns on out-of-zone secrets (never echoes values)", () => {
  test("clean app-zone env produces zero warnings", () => {
    expect(
      appWarnings({
        NEXTAUTH_SECRET: "x".repeat(64),
        DATABASE_URL: "postgresql://fayanms:x@localhost:5432/fayanms",
        FAYANMS_CONFIG_ENC_KEY: "a".repeat(64),
      })
    ).toEqual([]);
  });

  test("device vault credentials in the app zone are flagged by name (wildcard)", () => {
    const warnings = appWarnings({
      FAYANMS_VAULT_SSH_NETWORK_ADMIN: "super-secret-device-password",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.variable).toBe("FAYANMS_VAULT_SSH_NETWORK_ADMIN");
  });

  test("worker-zone TLS pin and DB material in the app zone are flagged", () => {
    const warnings = appWarnings({
      FAYANMS_WEBAPI_CA_PEM: "-----BEGIN CERTIFICATE-----",
      POSTGRES_PASSWORD: "db-password-value",
      NEXT_BASE_URL: "http://app:3000",
      SELF_BASE_URL: "http://localhost:3030",
    });
    expect(warnings.map((w) => w.variable).sort()).toEqual([
      "FAYANMS_WEBAPI_CA_PEM",
      "NEXT_BASE_URL",
      "POSTGRES_PASSWORD",
      "SELF_BASE_URL",
    ]);
  });

  test("empty/whitespace variables are not 'received material' — no warning", () => {
    expect(appWarnings({ FAYANMS_VAULT_SSH_X: "   " })).toEqual([]);
  });

  test("reasons describe the zone and deprecation — NEVER the value", () => {
    const secretValue = "device-password-VALUE-never-echo";
    const warnings = appWarnings({
      FAYANMS_VAULT_SSH_NETWORK_ADMIN: secretValue,
      POSTGRES_PASSWORD: "another-VALUE",
    });
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(warnings)).not.toContain(secretValue);
    expect(JSON.stringify(warnings)).not.toContain("another-VALUE");
    expect(JSON.stringify(warnings)).toContain("worker");
  });

  test("material the app legitimately requires is never forbidden", () => {
    for (const key of ["NEXTAUTH_SECRET", "NEXTAUTH_URL", "DATABASE_URL", "FAYANMS_CONFIG_ENC_KEY", "FAYANMS_SERVICE_PRIVATE_KEY"]) {
      expect(APP_ZONE_FORBIDDEN_VARS).not.toContain(key);
    }
  });
});

describe("SEC-ENV-001: worker boot warns on out-of-zone secrets (never echoes values)", () => {
  test("clean worker-zone env produces zero warnings", () => {
    expect(
      workerWarnings({
        FAYANMS_SERVICE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
        FAYANMS_SERVICE_PUBLIC_KEYS: "decoded-spki",
        FAYANMS_VAULT_SSH_NETWORK_ADMIN: "device-secret",
        FAYANMS_WEBAPI_CA_PEM: "-----BEGIN CERTIFICATE-----",
        NEXT_BASE_URL: "http://app:3000",
        SELF_BASE_URL: "http://localhost:3030",
      })
    ).toEqual([]);
  });

  test("app-zone secrets reaching the worker are flagged by name", () => {
    const warnings = workerWarnings({
      NEXTAUTH_SECRET: "session-secret-VALUE",
      FAYANMS_CONFIG_ENC_KEY: "kek-VALUE",
      POSTGRES_PASSWORD: "db-VALUE",
      DATABASE_URL: "postgresql://fayanms:pw-VALUE@postgres:5432/fayanms",
    });
    expect(warnings.map((w) => w.variable).sort()).toEqual([
      "DATABASE_URL",
      "FAYANMS_CONFIG_ENC_KEY",
      "NEXTAUTH_SECRET",
      "POSTGRES_PASSWORD",
    ]);
  });

  test("app-only proxy/login/demo knobs reaching the worker are flagged", () => {
    const warnings = workerWarnings({
      FAYANMS_TRUST_PROXY_HOPS: "1",
      FAYANMS_LOGIN_WINDOW_SECONDS: "300",
      FAYANMS_DEMO_MODE: "true",
      NEXT_PUBLIC_SITE_URL: "http://fayanms.example.corp",
      WORKER_BASE_URL: "http://worker:3030",
    });
    expect(warnings.map((w) => w.variable).sort()).toEqual([
      "FAYANMS_DEMO_MODE",
      "FAYANMS_LOGIN_WINDOW_SECONDS",
      "FAYANMS_TRUST_PROXY_HOPS",
      "NEXT_PUBLIC_SITE_URL",
      "WORKER_BASE_URL",
    ]);
  });

  test("reasons NEVER echo the received values", () => {
    const warnings = workerWarnings({
      NEXTAUTH_SECRET: "session-secret-VALUE",
      DATABASE_URL: "postgresql://fayanms:pw-VALUE@postgres:5432/fayanms",
    });
    expect(JSON.stringify(warnings)).not.toContain("session-secret-VALUE");
    expect(JSON.stringify(warnings)).not.toContain("pw-VALUE");
  });

  test("material the worker legitimately requires is never forbidden", () => {
    for (const key of [
      "FAYANMS_SERVICE_PRIVATE_KEY",
      "FAYANMS_SERVICE_PUBLIC_KEYS",
      "FAYANMS_SERVICE_SECRET",
      "FAYANMS_WEBAPI_CA_PEM",
      "NEXT_BASE_URL",
      "SELF_BASE_URL",
    ]) {
      expect(WORKER_ZONE_FORBIDDEN_VARS).not.toContain(key);
    }
  });

  test("the two zones' forbidden lists agree on the prompt's minimum (worker: no NEXTAUTH_SECRET/KEK; app: no vault)", () => {
    expect(WORKER_ZONE_FORBIDDEN_VARS).toContain("NEXTAUTH_SECRET");
    expect(WORKER_ZONE_FORBIDDEN_VARS).toContain("FAYANMS_CONFIG_ENC_KEY");
    // The app side's vault refusal is wildcard-functional (tested above);
    // the KEK/session/DB trio is explicit on the worker side by design.
    expect(APP_ZONE_FORBIDDEN_VARS).toContain("POSTGRES_PASSWORD");
    expect(APP_ZONE_FORBIDDEN_VARS).toContain("FAYANMS_WEBAPI_CA_PEM");
  });
});

describe("SEC-ENV-001: deprecation wiring (warn now, documented refusal later)", () => {
  test("the app startup policy production branch emits the scope warnings", () => {
    const policy = readRepoFile("src/lib/startup/security-policy.ts");
    expect(policy).toContain("warnAppSecretScope()");
    // Warn path lives inside the production branch (after the violation check).
    const prodBranch = policy.slice(policy.indexOf('NODE_ENV === "production"'));
    expect(prodBranch).toContain("warnAppSecretScope()");
  });

  test("the worker boot path emits the scope warnings next to the identity assert", () => {
    const index = readRepoFile("mini-services/worker/index.ts");
    const bootBlock = index.slice(index.indexOf("if (import.meta.main)"));
    expect(bootBlock).toContain("assertWorkerServiceIdentity()");
    expect(bootBlock).toContain("warnWorkerSecretScope()");
  });
});
