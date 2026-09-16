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
 *
 * R50-T001: null is a POLICY DECISION, never a persistence outcome. Callers
 * that may opt into capture mode (enrollHostKey) MUST resolve the trust
 * state via `resolveHostKeyTrustState` instead — converting a trust-store
 * error into null was the R50-001 P0 fail-open (unknown trust state was
 * silently treated as first contact).
 */
export async function getHostKeyPin(
  host: string,
  port: number
): Promise<HostKeyPin | null> {
  const row = await getEnrollment(host, port);
  return row ? { fingerprint: row.fingerprint } : null;
}

/* ── R50-T002 — explicit host-key trust state ──────────────────────────── */

/**
 * The trust state of an SSH endpoint, resolved EXPLICITLY (R50-T002):
 *
 *   - `"enrolled"`      → the endpoint has a pinned key; the pin rides along.
 *   - `"unenrolled"`    → PROVEN absent enrollment row (first contact may be
 *                         allowed, in the audited capture mode). This is the
 *                         ONLY capture-eligible state.
 *   - `"lookup-failed"` → the trust store itself was unusable. This state
 *                         exists because conflating it with `"unenrolled"`
 *                         is the R50-001 P0 fail-open: a persistence error
 *                         used to become `null` → capture mode → credentials
 *                         could be presented to an impostor. Unknown trust
 *                         state is NEVER first contact — callers must abort
 *                         (fail-closed) before any connection.
 */
export type HostKeyTrustState =
  | { state: "enrolled"; fingerprint: string; keyType: string; enrolledAt: Date }
  | { state: "unenrolled" }
  | { state: "lookup-failed"; reason: string };

/**
 * Classify any trust-store persistence failure into a bounded, non-secret
 * reason code (Prisma P-codes, DNS/IO codes, error class names). Values
 * (messages, connection strings, key material) are never echoed.
 */
export function trustLookupFailureReason(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; errorCode?: unknown; name?: unknown };
    for (const candidate of [e.code, e.errorCode]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate;
    }
    if (typeof e.name === "string" && e.name && e.name !== "Error") {
      return e.name;
    }
  }
  return "TRUST_LOOKUP_UNKNOWN";
}

/** The real enrollment lookup used unless a caller injects one (tests). */
async function defaultEnrollmentLookup(
  host: string,
  port: number
): Promise<{ fingerprint: string; keyType: string; enrolledAt: Date } | null> {
  return db.sshHostKey.findUnique({
    where: { host_port: { host, port } },
    select: { fingerprint: true, keyType: true, enrolledAt: true },
  });
}

/**
 * Resolve the trust state for an endpoint WITHOUT ever converting a
 * persistence failure into "unenrolled" (R50-T001). Total function: a
 * failed lookup is a typed RESULT (`lookup-failed` + bounded reason),
 * mirroring resolveHostToIp's style. The `lookup` seam is injectable for
 * the SAFE-001 regression matrix (R50-T003).
 */
export async function resolveHostKeyTrustState(
  host: string,
  port: number,
  lookup: (
    host: string,
    port: number
  ) => Promise<{ fingerprint: string; keyType: string; enrolledAt: Date } | null> = defaultEnrollmentLookup
): Promise<HostKeyTrustState> {
  const normalizedHost = (host ?? "").trim();
  if (!normalizedHost || !Number.isInteger(port) || port <= 0 || port > 65535) {
    // An invalid endpoint coordinate is NOT a proven first contact either —
    // the caller cannot have a trustworthy target identity to probe.
    return { state: "lookup-failed", reason: "TRUST_LOOKUP_INVALID_ENDPOINT" };
  }
  try {
    const row = await lookup(normalizedHost, port);
    if (!row) return { state: "unenrolled" };
    return {
      state: "enrolled",
      fingerprint: row.fingerprint,
      keyType: row.keyType,
      enrolledAt: row.enrolledAt,
    };
  } catch (error) {
    return { state: "lookup-failed", reason: trustLookupFailureReason(error) };
  }
}
