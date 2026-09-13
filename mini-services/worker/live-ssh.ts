/**
 * FayaNMS worker — LIVE_SSH adapter (Phase 22 slice 1, READ-ONLY).
 *
 * Implements the SAME DeviceAdapter contract as the simulator adapters
 * (connect + fetchConfig, same ConfigResult shape), so the job runner
 * treats simulator and live devices identically downstream (snapshot
 * storage, normalization, diff engine).
 *
 * Honesty note: this slice certifies the TRANSPORT and the IOS command
 * mapping against the in-repo protocol harness (harness/ios-sshd.ts — a
 * REAL SSH server speaking vendor-realistic payloads). Certification
 * against physical hardware (IOS/IOS-XE on real devices) remains open —
 * tracked in the README honest-status block.
 *
 * READ-ONLY DISCIPLINE:
 *   - the transport is exec-only (see ssh-transport.ts);
 *   - the command set is a hardcoded per-flavor allowlist of read-only
 *     "show" commands — there is NO code path in this module that can
 *     mutate device state. apply/restore/rollback stay simulator-only by
 *     design (Phase 23 governs controlled changes for live devices).
 */

import {
  normalizeConfig,
  type ConfigResult,
  type ConnResult,
  type DeviceAdapter,
  type DeviceTarget,
} from "./adapters";
import { sshExecText, sshProbe, type SshCredentials } from "./ssh-transport";

export class LiveAdapterError extends Error {
  constructor(
    public readonly code: "FLAVOR_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "LiveAdapterError";
  }
}

interface LiveFlavor {
  /** manifest key surfaced in results/capabilities */
  adapter: string;
  /** flavor key — MATCHES the simulator flavor so diff/normalization stays uniform */
  configFlavor: string;
  /** the one and only config-collection command (read-only allowlist) */
  commandConfig: string;
  notes: string;
}

/** Certified LIVE_SSH flavors. Slice 1: Cisco IOS/IOS-XE classic CLI. */
export const LIVE_SSH_FLAVORS: Record<string, LiveFlavor> = {
  cisco: {
    adapter: "cisco-ios-live",
    configFlavor: "cisco-ios",
    commandConfig: "show running-config",
    notes:
      "Cisco IOS/IOS-XE over real SSH exec (show running-config); certified against the in-repo IOS protocol harness.",
  },
};

/** Pick the certified flavor for a vendor code — typed failure otherwise. */
export function resolveLiveSshFlavor(vendor: string): LiveFlavor {
  const key = (vendor ?? "").trim().toLowerCase();
  const flavor = LIVE_SSH_FLAVORS[key];
  if (!flavor) {
    throw new LiveAdapterError(
      "FLAVOR_UNSUPPORTED",
      `No LIVE_SSH flavor is certified for vendor "${vendor}" yet (certified: ${Object.keys(
        LIVE_SSH_FLAVORS,
      ).join(", ")}) — Phase 22 adds flavors incrementally`,
    );
  }
  return flavor;
}

/**
 * Build the live adapter. Credentials are assembled ONCE by the adapter
 * router (host from the device target, secret resolved worker-side from
 * the vault) and baked into the closure — this module never receives or
 * returns secret material, and the SshCredentials object never leaves it.
 */
export function createLiveSshAdapter(vendor: string, creds: SshCredentials): DeviceAdapter {
  const flavor = resolveLiveSshFlavor(vendor);
  void creds; // consumed via the closures below
  return {
    adapter: flavor.adapter,
    vendor: vendor.trim().toLowerCase(),
    // Read-only capability set on purpose: no apply/restore/rollback for
    // live devices in Phase 22 slice 1 (Phase 23 scope).
    capabilities: ["connect", "backup_config"],
    configFlavor: flavor.configFlavor,
    notes: `LIVE (read-only SSH exec) — ${flavor.notes}`,
    connect: async (_target: DeviceTarget): Promise<ConnResult> => {
      const probe = await sshProbe(creds, 8000);
      return {
        latencyMs: probe.latencyMs,
        banner: probe.banner,
        negotiated: probe.negotiated,
      };
    },
    fetchConfig: async (_target: DeviceTarget): Promise<ConfigResult> => {
      const raw = await sshExecText(creds, flavor.commandConfig, 20000);
      const rawText = raw.endsWith("\n") ? raw : `${raw}\n`;
      return { rawText, normalizedText: normalizeConfig(rawText) };
    },
  };
}
