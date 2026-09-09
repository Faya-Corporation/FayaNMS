import { createHmac } from "node:crypto";

/**
 * Signed webhook delivery (Task 7-b).
 *
 * Demo-safe POST with HMAC-SHA256 request signing and a hard 5s timeout:
 *   - body: serialized JSON payload,
 *   - header X-Faya-Signature: sha256=<hex hmac of the raw body>,
 *   - a network failure is a recorded OUTCOME (never a thrown 500) — the
 *     caller persists lastStatus/lastStatusCode/lastError on the row.
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
      error: delivered ? null : `Endpoint answered HTTP ${response.status}`,
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
