/**
 * FayaNMS worker — adapter router (Phase 22 slice 1 / CERT-006).
 *
 * Single routing point between the device data planes:
 *   SIMULATOR (default)  → the in-memory simulator adapters (adapters.ts)
 *   LIVE_SSH             → the real-transport read-only adapter, selected
 *                          BY VENDOR: the five CLI vendors ride SSH exec
 *                          (live-ssh.ts, SAFE-001 host-key pinning) and
 *                          sophos rides the SFOS WebAPI over TLS
 *                          (live-webapi.ts, channel-level TLS trust — the
 *                          HTTPS analog of host-key pinning; see
 *                          webapi-transport.ts for the fail-closed trust
 *                          model). The dataSource label predates
 *                          transport selection and is kept for UI/DB
 *                          stability — the plane is "live", the transport
 *                          is vendor-determined.
 *
 * Routing is payload-driven: Device.dataSource reaches the worker via the
 * claim enrichment (src/app/api/v1/worker/claim) and the test-connection
 * probe body — both carrying the CredentialProfile REFERENCE fields
 * (username/port/secretRef) and NEVER a secret. The secret is resolved
 * HERE, worker-side, from the operator-managed vault environment, only at
 * the moment a connection is actually made.
 *
 * SAFE-001 (audit P0-001): every SSH-live connection is host-key pinned.
 * The app passes the enrolled fingerprint (SshHostKey table) in the payload
 * as `sshHostKeyPin: { fingerprint }`; a live connection WITHOUT a pin is
 * refused before any connection is opened (SSH_HOSTKEY_UNENROLLED) except
 * in explicit enrollment mode (the audited enrollment probe on
 * /simulate/connect only). A malformed pin is a typed request error too
 * (SSH_HOSTKEY_PIN_INVALID) — never silently ignored. WebAPI vendors have
 * NO SSH handshake to pin — their trust gate is the TLS verification
 * policy, which is fail-closed with no bypass anywhere.
 */

import { pickAdapter, type DeviceAdapter, type DeviceTarget } from "./adapters";
import { createLiveSshAdapter } from "./live-ssh";
import { createLiveWebApiAdapter } from "./live-webapi";
import { resolveTargetForDial } from "./target-policy";
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
 * SAFE-001 — request-level host-key policy failure. Raised BEFORE any
 * connection is opened (the caller maps it to 400, mirroring VaultError:
 * nothing reached the device).
 */
export class HostKeyPolicyError extends Error {
  constructor(
    public readonly code: "SSH_HOSTKEY_UNENROLLED" | "SSH_HOSTKEY_PIN_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "HostKeyPolicyError";
  }
}

/**
 * R51-A1 (Independent Production ReAudit 2026-09-18, F-1) — request-level
 * target network-policy failure. The R50-T022 resolved-address policy was
 * enforced on the DETECTION probe plane only; every other LIVE dial plane
 * (CONFIG_BACKUP via resolveAdapter, /simulate/connect probes,
 * /live/fetch-config, /live/apply) dialed the raw payload address with
 * vault-resolved credentials. This error is raised BEFORE any credential
 * resolution or connection (the caller maps it to 400, mirroring
 * HostKeyPolicyError: nothing reached the device, no secret was read).
 */
export class TargetPolicyError extends Error {
  constructor(
    public readonly code:
      | "SSH_TARGET_POLICY_REFUSED"
      | "SSH_TARGET_UNRESOLVED"
      | "SSH_TARGET_RESOLVE_TIMEOUT",
    message: string,
  ) {
    super(message);
    this.name = "TargetPolicyError";
  }
}

/**
 * Resolve + govern the dial target for EVERY live transport (R51-A1):
 * the same resolved-address policy as the detection probe (R50-T022
 * follow-up), now applied to all dial planes. IP literals classify with
 * no I/O; hostnames resolve under the R50-T025 budget and EVERY candidate
 * address must pass (fail-closed across the RRset). Returns the VALIDATED
 * address the caller MUST dial (no second DNS lookup — the resolve-then-dial
 * rebinding window stays structurally closed); a governed target throws
 * TargetPolicyError BEFORE any credential resolution or network work.
 * The documented FAYANMS_PROBE_ALLOW_SPECIAL=true lab hatch is honored
 * (same hatch as the probe plane — app↔worker parity stays pinned).
 */
export async function guardDialTarget(
  host: string,
  resolve4Fn?: Parameters<typeof resolveTargetForDial>[1],
  resolve6Fn?: Parameters<typeof resolveTargetForDial>[2],
): Promise<string> {
  const dial = await resolveTargetForDial(host, resolve4Fn, resolve6Fn);
  if (!dial.decision.ok) {
    throw new TargetPolicyError(
      dial.decision.code,
      `${dial.decision.code}: ${dial.decision.detail} — the target network policy refuses this address class before any credential or connection work`,
    );
  }
  return dial.decision.dialedAddress;
}

/** OpenSSH-style fingerprint: "SHA256:" + 43 base64 chars (padding stripped). */
export const HOSTKEY_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * Parse + validate the `sshHostKeyPin` payload block
 * ({ fingerprint: "SHA256:…" } | absent). Returns the fingerprint string or
 * null. A MALFORMED pin throws SSH_HOSTKEY_PIN_INVALID — a broken pin must
 * fail the request, never fall back to an unpinned connection.
 */
