/**
 * FayaNMS worker — credential vault resolver (Phase 22 slice 1 / P1-005).
 *
 * SECURITY MODEL (mirrors the app-side invariant enforced in
 * src/app/api/v1/credentials/*): the application stores only vault
 * REFERENCES ("secretRef", e.g. "vault://ssh/network-admin") and job
 * payloads carry the reference only — a secret NEVER travels through the
 * Next.js API, the database, or the worker claim channel. The worker is
 * the component that actually connects to devices, so it resolves a
 * reference against ITS OWN operator-managed secret backend at execution
 * time.
 *
 * P1-005 (ULTRA audit: ""Vault" is env-var lookup"): the resolver is now a
 * real provider-based vault with three operator-selectable backends. The
 * reference grammar is UNCHANGED — `vault://<path>` — and a reference never
 * encodes its provider: the backend is a deployment-level choice, so
 * rotating from env vars to a file (or a CLI vault wrapper) never silently
 * re-interprets an existing reference. This is a recorded design decision:
 * per-ref provider prefixes (vault://file/…) were REJECTED because the
 * first path segment would be ambiguous against real vault paths.
 *
 *   FAYANMS_VAULT_PROVIDER = env (default) | file | exec
 *
 *   env  — the original model, retained for development and simple
 *          deployments:  vault://ssh/network-admin → FAYANMS_VAULT_SSH_
 *          NETWORK_ADMIN (strip scheme, uppercase, collapse non-alnum runs
 *          into one underscore).
 *
 *   file — FAYANMS_VAULT_FILE points at a JSON object mapping secrets:
 *          { "vault://ssh/network-admin": "…", "ssh/db-backup": "…",
 *            "FAYANMS_VAULT_SSH_HARNESS": "…" }
 *          Lookup order: exact full reference → bare path → the env-style
 *          normalized name (so an operator can migrate the env model by
 *          exporting the same names into the file). The file is read at
 *          every resolution (no secret ever lingers in worker memory
 *          longer than the job), and a group/other-readable mode draws a
 *          loud POSIX-only warning (fail-open on the warning only, because
 *          Windows/Docker bind-mounts cannot always carry 0600 — refusing
 *          there would break legitimate deployments; documented).
 *
 *   exec — FAYANMS_VAULT_EXEC is an argv template (space-split, NO shell)
 *          in which every `%s` becomes the raw reference (if no `%s`
 *          appears, the reference is appended as the final argument). The
 *          command's trimmed stdout is the secret. This wraps any real
 *          vault CLI (HashiCorp Vault agent, pass, 1Password CLI, a
 *          KMS-backed helper) without embedding vendor SDKs in the worker.
 *          Non-zero exit, empty output, spawn failure or timeout
 *          (FAYANMS_VAULT_EXEC_TIMEOUT_MS, default 5000, clamped to
 *          100–60000) are all fail-closed. stderr is surfaced only in
 *          error MESSAGES (≤200 chars, control chars stripped) — never
 *          stdout, which may carry the secret.
 *
 *          The exec provider is ASYNC with a manually enforced deadline:
 *          Bun's spawnSync (and Bun's implementation of node's spawnSync
 *          `timeout` option) silently ignores the deadline, so a
 *          synchronous deadline would be a lie on this runtime. The worker
 *          spawns the command, hard-kills it at the deadline (SIGTERM, then
 *          SIGKILL after 1 s), and every resolution therefore returns a
 *          Promise — `resolveVaultSecret` is awaited at each call site
 *          (adapter-router, runner, worker handlers, certify driver).
 *
 * Fail-closed: an unresolved reference is a typed VaultError — never an
 * empty string, never a fallback. Secret VALUES are never logged (only
 * reference names, provider names, env var names and exit codes appear in
 * messages).
 */

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

