import { mintServiceToken } from "@/lib/auth/service-auth";

/**
 * Next→worker control-plane client (Phase 19-C / audit GATEWAY-101).
 *
 * The worker's HTTP surface (/simulate/*, /capabilities) now requires a
 * service JWT, so the control plane authenticates every outbound call.
 * Tokens are minted with mintServiceToken (scopes ["simulate"], issuer
 * "fayanms:control") and cached for reuse — refreshed 60 s before expiry,
 * mirroring the worker's own next-client.ts pattern.
 *
 * SERVER-ONLY: relies on FAYANMS_SERVICE_SECRET from the process env and
 * is imported exclusively by API route handlers.
 */

const TOKEN_TTL_S = 300;

let cached: { token: string; expiresAtMs: number } | null = null;

function controlAuthToken(): string {
  const nowMs = Date.now();
  if (cached && cached.expiresAtMs - nowMs > 60_000) {
    return cached.token;
  }
  const token = mintServiceToken({
    issuer: "fayanms:control",
    subject: "control-plane",
    scopes: ["simulate"],
    ttlSeconds: TOKEN_TTL_S,
  });
  cached = { token, expiresAtMs: nowMs + TOKEN_TTL_S * 1000 };
  return token;
}

/** Authorization + content-type headers for worker control calls. */
export function workerControlHeaders(): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${controlAuthToken()}`,
  };
}
