import { db } from "@/lib/db";
import { decryptSnapshotTexts } from "@/lib/config/crypto";
import {
  fail,
  firstIssueMessage,
  newCorrelationId,
  ok,
} from "../../../../_lib/api";
import { diffLines, diffStats } from "@/lib/config/diff";
import { normalizeConfig } from "@/lib/config/normalize";
import { requirePermission, authErrorToFail } from "@/lib/auth/session";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/devices/[id]/snapshots/diff?from=3&to=4&mode=normalized
 *
 * Line diff between two snapshots OF THE SAME DEVICE (Task 3-b). `from`/`to`
 * accept a snapshot version number (numeric) or a snapshot id (cuid).
 * `mode` selects raw text vs normalized text (default: normalized).
 *
 * Side-effect free: when a snapshot has no stored normalizedText it is
 * computed on the fly (flagged via `normalized.from/to`) and NEVER written
 * back in a GET. Identical configs (same sha256) short-circuit to empty rows
 * so phantom diffs are impossible.
 *
 * AUTHORIZATION (R69 re-review remediation — closes the R62 invariant gap):
 * EVERY row of this response is built from DECRYPTED snapshot text (raw or
 * normalized), so the route is a derived config-text export and is gated
 * behind the SAME explicit "config.download" permission as the dedicated
 * download route — the proxy session check alone is NOT sufficient and
 * React masking is not an authorization boundary (P19 / audit SEC-005).
 * BEFORE this fix the handler had NO actor resolution and decrypted BOTH
 * snapshots for ANY authenticated session (viewer/auditor included).
 * Permission gate runs BEFORE any DB work (R52-F-N1 ordering — 401/403,
 * never a pre-auth existence oracle); rejected attempts are audited as
 * CONFIG_DIFF_DENIED (best-effort, mirroring CONFIG_DOWNLOAD_DENIED).
 */

const querySchema = z.object({
  from: z.string().trim().min(1).max(64),
  to: z.string().trim().min(1).max(64),
  mode: z.enum(["raw", "normalized"]).default("normalized"),
});

const ZERO_STATS = { added: 0, removed: 0, changed: 0, unchanged: 0 } as const;

interface EndpointSnapshot {
  snapshotId: string;
  version: number;
  createdAt: Date;
  sha256: string;
  source: string;
  status: string;
}

function toEndpointSnapshot(snap: {
  id: string;
  version: number;
  createdAt: Date;
  sha256: string;
  source: string;
  status: string;
}): EndpointSnapshot {
  return {
    snapshotId: snap.id,
    version: snap.version,
    createdAt: snap.createdAt,
    sha256: snap.sha256,
    source: snap.source,
    status: snap.status,
  };
}

/** Numeric refs are versions on this device; anything else is a snapshot id. */
async function resolveSnapshot(
  deviceId: string,
  ref: string
) {
  const isVersion = /^\d{1,9}$/.test(ref);
  return db.configSnapshot.findFirst({
    where: isVersion
      ? { deviceId, version: Number(ref) }
      : { deviceId, id: ref },
    select: {
      id: true,
      version: true,
      createdAt: true,
      sha256: true,
      source: true,
      status: true,
      rawText: true,
      normalizedText: true,
      encKeyId: true,
      encIv: true,
      encTag: true,
      normIv: true,
      normTag: true,
      wrappedDek: true,
      encAad: true, // AAD binding (CRYPTO-101) — required by decryptSnapshotTexts
      wrapIv: true,
      wrapTag: true,
    },
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || id.length > 64) {
    return fail("INVALID_ID", "Invalid device id", 400);
  }

  // Permission gate FIRST (before any DB work) — the diff rows are decrypted
  // configuration text, so this surface is download-privileged (R69).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.download");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    // Audit the rejected attempt (best-effort — the denial response wins).
    try {
      await db.auditEvent.create({
        data: {
          actorName: "unknown",
          action: "CONFIG_DIFF_DENIED",
          resourceType: "ConfigSnapshot",
          resourceId: id,
          resourceLabel: "snapshots/diff",
          result: "DENIED",
          correlationId: newCorrelationId("DF"),
          afterJson: JSON.stringify({
            reason: error instanceof Error ? error.message : "auth failure",
          }),
        },
      });
    } catch {
      /* audit best-effort */
    }
    return authFail;
  }
  void actor; // authorization boundary; per-row attribution rides X-Request-Id

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
    mode: url.searchParams.get("mode") ?? undefined,
  });
  if (!parsed.success) {
    return fail("INVALID_QUERY", firstIssueMessage(parsed.error), 400);
  }
  const { from, to, mode } = parsed.data;

  const device = await db.device.findUnique({
    where: { id },
    select: { id: true, hostname: true, vendor: { select: { key: true } } },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }
  const vendorKey = device.vendor?.key ?? "generic";

  const [fromSnap, toSnap] = await Promise.all([
    resolveSnapshot(id, from),
    resolveSnapshot(id, to),
  ]);
  if (!fromSnap || !toSnap) {
    const missing = !fromSnap ? "from" : "to";
    return fail(
      "UNKNOWN_SNAPSHOT",
      `Snapshot "${missing === "from" ? from : to}" (${missing}) was not found on device ${device.hostname}`,
      404
    );
  }

  // Correctness guard: byte-identical configs must never produce diff rows.
  if (fromSnap.sha256 === toSnap.sha256) {
    return ok({
      device: { id: device.id, hostname: device.hostname, vendorKey },
      from: toEndpointSnapshot(fromSnap),
      to: toEndpointSnapshot(toSnap),
      mode,
      identical: true,
      rows: [],
      stats: ZERO_STATS,
      normalized: {
        from: mode === "normalized" ? fromSnap.normalizedText !== null : false,
        to: mode === "normalized" ? toSnap.normalizedText !== null : false,
      },
    });
  }

  const fromUsedStored = mode === "normalized" && fromSnap.normalizedText !== null;
  const toUsedStored = mode === "normalized" && toSnap.normalizedText !== null;

  // P19 SEC-003: snapshot rows hold ciphertext — decrypt (legacy rows with
  // encKeyId=null pass through as plaintext) before diffing.
  const fromTexts = decryptSnapshotTexts(fromSnap);
  const toTexts = decryptSnapshotTexts(toSnap);

  const fromText = mode === "raw"
    ? fromTexts.rawText
    : (fromTexts.normalizedText ?? normalizeConfig(fromTexts.rawText, vendorKey));
  const toText = mode === "raw"
    ? toTexts.rawText
    : (toTexts.normalizedText ?? normalizeConfig(toTexts.rawText, vendorKey));

  const rows = diffLines(fromText.split("\n"), toText.split("\n"));

  return ok({
    device: { id: device.id, hostname: device.hostname, vendorKey },
    from: toEndpointSnapshot(fromSnap),
    to: toEndpointSnapshot(toSnap),
    mode,
    identical: false,
    rows,
    stats: diffStats(rows),
    normalized: { from: fromUsedStored, to: toUsedStored },
  });
}
