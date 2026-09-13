/**
 * FayaNMS worker — credential vault resolver (Phase 22 slice 1).
 *
 * SECURITY MODEL (mirrors the app-side invariant enforced in
 * src/app/api/v1/credentials/*): the application stores only vault
 * REFERENCES ("secretRef", e.g. "vault://ssh/network-admin") and job
 * payloads carry the reference only — a secret NEVER travels through the
 * Next.js API, the database, or the worker claim channel.
 *
 * The worker is the component that actually connects to devices, so it
 * resolves a reference against ITS OWN operator-managed environment at
 * execution time:
 *
 *   vault://ssh/network-admin   →   FAYANMS_VAULT_SSH_NETWORK_ADMIN
 *
 * Normalization: strip the vault:// scheme, uppercase, collapse every
 * run of non-alphanumeric characters into a single underscore.
 *
 * Fail-closed: an unresolved reference is a typed VaultError — never an
 * empty string, never a fallback — and secret VALUES are never logged
 * (only reference names / env var names appear in messages).
 */

export class VaultError extends Error {
  constructor(
    public readonly code:
      | "CREDENTIAL_REF_INVALID"
      | "CREDENTIAL_UNRESOLVED",
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/** vault://ssh/network-admin → FAYANMS_VAULT_SSH_NETWORK_ADMIN */
export function vaultEnvName(secretRef: string): string {
  const ref = (secretRef ?? "").trim();
  if (!ref.toLowerCase().startsWith("vault://")) {
    throw new VaultError(
      "CREDENTIAL_REF_INVALID",
      `secretRef "${secretRef}" is not a vault:// reference`,
    );
  }
  const path = ref.slice("vault://".length);
  if (!path.trim()) {
    throw new VaultError(
      "CREDENTIAL_REF_INVALID",
      `secretRef "${secretRef}" has an empty vault path`,
    );
  }
  const norm = path
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `FAYANMS_VAULT_${norm}`;
}

/** Resolve a vault reference to its secret from the worker environment. */
export function resolveVaultSecret(secretRef: string): string {
  const envName = vaultEnvName(secretRef);
  const value = process.env[envName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new VaultError(
      "CREDENTIAL_UNRESOLVED",
      `Vault reference ${secretRef} has no worker-side entry — set ${envName} on the worker environment (runbook T6 / README Phase 22)`,
    );
  }
  return value;
}
