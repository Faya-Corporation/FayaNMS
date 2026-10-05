import { db } from "@/lib/db";
import { fail, firstIssueMessage, newJobCorrelationId, ok } from "../../_lib/api";
import { authErrorToFail, requirePermission, requireSiteScope } from "@/lib/auth/session";
import { getHostKeyPin } from "@/lib/ssh/host-keys";
import { workerControlHeaders } from "@/lib/worker/control-client";
import { WORKER_BASE_URL } from "@/lib/worker/worker-url";
import { z } from "zod";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/devices/test-connection — body: { deviceId }.
 *
 * Probes are sent to `${WORKER_BASE_URL}/simulate/connect` (runbook T5 —
 * env-configurable, default http://localhost:3030). The worker
 * may not be running (2-b lands in parallel) — the route is defensive:
 *   - any fetch/parse failure answers 200 with { reachable: false } so the
 *     UI can show a graceful "Worker service unreachable" message instead
 *     of an error state;
 *   - a reachable worker updates the device lastSeen (and status when the
 *     worker reports a known device status) and the result is audited.
 *
 * F-031 (site scoping — device-domain wave 7): MUTATION plane — a probe
 * opens a live data-plane connection and can WRITE device state (lastSeen
 * / status refresh), so after resolving the device FROM THE REQUEST BODY
 * (`deviceId`) the route gates the DEVICE'S site through requireSiteScope →
 * 403 SITE_SCOPE_FORBIDDEN (the documented mutation contract — no 404 shape
 * here), BEFORE any probe fetch or device write. The existing missing-device
 * envelope (404 DEVICE_NOT_FOUND) is preserved unchanged. A site-less
 * device is an unscoped resource and bypasses the gate
 * (assertSiteScope(null) rule). Wildcard sessions are byte-unchanged.
 * authorization-matrix.md §5.1.
 */

const WORKER_URL = `${WORKER_BASE_URL}/simulate/connect`;

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
      site: { select: { code: true } },
      vendor: { select: { key: true, name: true, adapterKey: true } },
      // Phase 22 slice 1 — data-plane routing + credential REFERENCE fields
      // (secretRef is a vault pointer; the secret never travels — the worker
      // resolves it worker-side at connect time).
      dataSource: true,
      credentialProfile: { select: { username: true, port: true, secretRef: true } },
    },
  });
  if (!device) {
    return fail("DEVICE_NOT_FOUND", "The requested device does not exist", 404);
  }

  // F-031 wave-7 (mutation plane): the DEVICE'S site must be inside the
  // session's scope before any probe is sent or device state is written —
  // requireSiteScope answers 403 SITE_SCOPE_FORBIDDEN (no 404 shape on the
  // mutation plane; a site-less device bypasses per the documented
  // unscoped-resource rule).
  try {
    await requireSiteScope(request, device.site?.code ?? null);
  } catch (error) {
    const authFail = authErrorToFail(error);
    if (!authFail) throw error;
    return authFail;
  }

  const correlationId = newJobCorrelationId();
  const vendorKey = device.vendor?.adapterKey ?? device.vendor?.key ?? "generic";
  const isLive = (device.dataSource ?? "SIMULATOR").trim().toUpperCase() === "LIVE_SSH";
  // The live flavor registry keys on the VENDOR CODE (cisco | fortinet | hpe…),
  // while simulator adapters accept either the adapter key or the vendor code.
  // Probes therefore carry the vendor code for LIVE_SSH devices
  // (adapterKey would surface FLAVOR_UNSUPPORTED — caught in slice-2 browser QA).
  const probeVendor = isLive ? (device.vendor?.key ?? "generic") : vendorKey;

  let probe: WorkerProbe;
  try {
    // SAFE-001 — the enrolled host-key pin rides on the probe; an unenrolled
    // live device is refused by the worker (SSH_HOSTKEY_UNENROLLED) — the
    // UI points the operator at the host-key enrollment card.
    const sshHostKeyPin =
      isLive && device.credentialProfile && device.mgmtIp
        ? await getHostKeyPin(device.mgmtIp, device.credentialProfile.port)
        : null;
    const response = await fetch(WORKER_URL, {
      method: "POST",
      headers: workerControlHeaders(),
      body: JSON.stringify({
        vendor: probeVendor,
        host: device.mgmtIp,
        hostname: device.hostname,
        deviceId: device.id,
        // Phase 22 slice 1: LIVE_SSH devices probe over REAL SSH (read-only);
        // SIMULATOR devices keep the existing in-memory probe behavior.
        dataSource: device.dataSource,
        credential: isLive && device.credentialProfile
          ? {
              username: device.credentialProfile.username,
              port: device.credentialProfile.port,
              secretRef: device.credentialProfile.secretRef,
            }
          : undefined,
        sshHostKeyPin: sshHostKeyPin ?? undefined,
      }),
      // A live SSH probe (handshake + auth) can legitimately take longer
      // than the in-memory simulator answer.
      signal: AbortSignal.timeout(isLive ? 15000 : 8000),
    });
    if (!response.ok) {
      // SAFE-001: surface the worker's actionable rejection body (e.g.
      // "SSH_HOSTKEY_UNENROLLED: … enroll the host key") instead of a bare
      // HTTP status — the operator must be able to act on it.
      let rejectionMessage = `Worker responded with HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { error?: string } | null;
        if (body && typeof body.error === "string" && body.error.trim()) {
          rejectionMessage = body.error.trim();
        }
      } catch {
        /* keep the generic status message */
      }
      probe = {
        reachable: true,
        ok: false,
        latencyMs: null,
        message: rejectionMessage,
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
        dataSource: device.dataSource ?? "SIMULATOR",
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