export class VaultError extends Error {
  constructor(
    public readonly code:
      | "CREDENTIAL_REF_INVALID"
      | "CREDENTIAL_UNRESOLVED"
      | "VAULT_PROVIDER_INVALID"
      | "VAULT_PROVIDER_MISCONFIGURED",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export type VaultProviderName = "env" | "file" | "exec";

const REF_PREFIX = "vault://";

/** vault://ssh/network-admin → FAYANMS_VAULT_SSH_NETWORK_ADMIN */
export function vaultEnvName(secretRef: string): string {
  const path = vaultRefPath(secretRef);
  const norm = path
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `FAYANMS_VAULT_${norm}`;
}

/** Validate the vault:// grammar and return the bare path after the scheme. */
export function vaultRefPath(secretRef: string): string {
  const ref = (secretRef ?? "").trim();
  if (!ref.toLowerCase().startsWith(REF_PREFIX)) {
    throw new VaultError(
      "CREDENTIAL_REF_INVALID",
      `secretRef "${secretRef}" is not a vault:// reference`,
    );
  }
  const path = ref.slice(REF_PREFIX.length);
  if (!path.trim()) {
    throw new VaultError(
      "CREDENTIAL_REF_INVALID",
      `secretRef "${secretRef}" has an empty vault path`,
    );
  }
  return path;
}

/**
 * The active, validated provider name — diagnostics may call this to state
 * WHICH backend is in play; unknown FAYANMS_VAULT_PROVIDER values throw
 * here too (fail-tight before any secret resolution is attempted).
 */
export function vaultProviderName(): VaultProviderName {
  const raw = (process.env.FAYANMS_VAULT_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "") return "env";
  if (raw === "env" || raw === "file" || raw === "exec") return raw;
  throw new VaultError(
    "VAULT_PROVIDER_INVALID",
    `FAYANMS_VAULT_PROVIDER "${raw}" is not one of: env, file, exec`,
  );
}

/** Resolve a vault reference to its secret via the configured provider. */
export async function resolveVaultSecret(secretRef: string): Promise<string> {
  const provider = vaultProviderName();
  if (provider === "file") return resolveViaFile(secretRef);
  if (provider === "exec") return resolveViaExec(secretRef);
  return resolveViaEnv(secretRef);
}

/* ------------------------------ env provider ----------------------------- */

function resolveViaEnv(secretRef: string): string {
  const envName = vaultEnvName(secretRef);
  const value = process.env[envName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new VaultError(
      "CREDENTIAL_UNRESOLVED",
      `Vault reference ${secretRef} has no worker-side entry — set ${envName} on the worker environment (or switch providers via FAYANMS_VAULT_PROVIDER; runbook T6 / README Phase 22)`,
    );
  }
  return value;
}

/* ------------------------------ file provider ---------------------------- */

const permWarnedFiles = new Set<string>();

function resolveViaFile(secretRef: string): string {
  const filePath = (process.env.FAYANMS_VAULT_FILE ?? "").trim();
  if (!filePath) {
    throw new VaultError(
      "VAULT_PROVIDER_MISCONFIGURED",
      "FAYANMS_VAULT_PROVIDER=file requires FAYANMS_VAULT_FILE to point at the secrets JSON file",
    );
  }
  let store: Record<string, unknown>;
  try {
    store = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new VaultError(
      "VAULT_PROVIDER_MISCONFIGURED",
      `Vault file "${filePath}" is unreadable or not valid JSON: ${(error as Error)?.message ?? "unknown"}`,
    );
  }
  if (store === null || typeof store !== "object" || Array.isArray(store)) {
    throw new VaultError(
      "VAULT_PROVIDER_MISCONFIGURED",
      `Vault file "${filePath}" must contain a JSON object mapping references to secrets`,
    );
  }

  // One loud warning when the secrets file is group/other-readable
  // (POSIX only — Windows/Docker bind-mount modes are not meaningful).
  if (process.platform !== "win32" && !permWarnedFiles.has(filePath)) {
    try {
      const mode = statSync(filePath).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        console.warn(
          `[vault] WARNING: secrets file "${filePath}" is mode ${mode.toString(8)} — group/other bits are set. Restrict it to 0600 on POSIX hosts.`,
        );
      }
      permWarnedFiles.add(filePath);
    } catch {
      /* stat raced the read — the read itself already failed hard if fatal */
    }
  }

  const path = vaultRefPath(secretRef);
  const envName = vaultEnvName(secretRef);
  const candidates = [secretRef.trim(), path, envName];
  for (const key of candidates) {
    const value = store[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  throw new VaultError(
    "CREDENTIAL_UNRESOLVED",
    `Vault reference ${secretRef} has no entry in "${filePath}" — expected one of the keys: ${candidates
      .map((k) => `"${k}"`)
      .join(", ")}`,
  );
}

/* ------------------------------ exec provider ---------------------------- */

const EXEC_TIMEOUT_DEFAULT_MS = 5000;
const EXEC_TIMEOUT_MIN_MS = 100;
const EXEC_TIMEOUT_MAX_MS = 60000;

function execTimeoutMs(): number {
  const parsed = Number.parseInt(
    process.env.FAYANMS_VAULT_EXEC_TIMEOUT_MS ?? "",
    10,
  );
  if (!Number.isFinite(parsed)) return EXEC_TIMEOUT_DEFAULT_MS;
  return Math.min(EXEC_TIMEOUT_MAX_MS, Math.max(EXEC_TIMEOUT_MIN_MS, parsed));
}

/** Shell-free argv template: every %s becomes the reference; else appended. */
export function execArgvFor(template: string, secretRef: string): string[] {
  const base = template.trim().split(/\s+/).filter(Boolean);
  if (base.length === 0) return [secretRef];
  let substituted = false;
  const argv = base.map((arg) => {
    if (arg.includes("%s")) {
      substituted = true;
      return arg.replaceAll("%s", secretRef);
    }
    return arg;
  });
  if (!substituted) argv.push(secretRef);
  return argv;
}

function resolveViaExec(secretRef: string): Promise<string> {
  const template = (process.env.FAYANMS_VAULT_EXEC ?? "").trim();
  if (!template) {
    throw new VaultError(
      "VAULT_PROVIDER_MISCONFIGURED",
      "FAYANMS_VAULT_PROVIDER=exec requires FAYANMS_VAULT_EXEC (argv template, e.g. \"/usr/bin/vault kv get -field=secret %s\")",
    );
  }
  const argv = execArgvFor(template, secretRef);
  const timeoutMs = execTimeoutMs();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let escalate: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (escalate) clearTimeout(escalate);
      fn();
    };

    // Manually enforced deadline: Bun ignores spawnSync/spawn `timeout`, so
    // the kill is ours — SIGTERM at the deadline, SIGKILL 1 s later if the
    // command ignored the polite signal.
    deadline = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      escalate = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 1000);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // Cap accumulation — a pathological command must not balloon memory.
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 1_048_576) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 65_536) stderr += chunk;
    });

    child.on("error", (err) => {
      finish(() =>
        reject(
          new VaultError(
            "CREDENTIAL_UNRESOLVED",
            `Vault exec for ${secretRef} failed to run "${argv[0]}": ${err.message} (timeout is ${timeoutMs}ms)`,
          ),
        ),
      );
    });

    child.on("close", (code, signal) => {
      if (timedOut || signal) {
        finish(() =>
          reject(
            new VaultError(
              "CREDENTIAL_UNRESOLVED",
              `Vault exec for ${secretRef} was terminated${signal ? ` by signal ${signal}` : ""} after the ${timeoutMs}ms timeout`,
            ),
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderrTail = stderr
          .replace(/[\r\n]+/g, " ")
          .replace(/[^\x20-\x7e]/g, "")
          .trim()
          .slice(0, 200);
        finish(() =>
          reject(
            new VaultError(
              "CREDENTIAL_UNRESOLVED",
              `Vault exec for ${secretRef} exited ${code}${stderrTail ? ` — ${stderrTail}` : ""}`,
            ),
          ),
        );
        return;
      }
      const secret = stdout.trim();
      if (!secret) {
        finish(() =>
          reject(
            new VaultError(
              "CREDENTIAL_UNRESOLVED",
              `Vault exec for ${secretRef} produced no output (empty stdout)`,
            ),
          ),
        );
        return;
      }
      finish(() => resolve(secret));
    });
  });
}
