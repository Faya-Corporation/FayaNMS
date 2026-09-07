import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signing (Task 7-b).
 *
 * Every outbound webhook delivery carries an HMAC-SHA256 signature header
 * computed over the exact request body:
 *
 *   X-Faya-Signature: sha256=<hex-hmac(secret, body)>
 *
 * Receivers verify by recomputing the HMAC over the raw body with their
 * copy of the endpoint secret. The secret itself never appears in any API
 * response (masked to "••••" + last 8 chars by the admin routes).
 */
export const WEBHOOK_SIGNATURE_HEADER = "X-Faya-Signature";

export function signWebhookPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/** Constant-time comparison for receivers that echo verification back. */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string
): boolean {
  const expected = Buffer.from(signWebhookPayload(secret, body));
  const provided = Buffer.from(signature ?? "");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/** Mask a webhook secret for display: "••••••••" + last 8 characters. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "••••••••";
  return `••••••••${secret.slice(-8)}`;
}
