/**
 * FayaNMS worker — adapter router (Phase 22 slice 1).
 *
 * Single routing point between the two device data planes:
 *   SIMULATOR (default)  → the in-memory simulator adapters (adapters.ts)
 *   LIVE_SSH             → the real-transport read-only adapter (live-ssh.ts)
 *
 * Routing is payload-driven: Device.dataSource reaches the worker via the
 * claim enrichment (src/app/api/v1/worker/claim) and the test-connection
 * probe body — both carrying the CredentialProfile REFERENCE fields
 * (username/port/secretRef) and NEVER a secret. The secret is resolved
 * HERE, worker-side, from the operator-managed vault environment, only at
 * the moment a connection is actually made.
 */

import { pickAdapter, type DeviceAdapter, type DeviceTarget } from "./adapters";
import { createLiveSshAdapter } from "./live-ssh";
import { resolveVaultSecret, VaultError } from "./vault";

export interface TargetCredential {
  username: string;
  port: number;
  secretRef: string;
}

/**
 * Parse the credential block carried in job payloads / probe bodies.
 * Throws (→ the caller's failure path) on any incomplete block: a LIVE_SSH
 * device without a usable reference can never silently fall back to the
 * simulator.
 */
export function parseTargetCredential(raw: unknown): TargetCredential | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new VaultError(
      "CREDENTIAL_REF_INVALID",
      "credential must be an object { username, port, secretRef } — the secret itself NEVER travels in payloads",
    );
  }
  const c = raw as Record<string, unknown>;
  const username = typeof c.username === "string" ? c.username.trim() : "";
  const secretRef = typeof c.secretRef === "string" ? c.secretRef.trim() : "";
  const portRaw = typeof c.port === "number" ? c.port : Number(c.port ?? 22);
  if (!username || !secretRef) {
    throw new VaultError(
      "CREDENTIAL_REF_INVALID",
      "credential is incomplete — LIVE_SSH requires { username, port, secretRef } (secretRef points into the worker-side vault)",
    );
  }
  if (!Number.isFinite(portRaw) || portRaw <= 0 || portRaw > 65535) {
    throw new VaultError(
      "CREDENTIAL_REF_INVALID",
      `credential port is invalid: ${String(c.port)}`,
    );
  }
  return { username, port: Math.floor(portRaw), secretRef };
}

export function isLiveTarget(target: Pick<DeviceTarget, "dataSource">): boolean {
  return (target.dataSource ?? "").trim().toUpperCase() === "LIVE_SSH";
}

/**
 * Resolve the adapter for a target. LIVE_SSH requires a parsed credential
 * block; anything else routes to the existing simulator behavior
 * (unknown vendor degrades to `generic`, unchanged).
 */
export function resolveAdapter(
  target: DeviceTarget,
  credential: TargetCredential | null,
): DeviceAdapter {
  if (isLiveTarget(target)) {
    if (!credential) {
      throw new VaultError(
        "CREDENTIAL_REF_INVALID",
        `Device ${target.hostname} is LIVE_SSH but carries no credential block — link a CredentialProfile (username/port/secretRef) first`,
      );
    }
    const password = resolveVaultSecret(credential.secretRef);
    return createLiveSshAdapter(target.vendor, {
      host: target.managementIp ?? target.hostname,
      port: credential.port,
      username: credential.username,
      password,
    });
  }
  return pickAdapter(target.vendor);
}
