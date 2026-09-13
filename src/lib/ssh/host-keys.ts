/**
 * SAFE-001 (audit P0-001) — SSH host-key enrollment helpers.
 *
 * The `SshHostKey` table pins ONE host key per SSH endpoint (host + port —
 * the known_hosts model). The worker transport enforces the pin DURING the
 * SSH handshake, BEFORE authentication (a mismatched key aborts the
 * connection without the credential ever being transmitted), and refuses
 * every LIVE connection that carries no pin (fail-closed) except the
 * audited enrollment probe.
 *
 * Invariants:
 *   - the fingerprint is the OpenSSH-style "SHA256:<base64(no padding)>" of
 *     the server's public key blob — the exact format the worker computes;
 *   - enrollment is an explicit, audited operator action (probe → confirm);
 *   - the stored blob (hostKeyBase64) is audit/display material — the
 *     enforcement compare happens on the FINGERPRINT only.
 */

import { db } from "@/lib/db";

/** OpenSSH-style fingerprint: "SHA256:" + 43 base64 chars (padding stripped). */
export const HOSTKEY_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

export function isValidHostKeyFingerprint(value: string): boolean {
  return HOSTKEY_FINGERPRINT_RE.test((value ?? "").trim());
}

/** Normalize a pasted fingerprint (trim). Padding is rejected at validation. */
export function normalizeHostKeyFingerprint(value: string): string {
  return (value ?? "").trim();
}

export interface HostKeyPin {
  fingerprint: string;
}

export interface HostKeyEnrollment {
  id: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  enrolledAt: Date;
  enrolledBy: string;
  lastVerifiedAt: Date | null;
}

/** Look up the enrollment for an endpoint (the known_hosts row). */
export async function getEnrollment(
  host: string,
  port: number
): Promise<HostKeyEnrollment | null> {
  const normalizedHost = (host ?? "").trim();
  if (!normalizedHost || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return null;
  }
  return db.sshHostKey.findUnique({
    where: { host_port: { host: normalizedHost, port } },
    select: {
      id: true,
      host: true,
      port: true,
      keyType: true,
      fingerprint: true,
      enrolledAt: true,
      enrolledBy: true,
      lastVerifiedAt: true,
    },
  });
}

/**
 * The pin block for job/probe payloads (`sshHostKeyPin`) — null when the
 * endpoint is not enrolled. The worker refuses unpinned live connections,
 * so a null here is a fail-closed state, never a bypass.
 */
export async function getHostKeyPin(
  host: string,
  port: number
): Promise<HostKeyPin | null> {
  const row = await getEnrollment(host, port);
  return row ? { fingerprint: row.fingerprint } : null;
}
