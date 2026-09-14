import { decryptAtRest, webhookSecretAad } from "@/lib/config/crypto";
import { maskSecret } from "@/lib/integrations/webhook-sign";

/**
 * Shared webhook types/helpers (Task 7-b) — kept OUT of route modules so
 * Next.js route-export validation stays clean and both the collection and
 * [id] routes serialize rows identically.
 */

/** Advisory event catalog rendered by the create dialog. */
export const WEBHOOK_EVENT_CATALOG = [
  "alert.fired",
  "alert.resolved",
  "incident.created",
  "incident.resolved",
  "change.executed",
  "change.failed",
  "drift.detected",
  "backup.completed",
  "test",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENT_CATALOG)[number];

function parseEvents(eventsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(eventsJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((e): e is string => typeof e === "string");
    }
  } catch {
    // fall through
  }
  return [];
}

/** Serialize a WebhookEndpoint row WITHOUT ever exposing the raw secret.
 *
 *  P1-011 (secret at rest): the stored value is the KEK-encrypted envelope
 *  (enc1:...) — masking runs on the DECRYPTED secret so the view shows the
 *  last 8 characters of the PLAINTEXT, not of the envelope. Legacy rows
 *  (plaintext stored before P1-011) decrypt as pass-through and mask
 *  identically. */
export function webhookView(row: {
  id: string;
  name: string;
  url: string;
  secret: string;
  eventsJson: string;
  isActive: boolean;
  lastStatus: string | null;
  lastStatusCode: number | null;
  lastDeliveredAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}) {
  const signingSecret = decryptAtRest(row.secret, webhookSecretAad(row.id));
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secretMasked: maskSecret(signingSecret),
    events: parseEvents(row.eventsJson),
    isActive: row.isActive,
    lastStatus: row.lastStatus,
    lastStatusCode: row.lastStatusCode,
    lastDeliveredAt: row.lastDeliveredAt
      ? row.lastDeliveredAt.toISOString()
      : null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The endpoint's PLAINTEXT signing secret for the delivery path (P1-011):
 * callers (webhook dispatch) NEVER read the secret column directly — they
 * resolve it through this decrypt-or-passthrough helper, which fails loudly
 * on tampered envelopes or a foreign keyId.
 */
export function webhookSigningSecret(row: { id: string; secret: string }): string {
  return decryptAtRest(row.secret, webhookSecretAad(row.id));
}

/** Notification channel shared catalog + serialization (same view). */
export const NOTIFICATION_CHANNEL_TYPES = ["EMAIL", "WEBHOOK"] as const;
export type NotificationChannelType = (typeof NOTIFICATION_CHANNEL_TYPES)[number];

export function channelView(row: {
  id: string;
  name: string;
  type: string;
  configJson: string;
  isActive: boolean;
  lastTestAt: Date | null;
  lastTestResult: string | null;
  createdAt: Date;
}) {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.configJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    config = {};
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    // Safe fields only — never surface provider secrets if any creep in.
    config,
    isActive: row.isActive,
    lastTestAt: row.lastTestAt ? row.lastTestAt.toISOString() : null,
    lastTestResult: row.lastTestResult,
    createdAt: row.createdAt.toISOString(),
  };
}
