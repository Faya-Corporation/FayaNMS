/**
 * Device-driver catalog (Task 7-b) — statically derived from the worker's
 * adapter registry (mini-services/worker/adapters.ts), the same manifests
 * the worker exposes on GET :3030/capabilities. No database involvement:
 * the catalog is recomputed from the registry at import time so a new
 * adapter automatically appears on GET /api/v1/admin/drivers.
 *
 * `modelFlavors` documents the device families each adapter's generator
 * covers (the cisco-ios adapter folds NX-OS in via a platform branch —
 * see the notes string in the registry itself).
 */

import { adapters } from "../../../mini-services/worker/adapters";

const VENDOR_LABELS: Record<string, string> = {
  cisco: "Cisco",
  fortinet: "Fortinet",
  sophos: "Sophos",
  hpe: "HPE",
  juniper: "Juniper Networks",
  palo: "Palo Alto Networks",
  generic: "Generic",
};

const MODEL_FLAVORS: Record<string, string[]> = {
  "cisco-ios": [
    "IOS / IOS-XE routers (ISR, ASR style)",
    "Catalyst 9k / 2960 access switches",
    "NX-OS (N9K spine/leaf — platform branch)",
  ],
  "fortinet-fortios": ["FortiGate NGFW (FortiOS 7.x)"],
  "sophos-sfos": ["Sophos Firewall (SFOS XGS style)"],
  "hpe-aos-cx": ["AOS-CX switches (6300/6400/8325 style)"],
  "juniper-junos": [
    "Juniper SRX series security gateways (SRX345/1500 style)",
    "Juniper EX/QFX switches (ethernet-switching branch)",
  ],
  "palo-panos": [
    "Palo Alto PA-5xxx chassis (PA-5410 style)",
    "Palo Alto PA-400 desktop units (PA-440 style)",
  ],
  generic: ["Unclassified / SNMP-managed nodes (fallback)"],
};

const CAPABILITY_LABELS: Record<string, string> = {
  connect: "Session connect",
  backup_config: "Config fetch (running-config)",
  config_apply: "Config apply (change engine)",
};

export interface DriverCapability {
  key: string;
  label: string;
}

export interface DriverEntry {
  /** Manifest key used by the job engine, e.g. "cisco-ios". */
  adapter: string;
  /** Canonical vendor code (Device.vendor.key). */
  vendor: string;
  vendorLabel: string;
  /** Config flavor produced by the adapter (normalizer input). */
  configFlavor: string;
  capabilities: DriverCapability[];
  modelFlavors: string[];
  notes: string;
}

/**
 * Every adapter is reachable through the worker's /simulate/apply path (the
 * change engine's apply step is flavor-agnostic), so config_apply is part of
 * each entry's capability set alongside the adapter-declared manifest.
 */
export const driverCatalog: DriverEntry[] = adapters.map((adapter) => {
  const capabilityKeys = Array.from(
    new Set([...adapter.capabilities, "config_apply"])
  );
  return {
    adapter: adapter.adapter,
    vendor: adapter.vendor,
    vendorLabel: VENDOR_LABELS[adapter.vendor] ?? adapter.vendor,
    configFlavor: adapter.configFlavor,
    capabilities: capabilityKeys.map((key) => ({
      key,
      label: CAPABILITY_LABELS[key] ?? key,
    })),
    modelFlavors: MODEL_FLAVORS[adapter.adapter] ?? [adapter.adapter],
    notes: adapter.notes,
  };
});