export function parseHostKeyPin(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new HostKeyPolicyError(
      "SSH_HOSTKEY_PIN_INVALID",
      "sshHostKeyPin must be an object { fingerprint: \"SHA256:…\" } (the enrolled host-key pin)",
    );
  }
  const pin = raw as Record<string, unknown>;
  const fingerprint = typeof pin.fingerprint === "string" ? pin.fingerprint.trim() : "";
  if (!fingerprint || !HOSTKEY_FINGERPRINT_RE.test(fingerprint)) {
    throw new HostKeyPolicyError(
      "SSH_HOSTKEY_PIN_INVALID",
      `sshHostKeyPin.fingerprint is not an OpenSSH SHA256 fingerprint ("SHA256:" + 43 base64 chars): ${JSON.stringify(
        fingerprint.slice(0, 80),
      )}`,
    );
  }
  return fingerprint;
}

export interface ResolveAdapterOptions {
  /**
   * Pinned host-key fingerprint from the payload (null = not enrolled).
   * Required for every live connection UNLESS enrollmentMode is set.
   */
  hostKeyPin?: string | null;
  /**
   * Enrollment mode (SAFE-001): connect WITHOUT enforcement and CAPTURE the
   * presented key so the operator can pin it. Only the audited enrollment
   * probe on /simulate/connect may set this — never the job/backup/change
   * planes.
   */
  enrollmentMode?: boolean;
}

/**
 * Vendors whose LIVE transport is the device WebAPI over TLS (CERT-006)
 * instead of SSH exec. sophos is the founding member: the SFOS SSH CLI has
 * no read-only full-config dump, so its live plane was DESIGNED for the
 * WebAPI transport.
 */
export const LIVE_WEBAPI_VENDORS = ["sophos"] as const;

export function isLiveWebApiVendor(vendor: string | null | undefined): boolean {
  const key = (vendor ?? "").trim().toLowerCase();
  return (LIVE_WEBAPI_VENDORS as readonly string[]).includes(key);
}

/**
 * Resolve the adapter for a target. LIVE_SSH requires a parsed credential
 * block; SSH-live additionally requires (SAFE-001) a host-key pin except
 * in enrollment mode, WebAPI-live requires nothing SSH-side (its trust
 * gate is the fail-closed TLS policy). Anything else routes to the
 * existing simulator behavior (unknown vendor degrades to `generic`,
 * unchanged).
 */
export async function resolveAdapter(
  target: DeviceTarget,
  credential: TargetCredential | null,
  options: ResolveAdapterOptions = {},
): Promise<DeviceAdapter> {
  if (isLiveTarget(target)) {
    if (!credential) {
      throw new VaultError(
        "CREDENTIAL_REF_INVALID",
        `Device ${target.hostname} is LIVE_SSH but carries no credential block — link a CredentialProfile (username/port/secretRef) first`,
      );
    }
    // CERT-006 — WebAPI vendors route to the TLS transport INSTEAD of the
    // SSH pipeline: no host-key pin gate applies (there is no SSH
    // handshake to pin); trust is the fail-closed TLS policy documented in
    // webapi-transport.ts. The api-key rides the SAME vault secretRef
    // pipeline as SSH passwords — resolved worker-side, never transported.
    // R51-A1 — the target policy governs EVERY live dial plane: classify
    // the resolved address BEFORE any vault/credential work so a governed
    // target class never sees a resolved secret.
    const webApiDialHost = await guardDialTarget(
      target.managementIp ?? target.hostname,
    );
    if (isLiveWebApiVendor(target.vendor)) {
      const apiKey = await resolveVaultSecret(credential.secretRef);
      return createLiveWebApiAdapter(target.vendor, {
        host: webApiDialHost,
        port: credential.port,
        apiKey,
      });
    }
    const pin = options.hostKeyPin ?? null;
    if (!pin && !options.enrollmentMode) {
      throw new HostKeyPolicyError(
        "SSH_HOSTKEY_UNENROLLED",
        `Device ${target.hostname} has no pinned SSH host key — live connections are refused (fail-closed). Enroll the host key from the device page, then retry.`,
      );
    }
    // Defense in depth: a non-null pin MUST be well-formed. The payload
    // layer (parseHostKeyPin) validates first, but resolveAdapter never
    // trusts its callers — a malformed pin fails closed, never ignored.
    if (pin && !HOSTKEY_FINGERPRINT_RE.test(pin)) {
      throw new HostKeyPolicyError(
        "SSH_HOSTKEY_PIN_INVALID",
        `host-key pin is not an OpenSSH SHA256 fingerprint ("SHA256:" + 43 base64 chars): ${JSON.stringify(
          pin.slice(0, 80),
        )}`,
      );
    }
    // R51-A1 — the SSH dial plane is governed by the same resolved-address
    // policy (refusal BEFORE vault resolution), and the adapter dials the
    // VALIDATED address — never a second lookup of the original name.
    const sshDialHost = await guardDialTarget(
      target.managementIp ?? target.hostname,
    );
    // P1-005: vault resolution is async (exec provider carries a real
    // deadline); the adapter is resolved through the awaited promise.
    const password = await resolveVaultSecret(credential.secretRef);
    return createLiveSshAdapter(target.vendor, {
      host: sshDialHost,
      port: credential.port,
      username: credential.username,
      password,
      expectedFingerprint: pin,
      // Enrollment capture only when explicitly requested (and pin-less).
      onHostKey: options.enrollmentMode
        ? (meta): void => {
            recordedHostKey = meta;
          }
        : undefined,
    });
  }
  return pickAdapter(target.vendor);
}

/**
 * Enrollment capture slot — set by resolveAdapter's onHostKey callback
 * during an enrollment-mode connection and read by the /simulate/connect
 * handler to answer the probe with the presented key. Single-connection
 * lifetime: the probe records exactly one handshake.
 */
let recordedHostKey: { keyType: string; fingerprint: string } | null = null;

/** Read (and clear) the captured host key from the last enrollment-mode connection. */
export function takeRecordedHostKey(): { keyType: string; fingerprint: string } | null {
  const meta = recordedHostKey;
  recordedHostKey = null;
  return meta;
}
