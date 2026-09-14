import { createHmac } from "node:crypto";

import {
  DELIVERY_REDIRECT_POLICY,
  resolveAndValidateWebhookUrl,
} from "./ssrf-guard";

/**
 * Signed webhook delivery (Task 7-b) — now with SSRF egress control
 * (P1-010, external ULTRA audit).
 *
 * Demo-safe POST with HMAC-SHA256 request signing and a hard 5s timeout:
 *   - body: serialized JSON payload,
 *   - header X-Faya-Signature: sha256=<hex hmac of the raw body>,
 *   - EGRESS: the target is re-classified and DNS-resolved immediately
 *     before the fetch (`resolveAndValidateWebhookUrl`) — loopback,
 *     private, link-local/metadata and mapped/encoded addresses never
 *     reach the network; redirects are refused outright
 *     (`redirect: "error"`) so a public endpoint cannot bounce the request
 *     at an internal address,
 *   - a network failure (or an SSRF/DNS refusal — both never attempted)
 *     is a recorded OUTCOME (never a thrown 500) — the caller persists
 *     lastStatus/lastStatusCode/lastError on the row.
 */

export const SIGNATURE_HEADER = "X-Faya-Signature";

export const DELIVERY_TIMEOUT_MS = 5_000;

export interface DeliveryOutcome {
  delivered: boolean;
  /** DELIVERED (2xx) | REJECTED (non-2xx) | FAILED (network/timeout). */
  status: "DELIVERED" | "REJECTED" | "FAILED";
  statusCode: number | null;
  error: string | null;
  /** Round-trip milliseconds (best effort — absent on immediate failures). */
  durationMs?: number;
}

export function signPayload(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret).update(body, "utf8").digest("hex");
  return `sha256=${hmac}`;
}

/** POST a signed JSON payload with a bounded timeout. Never throws. */
export async function deliverSignedPost(
  url: string,
  payload: unknown,
  secret: string
): Promise<DeliveryOutcome> {
  const body = JSON.stringify(payload);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    // Egress gate (P1-010): resolve + classify BEFORE any byte is sent.
    const egress = await resolveAndValidateWebhookUrl(url);
    if (!egress.ok) {
      return {
        delivered: false,
        status: "FAILED",
        statusCode: null,
        error: egress.error,
      };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIGNATURE_HEADER]: signPayload(body, secret),
        "User-Agent": "FayaNMS/1.0 (webhook test)",
      },
      body,
      signal: controller.signal,
      cache: "no-store",
      // P1-010: a 3xx is an outcome, never a hop — the redirect target was
      // never validated and following it would bypass the egress gate.
      redirect: DELIVERY_REDIRECT_POLICY,
    });
    // Drain (bounded by the same abort signal) so sockets are released.
    try {
      await response.text();
    } catch {
      // Body read failures don't change the delivery outcome.
    }
    const delivered = response.ok;
    return {
      delivered,
      status: delivered ? "DELIVERED" : "REJECTED",
      statusCode: response.status,
      error: delivered
        ? null
        : response.status >= 300 && response.status < 400
          ? `Endpoint answered redirect HTTP ${response.status} — redirects are refused by egress policy`
          : `Endpoint answered HTTP ${response.status}`,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    const message =
      controller.signal.aborted
        ? `Timed out after ${DELIVERY_TIMEOUT_MS} ms`
        : ((error as Error)?.message ?? "Delivery failed");
    return {
      delivered: false,
      status: "FAILED",
      statusCode: null,
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}
