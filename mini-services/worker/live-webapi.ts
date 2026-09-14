/**
 * FayaNMS worker — LIVE WebAPI adapter (CERT-006, READ-ONLY).
 *
 * Same DeviceAdapter contract as the simulator and LIVE_SSH adapters
 * (connect + fetchConfig, same ConfigResult shape) so the runner treats
 * all three planes identically downstream.
 *
 * Certified flavors (CERT-006):
 *   sfos (sophos) — Sophos SFOS over the device WebAPI (TLS, JSON
 *     envelope): GetAuthStatus probe + GetConfig collection. The SFOS SSH
 *     CLI has no read-only full-config dump, so this is the DESIGNED
 *     transport for the vendor (see live-ssh.ts's deliberate omission).
 *
 * Honesty note: the flavor certifies the TRANSPORT and its vendor envelope
 * mapping against the in-repo harness (harness/sfos-webapi.ts — a REAL
 * loopback HTTPS server speaking the SFOS WebAPI shape). Certification
 * against physical hardware remains open per-flavor — tracked in the
 * README honest-status block.
 *
 * READ-ONLY DISCIPLINE: the transport (webapi-transport.ts) carries a
 * hardcoded two-action read-only allowlist; there is NO code path in this
 * module that can mutate device state, and apply/restore/rollback stay
 * simulator-only by design.
 *
 * TRUST MODEL: TLS certificate verification is always on (system CA store
 * plus the optional worker-pinned FAYANMS_WEBAPI_CA_PEM). This is the
 * HTTPS analog of SAFE-001's SSH host-key pinning — there is no
 * verification bypass anywhere, and a TLS failure happens BEFORE the
 * api-key is transmitted. Because trust is channel-level, WebAPI flavors
 * do NOT participate in the SSH host-key enrollment pipeline (no SSH
 * handshake exists) — the adapter router routes sophos here INSTEAD of the
 * SSH pin gate.
 */

import {
  normalizeConfig,
  type ConfigResult,
  type ConnResult,
  type DeviceAdapter,
  type DeviceTarget,
} from "./adapters";
import {
  webApiFetchConfigText,
  webApiProbe,
  type WebApiCredentials,
} from "./webapi-transport";

export class LiveWebApiError extends Error {
  constructor(
    public readonly code: "FLAVOR_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "LiveWebApiError";
  }
}

interface LiveWebApiFlavor {
  /** manifest key surfaced in results/capabilities */
  adapter: string;
  /** flavor key — MATCHES the simulator flavor so diff/normalization stays uniform */
  configFlavor: string;
  notes: string;
}

export const LIVE_WEBAPI_FLAVORS: Record<string, LiveWebApiFlavor> = {
  sophos: {
    adapter: "sophos-sfos-webapi",
    configFlavor: "sfos",
    notes:
      "Sophos SFOS over the device WebAPI (TLS; GetAuthStatus probe + GetConfig collection); certified against the in-repo SFOS WebAPI harness.",
  },
};

/** Pick the certified flavor for a vendor code — typed failure otherwise. */
export function resolveLiveWebApiFlavor(vendor: string): LiveWebApiFlavor {
  const key = (vendor ?? "").trim().toLowerCase();
  const flavor = LIVE_WEBAPI_FLAVORS[key];
  if (!flavor) {
    throw new LiveWebApiError(
      "FLAVOR_UNSUPPORTED",
      `No WebAPI flavor is certified for vendor "${vendor}" yet (certified: ${Object.keys(
        LIVE_WEBAPI_FLAVORS,
      ).join(", ")})`,
    );
  }
  return flavor;
}

/**
 * Build the live WebAPI adapter. The api-key credential is assembled ONCE
 * by the adapter router (host/port from the device target, key resolved
 * worker-side from the vault) and baked into the closure — this module
 * never receives or returns secret material beyond that closure.
 */
export function createLiveWebApiAdapter(vendor: string, creds: WebApiCredentials): DeviceAdapter {
  const flavor = resolveLiveWebApiFlavor(vendor);
  return {
    adapter: flavor.adapter,
    vendor: vendor.trim().toLowerCase(),
    // Read-only capability set on purpose: no apply/restore/rollback.
    capabilities: ["connect", "backup_config"],
    configFlavor: flavor.configFlavor,
    notes: `LIVE (read-only WebAPI over TLS) — ${flavor.notes}`,
    connect: async (_target: DeviceTarget): Promise<ConnResult> => {
      const probe = await webApiProbe(creds, 8000);
      const identity = [probe.model, probe.firmware].filter(Boolean).join(" · ");
      return {
        latencyMs: probe.latencyMs,
        banner: identity || "SFOS WebAPI (TLS)",
        negotiated: probe.negotiated ?? "TLS",
      };
    },
    fetchConfig: async (_target: DeviceTarget): Promise<ConfigResult> => {
      const rawText = await webApiFetchConfigText(creds, 20000);
      return { rawText, normalizedText: normalizeConfig(rawText) };
    },
  };
}
