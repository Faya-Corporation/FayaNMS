import { db } from "@/lib/db";
import { fail, firstIssueMessage, ok } from "../../../../_lib/api";
import { requireServiceOrPermission } from "@/lib/auth/service-auth";
import { authErrorToFail } from "@/lib/auth/session";
import {
  parseStoredProtocolQueueRetention,
  pruneProtocolEventQueue,
  readProtocolQueueRetentionSetting,
} from "@/lib/protocol/queue-retention";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/protocol/queue/retention/prune (RT-003)
 *
 * Runs ONE bounded ProtocolEventQueue retention sweep NOW (see
 * src/lib/protocol/queue-retention.ts): prunes terminal DELIVERED rows past
 * the delivered window and DEAD rows past the dead window — chunked,
 * status-guarded, and never touching a queue row that still owns
 * FlowRecords (FlowRecord.queueId is onDelete: Cascade).
 *
 * Gate (P19 SEC-002 — dual, same shape as metrics/retention/prune): the
 * worker scheduler drives this with a service JWT ("jobs" scope); the admin
 * UI drives it with a session holding "admin.system". Anonymous calls: 401.
 *
 * Guard: at most one prune per 60 s (module-scope timestamp + the persisted
 * lastPrunedAt as a restart-safe fallback — same style as the metrics prune).
 * A throttled run answers 429 PROTOCOL_QUEUE_PRUNE_THROTTLED; the worker
 * treats that as a graceful no-op (job SUCCEEDED, outcome "throttled").
 */

const bodySchema = z
  .object({
    triggeredBy: z.string().trim().min(1).max(40).optional(),
  })
  .strict();

/** In-memory single-prune timestamp (module scope, per server process). */
let lastPruneStartedAtMs: number | null = null;
const THROTTLE_MS = 60_000;

export async function POST(request: Request) {
  try {
    await requireServiceOrPermission(request, "admin.system", "jobs");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }
  let body: unknown = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }
  const parsed = bodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }
  const triggeredBy = parsed.data.triggeredBy;

  const now = new Date();

  // ── 60 s throttle (in-memory + restart-safe persisted fallback) ──────
  const setting = await readProtocolQueueRetentionSetting();
  const stored = parseStoredProtocolQueueRetention(setting?.valueJson);
  const storedMs = stored.lastPrunedAt ? Date.parse(stored.lastPrunedAt) : Number.NaN;
  const lastMs =
    lastPruneStartedAtMs ?? (Number.isFinite(storedMs) ? storedMs : null);
  if (lastMs !== null && now.getTime() - lastMs < THROTTLE_MS) {
    const retryInSec = Math.ceil((THROTTLE_MS - (now.getTime() - lastMs)) / 1000);
    return fail(
      "PROTOCOL_QUEUE_PRUNE_THROTTLED",
      `A protocol queue retention prune ran less than 60 s ago — retry in ${retryInSec}s`,
      429
    );
  }
  lastPruneStartedAtMs = now.getTime();

  const result = await pruneProtocolEventQueue({ now, triggeredBy });
  return ok(result);
}
