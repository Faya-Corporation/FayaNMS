import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission } from "@/lib/auth/session";
import { workerControlHeaders } from "@/lib/worker/control-client";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/test-connection — body: { deviceId }.
 *
 * Proxies a connectivity probe to the simulation worker mini-service
 * (bun :3030, roadmap 2-b) via an internal server-side fetch. The worker
 * may not be running (2-b lands in parallel) — the route is defensive:
 *   - any fetch/parse failure answers 200 with { reachable: false } so the
 *     UI can show a graceful "Worker service unreachable" message instead
 *     of an error state;
 *   - a reachable worker updates the device lastSeen (and status when the
 *     worker reports a known device status) and the result is audited.
 */

const WORKER_URL = "http://localhost:3030/simulate/connect";

const KNOWN_DEVICE_STATUSES = new Set([
  "ONLINE",
  "OFFLINE",
  "DEGRADED",
  "MAINTENANCE",
  "UNKNOWN",
  "UNMANAGED",
]);

const bodySchema = z.object({
  deviceId: z.string().trim().min(1, "deviceId is required").max(64),
});

interface WorkerProbe {
  reachable: boolean;
  ok: boolean;
  latencyMs: number | null;
  message: string | null;
  status: string | null;
  vendor: string | null;
  raw: unknown;
}

function parseWorkerPayload(payload: unknown, vendorKey: string): WorkerProbe {
  if (payload === null || typeof payload !== "object") {
    return { reachable: true, ok: true, latencyMs: null, message: null, status: null, vendor: vendorKey, raw: payload };
  }
  const record = payload as Record<string, unknown>;
  // Accept both flat worker payloads and envelope-style ones.
  const inner =
    record.data !== null && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const latencyRaw = inner.latencyMs ?? inner.latency ?? inner.rttMs;
  const statusRaw = typeof inner.status === "string" ? inner.status.toUpperCase() : null;
  const successRaw = inner.ok ?? inner.success ?? inner.connected ?? true;
  return {
    reachable: true,
    ok: Boolean(successRaw),
    latencyMs: typeof latencyRaw === "number" ? Math.round(latencyRaw) : null,
    message: typeof inner.message === "string" ? inner.message : typeof inner.error === "string" ? inner.error : null,
    status: statusRaw && KNOWN_DEVICE_STATUSES.has(statusRaw) ? statusRaw : null,
    vendor: typeof inner.vendor === "string" ? inner.vendor : vendorKey,
    raw: payload,
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("INVALID_BODY", "Request body must be valid JSON", 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("INVALID_BODY", firstIssueMessage(parsed.error), 400);
  }

  // Phase 19-C (audit AUTHZ-001 sweep): reachability probes exercise the
  // data plane — they require the "config.backup" permission (operator +
  // engineer seeded) and are attributed to the session principal (the
  // legacy hardcoded actorName "Admin" is removed).
  let actor: Awaited<ReturnType<typeof requirePermission>>;
  try {
    actor = await requirePermission(request, "config.backup");
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const device = await db.device.findUnique({
    where: { id: parsed.data.deviceId },
    select: {
      id: true,
      hostname: true,
      mgmtIp: true,
      status: true,
      lastSeen: true,
      vendor: { select: { key: true, name: true, adapterKey: true } },
    },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  const correlationId = newJobCorrelationId();
  const vendorKey = device.vendor?.adapterKey ?? device.vendor?.key ?? "generic";

  let probe: WorkerProbe;
  try {
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: workerControlHeaders(),
      body: JSON.stringify({
        vendor: vendorKey,
        host: device.mgmtIp,
        hostname: device.hostname,
        deviceId: device.id,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      probe = {
        reachable: true,
        ok: false,
        latencyMs: null,
        message: `Worker responded with HTTP ${response.status}`,
        status: null,
        vendor: vendorKey,
        raw: null,
      };
    } else {
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      probe = parseWorkerPayload(payload, vendorKey);
    }
  } catch {
    // Worker down / timeout / DNS — graceful degradation, never a 500.
    probe = {
      reachable: false,
      ok: false,
      latencyMs: null,
      message: "Worker service unreachable",
      status: null,
      vendor: vendorKey,
      raw: null,
    };
  }

  // Audit every probe (SUCCESS when the worker answered, FAILURE otherwise).
  await db.auditEvent.create({
    data: {
      actorId: actor.id,
      actorName: actor.name ?? "Unknown user",
      action: "DEVICE_CONNECTION_TESTED",
      resourceType: "Device",
      resourceId: device.id,
      resourceLabel: device.hostname,
      result: probe.reachable && probe.ok ? "SUCCESS" : "FAILURE",
      correlationId,
      afterJson: JSON.stringify({
        workerUrl: WORKER_URL,
        reachable: probe.reachable,
        ok: probe.ok,
        latencyMs: probe.latencyMs,
        reportedStatus: probe.status,
      }),
    },
  });

  // A successful probe refreshes reachability; only trust a status the
  // platform understands, and never overwrite MAINTENANCE/UNMANAGED flags.
  let updatedStatus: string | null = null;
  if (probe.reachable && probe.ok && probe.status && !["MAINTENANCE", "UNMANAGED"].includes(device.status)) {
    await db.device.update({
      where: { id: device.id },
      data: { lastSeen: new Date(), status: probe.status },
    });
    updatedStatus = probe.status;
  } else if (probe.reachable && probe.ok) {
    await db.device.update({
      where: { id: device.id },
      data: { lastSeen: new Date() },
    });
  }

  return ok(
    {
      reachable: probe.reachable,
      ok: probe.ok,
      latencyMs: probe.latencyMs,
      message: probe.message,
      workerStatus: probe.status,
      device: {
        id: device.id,
        hostname: device.hostname,
        status: updatedStatus ?? device.status,
      },
    },
    { correlationId }
  );
}
