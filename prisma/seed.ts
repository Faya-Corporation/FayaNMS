/**
 * FayaNMS — demo seed (idempotent).
 *
 * Run with:  bun prisma/seed.ts
 *
 * Strategy:
 *  - Wipes every table first (FK-safe order), then inserts a deterministic demo
 *    dataset built with loops + a seeded PRNG (mulberry32) — re-runs produce the
 *    same world, never duplicates.
 *  - SQLite-safe: no Prisma enums / Json columns here either; JSON payloads are
 *    serialized into the `*Json` String columns defined in schema.prisma.
 *  - Config snapshots carry vendor-authentic running-config text (Cisco IOS XE /
 *    NX-OS, FortiOS, Sophos SFOS CLI, HPE AOS-CX) with a per-device version
 *    history and one explicit drift story (HQ-Access-SW-01).
 */

import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";

const db = new PrismaClient();

/* ────────────────────────────── helpers ────────────────────────────── */

const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - Math.round(minutes * 60_000));
const ahead = (minutes: number) => new Date(NOW + Math.round(minutes * 60_000));

/** Deterministic PRNG so re-seeding produces the same demo world. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0xfa7a);
const ri = (min: number, max: number) => Math.floor(rnd() * (max - min + 1)) + min;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const sizeOf = (s: string) => Buffer.byteLength(s, "utf8");
const normalizeConfig = (raw: string) =>
  raw
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => {
      const t = l.trim();
      return t.length > 0 && !t.startsWith("!") && !t.startsWith("#");
    })
    .join("\n");

function p95(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

function macFor(seed: string, i: number): string {
  const s = `${seed}:${i}`;
  let h = 0;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) >>> 0;
  const oct = (n: number) => ((h >>> (n * 3)) ^ (h >>> (n + 5)) ^ (i * (n + 3))) & 0xff;
  return Array.from({ length: 6 }, (_, n) => (oct(n) || 0x02).toString(16).padStart(2, "0")).join(":");
}

const jobCorr = (i: number) =>
  "JOB-" + ((i * 7919 + 0x5f3a2b) % 0xffffff).toString(16).toUpperCase().padStart(6, "0");

/* ────────────────────────────── reference data ────────────────────────────── */

const VENDORS = [
  { id: "ven-cisco", key: "cisco", name: "Cisco Systems", adapterKey: "cisco-ios" },
  { id: "ven-fortinet", key: "fortinet", name: "Fortinet", adapterKey: "fortigate" },
  { id: "ven-sophos", key: "sophos", name: "Sophos", adapterKey: "sophos-xgs" },
  { id: "ven-hpe", key: "hpe", name: "HPE Networking", adapterKey: "hpe-aos-cx" },
  { id: "ven-generic", key: "generic", name: "Generic (SNMP)", adapterKey: "generic-snmp" },
];

const ORG = { id: "org-faya", name: "FAYA Telecom" };

const SITES = [
  { id: "site-hq-san", name: "HQ — Sanaa", code: "HQ-SAN", region: "Sanaa", address: "Hadda Street, Building 12, Sanaa" },
  { id: "site-dc-adn", name: "Data Center — Aden", code: "DC-ADN", region: "Aden", address: "Khormaksar Tech Park, Hall B, Aden" },
  { id: "site-br1-hod", name: "Branch — Hodeidah", code: "BR1-HOD", region: "Al Hudaydah", address: "Airport Road, Compound 3, Hodeidah" },
  { id: "site-br2-muk", name: "Branch — Mukalla", code: "BR2-MUK", region: "Al Mukalla", address: "Dawood Street, Floor 2, Mukalla" },
];

const USERS = [
  { id: "usr-admin", email: "admin@faya.local", name: "Amal Al-Sabri", role: "admin" },
  { id: "usr-noc1", email: "noc1@faya.local", name: "Yousef Ghalib", role: "operator" },
  { id: "usr-engineer1", email: "engineer1@faya.local", name: "Mariam Al-Hakimi", role: "engineer" },
  { id: "usr-auditor1", email: "auditor1@faya.local", name: "Tariq Bashiri", role: "auditor" },
  { id: "usr-manager1", email: "manager1@faya.local", name: "Salma Al-Attar", role: "manager" },
];

const ROLES = [
  { id: "role-admin", name: "admin", description: "Full platform administration", permissionsJson: JSON.stringify(["*"]) },
  {
    id: "role-operator",
    name: "operator",
    description: "NOC operator — run operational actions, ack alerts",
    permissionsJson: JSON.stringify(["device.read", "config.read", "config.backup", "alert.ack", "incident.write", "job.run"]),
  },
  {
    id: "role-engineer",
    name: "engineer",
    description: "Network engineer — device + config authoring",
    permissionsJson: JSON.stringify(["device.read", "device.write", "config.read", "config.write", "config.backup", "change.create", "job.run"]),
  },
  {
    id: "role-manager",
    name: "manager",
    description: "Service manager — approvals and reporting",
    permissionsJson: JSON.stringify(["device.read", "config.read", "change.approve", "report.read"]),
  },
  {
    id: "role-auditor",
    name: "auditor",
    description: "Read-only + audit export (secrets masked)",
    permissionsJson: JSON.stringify(["*.read", "audit.export"]),
  },
  { id: "role-viewer", name: "viewer", description: "Read-only dashboard access", permissionsJson: JSON.stringify(["*.read"]) },
];

const CREDENTIALS = [
  { id: "cred-ssh-pass", name: "Network Admin — SSH password", type: "SSH_PASSWORD", username: "netadmin", secretRef: "vault://ssh/network-admin", port: 22, notes: "Primary CLI account; rotated quarterly." },
  { id: "cred-ssh-key", name: "Config Backup — SSH key", type: "SSH_KEY", username: "cfgbackup", secretRef: "vault://ssh/config-backup", port: 22, notes: "Dedicated backup key, restricted shell." },
  { id: "cred-fgt-api", name: "FortiGate API token", type: "API_TOKEN", username: "api-admin", secretRef: "vault://api/fortigate-token", port: 443, notes: "REST API token for FortiGate adapters." },
];

const BACKUP_POLICIES = [
  { id: "bp-daily", name: "Daily Full Fleet 02:00", cronExpr: "0 2 * * *", retentionDays: 90, isActive: true, scopeJson: JSON.stringify({ siteCodes: ["*"], excludeStatuses: ["UNMANAGED"] }) },
  { id: "bp-critical", name: "Critical Devices 6h", cronExpr: "0 */6 * * *", retentionDays: 180, isActive: true, scopeJson: JSON.stringify({ criticality: ["CRITICAL"], excludeStatuses: ["OFFLINE", "UNMANAGED"] }) },
];

const SETTINGS = [
  { key: "system.name", valueJson: JSON.stringify("FayaNMS") },
  { key: "backup.retention.days", valueJson: JSON.stringify(90) },
  { key: "backup.encryption", valueJson: JSON.stringify("AES-256-GCM") },
  { key: "drift.check.intervalMinutes", valueJson: JSON.stringify(15) },
  { key: "alert.suppression.maintenanceWindows", valueJson: JSON.stringify(true) },
  { key: "metrics.rollup.retention.days", valueJson: JSON.stringify(90) },
];

const REPORT_SCHEDULES = [
  { id: "rs-monthly-availability", name: "Monthly Availability Report", reportType: "AVAILABILITY", frequency: "MONTHLY", format: "PDF", recipientsJson: JSON.stringify(["manager1@faya.local", "admin@faya.local"]), isActive: true, lastRunAt: ago(14400) },
  { id: "rs-weekly-backup", name: "Weekly Backup Compliance Export", reportType: "BACKUP_COMPLIANCE", frequency: "WEEKLY", format: "XLSX", recipientsJson: JSON.stringify(["admin@faya.local", "noc1@faya.local"]), isActive: true, lastRunAt: ago(2880) },
];

/* ────────────────────────────── device fleet ────────────────────────────── */

interface DeviceSpec {
  id: string;
  hostname: string;
  vendorId: string;
  model: string;
  platform: string;
  firmware: string;
  serial: string;
  role: string;
  siteId: string;
  mgmtIp: string;
  status: string;
  criticality: string;
  healthScore: number;
  uptimeHours: number | null;
  lastSeenMin: number;
  lastBackupMin: number | null;
  lastConfigChangeMin: number | null;
  backupCompliance: string;
  tags: string[];
  notes?: string;
  cpuBase: number;
  cpuAmp: number;
  utilBase: number;
}

const D: DeviceSpec[] = [
  { id: "dev-hq-core-rtr-01", hostname: "HQ-Core-RTR-01", vendorId: "ven-cisco", model: "ISR4451-X", platform: "IOS XE", firmware: "17.06.04", serial: "FJC2245A0AB", role: "CORE_ROUTER", siteId: "site-hq-san", mgmtIp: "10.20.255.1", status: "ONLINE", criticality: "CRITICAL", healthScore: 96, uptimeHours: 24 * 47, lastSeenMin: 2, lastBackupMin: 310, lastConfigChangeMin: 12950, backupCompliance: "COMPLIANT", tags: ["core", "bgp", "hsrp"], cpuBase: 26, cpuAmp: 14, utilBase: 42 },
  { id: "dev-hq-core-rtr-02", hostname: "HQ-Core-RTR-02", vendorId: "ven-cisco", model: "ISR4451-X", platform: "IOS XE", firmware: "17.06.04", serial: "FJC2245A0CD", role: "CORE_ROUTER", siteId: "site-hq-san", mgmtIp: "10.20.255.2", status: "ONLINE", criticality: "CRITICAL", healthScore: 95, uptimeHours: 24 * 47, lastSeenMin: 3, lastBackupMin: 312, lastConfigChangeMin: 20160, backupCompliance: "COMPLIANT", tags: ["core", "bgp", "hsrp"], cpuBase: 27, cpuAmp: 14, utilBase: 39 },
  { id: "dev-hq-core-sw-01", hostname: "HQ-Core-SW-01", vendorId: "ven-cisco", model: "C9500-48Y4C", platform: "IOS XE", firmware: "17.09.03a", serial: "FCW2233A1XY", role: "CORE_SWITCH", siteId: "site-hq-san", mgmtIp: "10.20.255.3", status: "ONLINE", criticality: "CRITICAL", healthScore: 98, uptimeHours: 24 * 32, lastSeenMin: 1, lastBackupMin: 305, lastConfigChangeMin: 4320, backupCompliance: "COMPLIANT", tags: ["core", "stack", "qos"], cpuBase: 22, cpuAmp: 12, utilBase: 55 },
  { id: "dev-hq-core-sw-02", hostname: "HQ-Core-SW-02", vendorId: "ven-cisco", model: "C9500-48Y4C", platform: "IOS XE", firmware: "17.09.03a", serial: "FCW2233A2XY", role: "CORE_SWITCH", siteId: "site-hq-san", mgmtIp: "10.20.255.4", status: "ONLINE", criticality: "CRITICAL", healthScore: 97, uptimeHours: 24 * 32, lastSeenMin: 1, lastBackupMin: 308, lastConfigChangeMin: 14400, backupCompliance: "COMPLIANT", tags: ["core", "stack", "qos"], cpuBase: 21, cpuAmp: 12, utilBase: 51 },
  { id: "dev-hq-wan-fw-01", hostname: "HQ-WAN-FW-01", vendorId: "ven-fortinet", model: "FortiGate 600F", platform: "FortiOS", firmware: "7.4.3", serial: "FG6F11TMI2300411", role: "FIREWALL", siteId: "site-hq-san", mgmtIp: "10.20.255.5", status: "ONLINE", criticality: "CRITICAL", healthScore: 92, uptimeHours: 24 * 15, lastSeenMin: 2, lastBackupMin: 315, lastConfigChangeMin: 4320, backupCompliance: "COMPLIANT", tags: ["firewall", "perimeter", "ha"], cpuBase: 46, cpuAmp: 16, utilBase: 48 },
  { id: "dev-hq-wan-fw-02", hostname: "HQ-WAN-FW-02", vendorId: "ven-fortinet", model: "FortiGate 600F", platform: "FortiOS", firmware: "7.4.3", serial: "FG6F11TMI2300412", role: "FIREWALL", siteId: "site-hq-san", mgmtIp: "10.20.255.6", status: "ONLINE", criticality: "HIGH", healthScore: 91, uptimeHours: 24 * 15, lastSeenMin: 2, lastBackupMin: 318, lastConfigChangeMin: 4320, backupCompliance: "COMPLIANT", tags: ["firewall", "perimeter", "ha"], cpuBase: 44, cpuAmp: 16, utilBase: 44 },
  { id: "dev-hq-edge-rtr-01", hostname: "HQ-Edge-RTR-01", vendorId: "ven-cisco", model: "C8300-2N2S-4T2X", platform: "IOS XE SD-WAN", firmware: "17.09.03a", serial: "FGL2416A0KQ", role: "EDGE_ROUTER", siteId: "site-hq-san", mgmtIp: "10.20.255.7", status: "ONLINE", criticality: "HIGH", healthScore: 61, uptimeHours: 24 * 12, lastSeenMin: 2, lastBackupMin: 320, lastConfigChangeMin: 11520, backupCompliance: "COMPLIANT", tags: ["edge", "sdwan", "bgp"], notes: "SEV1 active: BGP peer to ISP-A down; traffic rerouted via ISP-B overlay.", cpuBase: 33, cpuAmp: 18, utilBase: 60 },
  { id: "dev-hq-wlc-01", hostname: "HQ-WLC-01", vendorId: "ven-cisco", model: "C9800-40-K9", platform: "IOS XE", firmware: "17.09.03a", serial: "JJH2440A0WL", role: "WIRELESS_CONTROLLER", siteId: "site-hq-san", mgmtIp: "10.20.255.8", status: "ONLINE", criticality: "HIGH", healthScore: 88, uptimeHours: 24 * 9, lastSeenMin: 4, lastBackupMin: 9100, lastConfigChangeMin: 12960, backupCompliance: "OVERDUE", tags: ["wireless", "wlc"], notes: "Last backup 6+ days ago — policy exception pending.", cpuBase: 55, cpuAmp: 15, utilBase: 30 },
  { id: "dev-hq-access-sw-01", hostname: "HQ-Access-SW-01", vendorId: "ven-hpe", model: "6300M 48G (JL658A)", platform: "AOS-CX", firmware: "10.10.1070", serial: "CN23K7Q04B", role: "ACCESS_SWITCH", siteId: "site-hq-san", mgmtIp: "10.20.255.9", status: "ONLINE", criticality: "MEDIUM", healthScore: 90, uptimeHours: 24 * 6, lastSeenMin: 3, lastBackupMin: 1435, lastConfigChangeMin: 1440, backupCompliance: "COMPLIANT", tags: ["access", "poe", "drift"], notes: "Open drift records vs baseline v3 (VLAN 55 + interface description).", cpuBase: 19, cpuAmp: 10, utilBase: 24 },
  { id: "dev-hq-access-sw-02", hostname: "HQ-Access-SW-02", vendorId: "ven-hpe", model: "6300M 48G (JL658A)", platform: "AOS-CX", firmware: "10.10.1070", serial: "CN23K7Q05B", role: "ACCESS_SWITCH", siteId: "site-hq-san", mgmtIp: "10.20.255.10", status: "ONLINE", criticality: "MEDIUM", healthScore: 97, uptimeHours: 24 * 5, lastSeenMin: 3, lastBackupMin: 322, lastConfigChangeMin: 10200, backupCompliance: "COMPLIANT", tags: ["access", "poe"], cpuBase: 18, cpuAmp: 10, utilBase: 22 },
  { id: "dev-hq-idf-sw-01", hostname: "HQ-IDF-SW-01", vendorId: "ven-cisco", model: "C9200L-48P-4X", platform: "IOS XE", firmware: "17.06.04", serial: "JAE2510A0ID", role: "ACCESS_SWITCH", siteId: "site-hq-san", mgmtIp: "10.20.255.11", status: "OFFLINE", criticality: "LOW", healthScore: 34, uptimeHours: 24 * 214, lastSeenMin: 1560, lastBackupMin: 4 * 1440, lastConfigChangeMin: 20160, backupCompliance: "FAILED", tags: ["access", "idf"], notes: "IDF closet power maintenance — device unreachable; nightly backups failing (INC-2026-00103).", cpuBase: 20, cpuAmp: 10, utilBase: 15 },
  { id: "dev-dc-core-rtr-01", hostname: "DC-Core-RTR-01", vendorId: "ven-cisco", model: "ASR1001-X", platform: "IOS XE", firmware: "17.06.05", serial: "SVC24A70AR1", role: "CORE_ROUTER", siteId: "site-dc-adn", mgmtIp: "10.30.255.1", status: "ONLINE", criticality: "CRITICAL", healthScore: 97, uptimeHours: 24 * 61, lastSeenMin: 2, lastBackupMin: 305, lastConfigChangeMin: 5760, backupCompliance: "COMPLIANT", tags: ["core", "bgp", "dc"], cpuBase: 24, cpuAmp: 13, utilBase: 46 },
  { id: "dev-dc-core-sw-01", hostname: "DC-Core-SW-01", vendorId: "ven-cisco", model: "N9K-C93180YC-EX", platform: "NX-OS", firmware: "9.3(10)", serial: "FDO24180A5N", role: "CORE_SWITCH", siteId: "site-dc-adn", mgmtIp: "10.30.255.2", status: "ONLINE", criticality: "CRITICAL", healthScore: 96, uptimeHours: 24 * 44, lastSeenMin: 2, lastBackupMin: 310, lastConfigChangeMin: 21600, backupCompliance: "COMPLIANT", tags: ["core", "dc", "vxlan"], cpuBase: 26, cpuAmp: 12, utilBase: 52 },
  { id: "dev-dc-fw-01", hostname: "DC-FW-01", vendorId: "ven-fortinet", model: "FortiGate 601E", platform: "FortiOS", firmware: "7.2.7", serial: "FG6E11TXI1900981", role: "FIREWALL", siteId: "site-dc-adn", mgmtIp: "10.30.255.3", status: "ONLINE", criticality: "CRITICAL", healthScore: 90, uptimeHours: 24 * 22, lastSeenMin: 2, lastBackupMin: 320, lastConfigChangeMin: 14400, backupCompliance: "COMPLIANT", tags: ["firewall", "dc"], cpuBase: 49, cpuAmp: 14, utilBase: 47 },
  { id: "dev-dc-edge-rtr-01", hostname: "DC-Edge-RTR-01", vendorId: "ven-cisco", model: "ASR920-24SZ-IM", platform: "IOS XE", firmware: "17.07.01", serial: "FIM2430A0E9", role: "EDGE_ROUTER", siteId: "site-dc-adn", mgmtIp: "10.30.255.4", status: "ONLINE", criticality: "HIGH", healthScore: 93, uptimeHours: 24 * 28, lastSeenMin: 3, lastBackupMin: 315, lastConfigChangeMin: 20000, backupCompliance: "COMPLIANT", tags: ["edge", "bgp", "mpls"], cpuBase: 29, cpuAmp: 13, utilBase: 44 },
  { id: "dev-dc-srv-tor-01", hostname: "DC-SRV-TOR-01", vendorId: "ven-hpe", model: "6400 48G (JL724A)", platform: "AOS-CX", firmware: "10.12.0005", serial: "CN24P6Q01T", role: "TOP_OF_RACK", siteId: "site-dc-adn", mgmtIp: "10.30.255.5", status: "ONLINE", criticality: "HIGH", healthScore: 98, uptimeHours: 24 * 39, lastSeenMin: 2, lastBackupMin: 305, lastConfigChangeMin: 28800, backupCompliance: "COMPLIANT", tags: ["tor", "dc"], cpuBase: 20, cpuAmp: 9, utilBase: 38 },
  { id: "dev-dc-srv-tor-02", hostname: "DC-SRV-TOR-02", vendorId: "ven-hpe", model: "6400 48G (JL724A)", platform: "AOS-CX", firmware: "10.12.0005", serial: "CN24P6Q02T", role: "TOP_OF_RACK", siteId: "site-dc-adn", mgmtIp: "10.30.255.6", status: "ONLINE", criticality: "HIGH", healthScore: 97, uptimeHours: 24 * 39, lastSeenMin: 2, lastBackupMin: 307, lastConfigChangeMin: 28800, backupCompliance: "COMPLIANT", tags: ["tor", "dc"], cpuBase: 19, cpuAmp: 9, utilBase: 36 },
  { id: "dev-dc-dmz-fw-01", hostname: "DC-DMZ-FW-01", vendorId: "ven-sophos", model: "XGS 3300", platform: "SFOS", firmware: "19.5 MR1", serial: "SOP19X3300A21", role: "FIREWALL", siteId: "site-dc-adn", mgmtIp: "10.30.255.7", status: "DEGRADED", criticality: "HIGH", healthScore: 61, uptimeHours: 24 * 8, lastSeenMin: 2, lastBackupMin: 300, lastConfigChangeMin: 2880, backupCompliance: "COMPLIANT", tags: ["firewall", "dmz", "ha"], notes: "HA secondary active after fiber maintenance; HA assistant sync degraded (INC-2026-00102).", cpuBase: 84, cpuAmp: 8, utilBase: 58 },
  { id: "dev-br1-edge-rtr-01", hostname: "BR1-Edge-RTR-01", vendorId: "ven-cisco", model: "ISR4331", platform: "IOS XE", firmware: "17.09.04a", serial: "FGL2433A0B7", role: "BRANCH_ROUTER", siteId: "site-br1-hod", mgmtIp: "10.40.255.1", status: "ONLINE", criticality: "HIGH", healthScore: 91, uptimeHours: 24 * 18, lastSeenMin: 3, lastBackupMin: 330, lastConfigChangeMin: 17280, backupCompliance: "COMPLIANT", tags: ["branch", "sdwan"], cpuBase: 34, cpuAmp: 15, utilBase: 35 },
  { id: "dev-br1-fw-01", hostname: "BR1-FW-01", vendorId: "ven-sophos", model: "XGS 2300", platform: "SFOS", firmware: "19.5 MR1", serial: "SOP19X2300B44", role: "FIREWALL", siteId: "site-br1-hod", mgmtIp: "10.40.255.2", status: "ONLINE", criticality: "HIGH", healthScore: 89, uptimeHours: 24 * 11, lastSeenMin: 3, lastBackupMin: 335, lastConfigChangeMin: 15840, backupCompliance: "COMPLIANT", tags: ["firewall", "branch"], cpuBase: 44, cpuAmp: 14, utilBase: 33 },
  { id: "dev-br1-access-sw-01", hostname: "BR1-Access-SW-01", vendorId: "ven-cisco", model: "WS-C2960X-48TS-L", platform: "IOS", firmware: "15.2(7)E3", serial: "FOC2350X0AB", role: "ACCESS_SWITCH", siteId: "site-br1-hod", mgmtIp: "10.40.255.3", status: "ONLINE", criticality: "MEDIUM", healthScore: 76, uptimeHours: 24 * 5, lastSeenMin: 4, lastBackupMin: 400, lastConfigChangeMin: 390, backupCompliance: "COMPLIANT", tags: ["access", "eol-soon"], notes: "Aging platform — sustained high CPU acknowledged; upgrade re-scheduled after CHG-2026-00410 rollback.", cpuBase: 62, cpuAmp: 18, utilBase: 28 },
  { id: "dev-br1-access-sw-02", hostname: "BR1-Access-SW-02", vendorId: "ven-hpe", model: "6100 48G (JL680A)", platform: "AOS-CX", firmware: "10.10.1070", serial: "CN25F8Q06H", role: "ACCESS_SWITCH", siteId: "site-br1-hod", mgmtIp: "10.40.255.4", status: "ONLINE", criticality: "MEDIUM", healthScore: 95, uptimeHours: 24 * 7, lastSeenMin: 4, lastBackupMin: 340, lastConfigChangeMin: 23000, backupCompliance: "COMPLIANT", tags: ["access", "poe"], cpuBase: 17, cpuAmp: 9, utilBase: 21 },
  { id: "dev-br2-edge-rtr-01", hostname: "BR2-Edge-RTR-01", vendorId: "ven-cisco", model: "ISR4331", platform: "IOS XE", firmware: "17.09.04a", serial: "FGL2433A0C9", role: "BRANCH_ROUTER", siteId: "site-br2-muk", mgmtIp: "10.50.255.1", status: "ONLINE", criticality: "HIGH", healthScore: 92, uptimeHours: 24 * 14, lastSeenMin: 3, lastBackupMin: 328, lastConfigChangeMin: 19000, backupCompliance: "COMPLIANT", tags: ["branch", "sdwan"], cpuBase: 33, cpuAmp: 15, utilBase: 37 },
  { id: "dev-br2-fw-01", hostname: "BR2-FW-01", vendorId: "ven-sophos", model: "XGS 2300", platform: "SFOS", firmware: "19.5 MR1", serial: "SOP19X2300C51", role: "FIREWALL", siteId: "site-br2-muk", mgmtIp: "10.50.255.2", status: "MAINTENANCE", criticality: "HIGH", healthScore: 80, uptimeHours: 24 * 3, lastSeenMin: 6, lastBackupMin: 44, lastConfigChangeMin: 20, backupCompliance: "COMPLIANT", tags: ["firewall", "branch", "change-freeze"], notes: "SFOS 19.5 MR2 patch in progress under CHG-2026-00406.", cpuBase: 38, cpuAmp: 10, utilBase: 30 },
  { id: "dev-br2-access-sw-01", hostname: "BR2-Access-SW-01", vendorId: "ven-hpe", model: "6100 48G (JL680A)", platform: "AOS-CX", firmware: "10.10.1070", serial: "CN25F8Q07H", role: "ACCESS_SWITCH", siteId: "site-br2-muk", mgmtIp: "10.50.255.3", status: "MAINTENANCE", criticality: "MEDIUM", healthScore: 80, uptimeHours: 24 * 2, lastSeenMin: 10, lastBackupMin: 100, lastConfigChangeMin: 2000, backupCompliance: "COMPLIANT", tags: ["access", "maintenance"], notes: "Inside active maintenance window MW-2026-011; alert suppression enabled.", cpuBase: 12, cpuAmp: 5, utilBase: 14 },
  { id: "dev-br2-wan-edge-01", hostname: "BR2-WAN-EDGE-01", vendorId: "ven-generic", model: "NetGate 6100", platform: "pfSense", firmware: "23.09", serial: "NG6100X9021", role: "WAN_GATEWAY", siteId: "site-br2-muk", mgmtIp: "10.50.255.4", status: "UNMANAGED", criticality: "LOW", healthScore: 100, uptimeHours: null, lastSeenMin: 2880, lastBackupMin: null, lastConfigChangeMin: null, backupCompliance: "NEVER_BACKED_UP", tags: ["discovered", "pending-import"], notes: "Discovered via SNMP sweep; pending import and credential assignment.", cpuBase: 20, cpuAmp: 8, utilBase: 18 },
];

/* ────────────────────────────── interfaces ────────────────────────────── */

interface IfaceSpec {
  name: string;
  description: string;
  adminStatus: string;
  operStatus: string;
  speedMbps: number | null;
  vlan: number | null;
  mtu: number;
  inBps: number | null;
  outBps: number | null;
  lastFlapMinAgo?: number;
  hasMac: boolean;
}

function ifacesFor(d: DeviceSpec): IfaceSpec[] {
  const up = (name: string, description: string, speedMbps: number, inBps: number, outBps: number, vlan: number | null = null, mtu = 1500): IfaceSpec =>
    ({ name, description, adminStatus: "UP", operStatus: "UP", speedMbps, vlan, mtu, inBps, outBps, hasMac: true });
  const down = (name: string, description: string, speedMbps: number, adminDown = false): IfaceSpec =>
    ({ name, description, adminStatus: adminDown ? "DOWN" : "UP", operStatus: "DOWN", speedMbps, vlan: null, mtu: 1500, inBps: null, outBps: null, lastFlapMinAgo: ri(200, 4000), hasMac: true });

  const bps = (lo: number, hi: number) => ri(lo, hi);
  const model = d.model.toUpperCase();

  if (d.vendorId === "ven-fortinet") {
    return [
      up("port1", "WAN-UPLINK", 1000, bps(20_000_000, 400_000_000), bps(10_000_000, 300_000_000)),
      up("port2", "LAN-TRUNK", 1000, bps(30_000_000, 700_000_000), bps(30_000_000, 600_000_000)),
      up("port3", "HA-HEARTBEAT", 1000, bps(1_000_000, 9_000_000), bps(1_000_000, 9_000_000)),
      d.model.includes("600F")
        ? up("port4", "HA-HEARTBEAT-2", 1000, bps(1_000_000, 5_000_000), bps(1_000_000, 5_000_000))
        : down("port4", "SPARE", 1000, true),
      down("port5", "RESERVED", 1000, true),
    ];
  }
  if (d.vendorId === "ven-sophos") {
    const big = d.model.includes("3300");
    const list = [
      up("port1", "WAN-UPLINK", 1000, bps(15_000_000, 300_000_000), bps(10_000_000, 250_000_000)),
      up("port2", "LAN-CORE", 1000, bps(25_000_000, 500_000_000), bps(20_000_000, 400_000_000)),
    ];
    if (big) list.push(up("port3", "DMZ-SEGMENT", 1000, bps(5_000_000, 90_000_000), bps(4_000_000, 80_000_000)));
    list.push(down("port4", "RESERVED", 1000, true));
    if (big) list.push(down("port5", "RESERVED", 1000, true), down("port6", "RESERVED", 1000, true));
    return list;
  }
  if (d.vendorId === "ven-generic") {
    return [
      up("wan0", "WAN-UPLINK", 1000, bps(5_000_000, 90_000_000), bps(4_000_000, 70_000_000)),
      up("eth0", "LAN-BRIDGE", 1000, bps(10_000_000, 120_000_000), bps(8_000_000, 100_000_000)),
      down("eth1", "SPARE", 1000, true),
    ];
  }
  if (d.vendorId === "ven-hpe") {
    if (d.role === "TOP_OF_RACK") {
      return [
        up("1/1/1", "SRV-ESX-01", 10000, bps(40_000_000, 900_000_000), bps(40_000_000, 900_000_000), 120, 9198),
        up("1/1/2", "SRV-ESX-02", 10000, bps(40_000_000, 850_000_000), bps(40_000_000, 850_000_000), 120, 9198),
        up("1/1/3", "SRV-BAREMETAL", 10000, bps(10_000_000, 200_000_000), bps(10_000_000, 250_000_000), 120, 9198),
        up("1/1/49", "UPLINK-CORE", 10000, bps(200_000_000, 950_000_000), bps(150_000_000, 900_000_000), null, 9198),
        { name: "lag1", description: "MLAG-UPLINK", adminStatus: "UP", operStatus: "UP", speedMbps: 20000, vlan: null, mtu: 9198, inBps: bps(300_000_000, 900_000_000), outBps: bps(300_000_000, 850_000_000), hasMac: false },
        down("1/1/48", "SPARE", 10000, true),
      ];
    }
    return [
      up("1/1/1", "AP-FLOOR-A", 1000, bps(2_000_000, 40_000_000), bps(1_000_000, 30_000_000), 20),
      up("1/1/2", "ACCESS-VLAN10", 1000, bps(5_000_000, 120_000_000), bps(4_000_000, 90_000_000), 10),
      up("1/1/3", "ACCESS-VLAN20", 1000, bps(3_000_000, 80_000_000), bps(2_000_000, 60_000_000), 20),
      d.hostname === "HQ-Access-SW-01"
        ? up("1/1/7", "GUEST-TEMP", 1000, bps(500_000, 9_000_000), bps(500_000, 6_000_000), 55)
        : down("1/1/7", "SPARE", 1000),
      up("1/1/24", d.hostname === "HQ-Access-SW-01" ? "UPLINK-CORE-02" : "UPLINK-CORE-01", 1000, bps(80_000_000, 900_000_000), bps(60_000_000, 700_000_000), null, 9198),
      { name: "lag1", description: "UPLINK-LACP", adminStatus: "UP", operStatus: "UP", speedMbps: 2000, vlan: null, mtu: 9198, inBps: bps(90_000_000, 900_000_000), outBps: bps(80_000_000, 700_000_000), hasMac: false },
    ];
  }
  // Cisco family
  if (d.role === "CORE_ROUTER" || d.role === "EDGE_ROUTER" || d.role === "BRANCH_ROUTER") {
    const list: IfaceSpec[] = [
      up("GigabitEthernet0/0/0", "WAN-UPLINK", 1000, bps(50_000_000, 900_000_000), bps(40_000_000, 800_000_000)),
      up("GigabitEthernet0/0/1", "LAN-CORE-LINK", 1000, bps(60_000_000, 900_000_000), bps(50_000_000, 800_000_000)),
    ];
    if (!model.includes("4331")) list.push(up("GigabitEthernet0/0/2", "LAN-CORE-LINK-2", 1000, bps(30_000_000, 500_000_000), bps(30_000_000, 450_000_000)));
    list.push(down("GigabitEthernet0/0/3", "RESERVED", 1000, true));
    if (!model.includes("4331") && !model.includes("ASR920")) list.push(up("TenGigabitEthernet0/1/0", "DC-INTERCONNECT", 10000, bps(200_000_000, 1_400_000_000), bps(200_000_000, 1_200_000_000), null, 9216));
    list.push({ name: "Tunnel10", description: "SDWAN-OVERLAY", adminStatus: "UP", operStatus: "UP", speedMbps: null, vlan: null, mtu: 1476, inBps: bps(5_000_000, 120_000_000), outBps: bps(4_000_000, 100_000_000), hasMac: false });
    return list;
  }
  if (model.includes("9500")) {
    return [
      up("TenGigabitEthernet1/1/1", "UPLINK-CORE-RTR-01", 10000, bps(300_000_000, 1_900_000_000), bps(250_000_000, 1_600_000_000), null, 9216),
      up("TenGigabitEthernet1/1/2", "UPLINK-CORE-RTR-02", 10000, bps(250_000_000, 1_700_000_000), bps(220_000_000, 1_500_000_000), null, 9216),
      up("GigabitEthernet1/0/1", "ACCESS-VLAN10", 1000, bps(10_000_000, 400_000_000), bps(8_000_000, 350_000_000), 10),
      up("GigabitEthernet1/0/2", "ACCESS-VLAN20", 1000, bps(8_000_000, 300_000_000), bps(6_000_000, 280_000_000), 20),
      up("GigabitEthernet1/0/24", "TRUNK-TO-ACCESS", 1000, bps(50_000_000, 800_000_000), bps(40_000_000, 700_000_000)),
      down("GigabitEthernet1/0/47", "SPARE", 1000, true),
    ];
  }
  if (model.includes("9800")) {
    return [
      up("TenGigabitEthernet0/0/1", "UPLINK-CORE-SW-01", 10000, bps(120_000_000, 900_000_000), bps(100_000_000, 800_000_000)),
      up("TenGigabitEthernet0/0/2", "UPLINK-CORE-SW-02", 10000, bps(100_000_000, 800_000_000), bps(90_000_000, 700_000_000)),
      up("GigabitEthernet0", "MGMT-PORT", 1000, bps(1_000_000, 20_000_000), bps(1_000_000, 20_000_000)),
      down("TenGigabitEthernet0/0/3", "SPARE", 10000, true),
    ];
  }
  if (model.includes("N9K")) {
    return [
      up("Ethernet1/1", "UPLINK-DC-CORE-RTR", 10000, bps(200_000_000, 1_800_000_000), bps(200_000_000, 1_500_000_000), null, 9216),
      up("Ethernet1/2", "UPLINK-DC-FW", 10000, bps(100_000_000, 900_000_000), bps(100_000_000, 800_000_000), null, 9216),
      up("Ethernet1/3", "PO-SRV-TOR", 10000, bps(150_000_000, 1_200_000_000), bps(150_000_000, 1_000_000_000), null, 9216),
      down("Ethernet1/4", "SPARE", 10000, true),
      up("mgmt0", "MGMT-PORT", 1000, bps(1_000_000, 30_000_000), bps(1_000_000, 30_000_000)),
    ];
  }
  if (model.includes("ASR920")) {
    return [
      up("GigabitEthernet0/0/0", "AGG-UPLINK", 1000, bps(100_000_000, 900_000_000), bps(90_000_000, 800_000_000)),
      up("GigabitEthernet0/0/1", "AGG-UPLINK-2", 1000, bps(90_000_000, 850_000_000), bps(80_000_000, 750_000_000)),
      up("GigabitEthernet0/0/2", "CUSTOMER-P2P", 1000, bps(10_000_000, 300_000_000), bps(10_000_000, 300_000_000)),
      up("TenGigabitEthernet0/0/24", "RING-UPLINK", 10000, bps(200_000_000, 1_300_000_000), bps(180_000_000, 1_100_000_000), null, 9216),
    ];
  }
  // Catalyst 9200 / 2960X access
  return [
    up("GigabitEthernet1/0/1", "ACCESS-VLAN10", 1000, bps(5_000_000, 150_000_000), bps(4_000_000, 120_000_000), 10),
    up("GigabitEthernet1/0/2", "ACCESS-VLAN20", 1000, bps(4_000_000, 100_000_000), bps(3_000_000, 90_000_000), 20),
    d.hostname === "HQ-IDF-SW-01"
      ? down("GigabitEthernet1/0/3", "ACCESS-VLAN10", 1000)
      : up("GigabitEthernet1/0/3", "ACCESS-VLAN10", 1000, bps(3_000_000, 90_000_000), bps(2_000_000, 70_000_000), 10),
    up("GigabitEthernet1/0/24", "TRUNK-TO-CORE", 1000, bps(40_000_000, 700_000_000), bps(30_000_000, 600_000_000)),
    down("GigabitEthernet1/0/5", "SPARE", 1000, true),
  ];
}

/* ────────────────────────────── vendor config builders ────────────────────────────── */

interface IosRouterOpts {
  hostname: string;
  model: string;
  firmware: string;
  routerId: string;
  location: string;
  uplinkIp: string;
  uplinkDesc: string;
  uplinkPeer: string;
  peerAs: string;
  lanLinks: Array<{ ip: string; desc: string }>;
  dcLink?: { ip: string; desc: string };
  sdwanTunnel: boolean;
  prefixList: boolean;
  qos: boolean;
  snmpAcl: boolean;
  archive: boolean;
  startup?: boolean;
}

function iosRouterConfig(o: IosRouterOpts): string {
  const s: string[] = [];
  s.push(`!
version 17.6
service timestamps debug datetime msec localtime show-timezone
service timestamps log datetime msec localtime show-timezone
service password-encryption
!
hostname ${o.hostname}
!
no ip domain-lookup
ip domain-name faya.local
ip name-server 10.20.10.10
ip name-server 10.20.10.11
!
aaa new-model
aaa authentication login default group TACACS+ local
aaa authorization exec default group TACACS+ local
!
ip ssh version 2
ip ssh time-out 60
ip ssh authentication-retries 3
!
interface Loopback0
 description ROUTER-ID
 ip address ${o.routerId} 255.255.255.255
!
interface GigabitEthernet0/0/0
 description ${o.uplinkDesc}
 ip address ${o.uplinkIp}
 no shutdown`);
  o.lanLinks.forEach((l, i) => {
    s.push(`!
interface GigabitEthernet0/0/${i + 1}
 description ${l.desc}
 ip address ${l.ip}
 no shutdown`);
  });
  if (o.dcLink) {
    s.push(`!
interface TenGigabitEthernet0/1/0
 description ${o.dcLink.desc}
 ip address ${o.dcLink.ip}
 no shutdown`);
  }
  if (o.sdwanTunnel) {
    s.push(`!
interface Tunnel10
 description SDWAN-OVERLAY-ISP-A
 ip address 172.16.10.11 255.255.255.0
 tunnel source GigabitEthernet0/0/0
 tunnel mode sdwan`);
  }
  s.push(`!
router bgp 65001
 bgp router-id ${o.routerId}
 bgp log-neighbor-changes
 neighbor ${o.uplinkPeer} remote-as ${o.peerAs}
 neighbor ${o.uplinkPeer} description TRANSIT-PEER
 !
 address-family ipv4 unicast
  network 10.20.0.0 mask 255.255.0.0
  neighbor ${o.uplinkPeer} activate
 exit-address-family`);
  if (o.prefixList) {
    s.push(`!
ip prefix-list TRANSIT-OUT seq 10 permit 10.20.0.0/16
ip prefix-list TRANSIT-OUT seq 20 deny 0.0.0.0/0 le 32
!
router bgp 65001
 address-family ipv4 unicast
  neighbor ${o.uplinkPeer} prefix-list TRANSIT-OUT out
 exit-address-family`);
  }
  s.push(`!
ip route 0.0.0.0 0.0.0.0 ${o.uplinkIp.split(" ")[0].replace(/\.\d+$/, ".1")} name DEFAULT-TRANSIT
!
snmp-server community FayaR0c RO${o.snmpAcl ? " 80" : ""}
snmp-server location ${o.location}
snmp-server contact NOC <noc@faya.local>
snmp-server host 10.20.10.5 version 2c FayaR0c`);
  if (o.snmpAcl) {
    s.push(`!
access-list 80 permit 10.20.10.0 0.0.0.31
access-list 80 deny   any log`);
  }
  s.push(`!
logging buffered 64000 informational
logging host 10.20.10.6
!
ntp server 10.20.10.10 prefer
ntp server 10.20.10.11`);
  if (o.archive) {
    s.push(`!
archive
 log config
  logging enable
  notify syslog contenttype plaintext
 hidekeys`);
  }
  if (o.qos) {
    s.push(`!
class-map match-any QOS-VOICE
 match dscp ef
class-map match-any QOS-CRITICAL
 match dscp cs3 af31
!
policy-map WAN-QOS-CHILD
 class QOS-VOICE
  priority percent 30
 class QOS-CRITICAL
  bandwidth remaining percent 50
 class class-default
  fair-queue
!
policy-map WAN-QOS-PARENT
 class class-default
  shape average 900000000
  service-policy WAN-QOS-CHILD
!
interface GigabitEthernet0/0/0
 service-policy output WAN-QOS-PARENT`);
  }
  s.push(`!
line con 0
 exec-timeout 10 0
line vty 0 4
 exec-timeout 10 0
 transport input ssh
line vty 5 15
 exec-timeout 10 0
 transport input ssh
!
end`);
  const header = o.startup
    ? `!
! Startup configuration — collected from NVRAM
! Device: ${o.hostname} (${o.model}, ${o.firmware})
!`
    : `!
! FayaNMS collected configuration — do not edit
! Device: ${o.hostname} (${o.model}, ${o.firmware})
!`;
  return header + "\n" + s.join("\n") + "\n";
}

interface IosCatOpts {
  hostname: string;
  model: string;
  firmware: string;
  location: string;
  mgmtIp: string;
  hsrpIp: string;
  hsrpPriority: number;
  vlan60: boolean;
  snmpV3: boolean;
}

function iosCatSwitchConfig(o: IosCatOpts): string {
  const s: string[] = [];
  s.push(`!
! FayaNMS collected configuration — do not edit
! Device: ${o.hostname} (${o.model}, ${o.firmware})
!
version 17.9
service timestamps debug datetime msec localtime show-timezone
service timestamps log datetime msec localtime show-timezone
!
hostname ${o.hostname}
!
vrf definition MGMT
 address-family ipv4
 exit-address-family
!
spanning-tree mode rapid-pvst
spanning-tree vlan 1,10,20,99 root secondary
!
vlan 10
 name USERS
vlan 20
 name VOICE
vlan 99
 name MGMT`);
  if (o.vlan60) s.push(`vlan 60\n name GUEST`);
  s.push(`!
interface TenGigabitEthernet1/1/1
 description UPLINK-CORE-RTR-01
 switchport mode trunk
 switchport trunk allowed vlan 10,20,99${o.vlan60 ? ",60" : ""}
!
interface TenGigabitEthernet1/1/2
 description UPLINK-CORE-RTR-02
 switchport mode trunk
 switchport trunk allowed vlan 10,20,99${o.vlan60 ? ",60" : ""}
!
interface GigabitEthernet1/0/1
 description ACCESS-FLOOR1
 switchport mode access
 switchport access vlan 10
 spanning-tree portfast
!
interface GigabitEthernet1/0/2
 description ACCESS-FLOOR2
 switchport mode access
 switchport access vlan 20
 spanning-tree portfast
!
interface GigabitEthernet1/0/24
 description TRUNK-TO-ACCESS-SW
 switchport mode trunk
 switchport trunk allowed vlan 10,20,99${o.vlan60 ? ",60" : ""}
!
interface Vlan99
 description MGMT-SVI
 vrf forwarding MGMT
 ip address ${o.mgmtIp} 255.255.255.0
 no shutdown
!
interface Vlan10
 description USERS-SVI
 ip address ${o.hsrpIp}
 ip helper-address 10.20.10.20
 no shutdown
 standby version 2
 standby 10 ip 10.20.10.1
 standby 10 priority ${o.hsrpPriority}
 standby 10 preempt`);
  if (o.snmpV3) {
    s.push(`!
snmp-server group FAYA-RO v3 priv read SNMP-VIEW-ALL
snmp-server user faya-mon FAYA-RO v3 auth sha authPass01 priv aes 128 privPass01
snmp-server view SNMP-VIEW-ALL iso included`);
  } else {
    s.push(`!
snmp-server community FayaR0c RO`);
  }
  s.push(`snmp-server location ${o.location}
snmp-server contact NOC <noc@faya.local>
!
logging buffered 64000 informational
logging host 10.20.10.6
!
ntp server 10.20.10.10 prefer
!
ip route vrf MGMT 0.0.0.0 0.0.0.0 10.20.255.254
!
line vty 0 4
 exec-timeout 10 0
 transport input ssh
!
end`);
  return s.join("\n") + "\n";
}

interface FortiOpts {
  hostname: string;
  model: string;
  firmware: string;
  location: string;
  wanIp: string;
  lanIp: string;
  dmzIp?: string;
  haPriority: number;
  guestPolicy: boolean;
  ipsecPolicy: boolean;
  backupVlanPolicy: boolean;
}

function fortigateConfig(o: FortiOpts): string {
  const s: string[] = [];
  s.push(`#config-version=${o.model.replace(/\s/g, "")}-${o.firmware}-FW-build1394-260214:opmode=0:vdom=root:user=cfgbackup
#conf_file_ver=2602140000
#buildno=1394
#global_vdom=1
config system global
    set hostname "${o.hostname}"
    set timezone 39
    set admin-sport 443
    set gui-theme "onnet-jade"
end
config system interface
    edit "port1"
        set vdom "root"
        set ip ${o.wanIp}
        set allowaccess ping https ssh snmp
        set role wan
        set description "WAN-UPLINK"
    next
    edit "port2"
        set vdom "root"
        set ip ${o.lanIp}
        set allowaccess ping https ssh snmp
        set role lan
        set description "LAN-CORE"
    next
    edit "port3"
        set vdom "root"
        set ip 169.254.0.1 255.255.255.252
        set allowaccess ping
        set description "HA-HEARTBEAT"
    next
end`);
  if (o.dmzIp) {
    s.push(`config system interface
    edit "port4"
        set vdom "root"
        set ip ${o.dmzIp}
        set allowaccess ping https
        set role dmz
        set description "DMZ-SEGMENT"
    next
end`);
  }
  s.push(`config system ha
    set group-id 11
    set group-name "FAYA-HA"
    set mode a-p
    set password ENC SH2${o.haPriority}9xQpLm==
    set hbdev "port3" 100
    set session-pickup enable
    set override disable
    set priority ${o.haPriority}
end
config firewall policy
    edit 1
        set name "LAN-to-WAN"
        set srcintf "port2"
        set dstintf "port1"
        set srcaddr "all"
        set dstaddr "all"
        set action accept
        set schedule "always"
        set service "ALL"
        set logtraffic all
    next
    edit 2
        set name "MGMT-Access"
        set srcintf "port2"
        set dstintf "port3"
        set srcaddr "MGMT-SUBNET"
        set dstaddr "all"
        set action accept
        set schedule "always"
        set service "HTTPS SSH"
        set logtraffic utm
    next`);
  if (o.guestPolicy) {
    s.push(`    edit 3
        set name "GUEST-to-WAN"
        set srcintf "port2"
        set dstintf "port1"
        set srcaddr "GUEST-NET"
        set dstaddr "all"
        set action accept
        set schedule "workhours"
        set service "HTTP HTTPS DNS"
        set comments "Guest isolation via CHG-2026-00392"
    next`);
  }
  if (o.ipsecPolicy) {
    s.push(`    edit 4
        set name "IPSEC-BRANCH-TUNNELS"
        set srcintf "port1"
        set dstintf "port1"
        set srcaddr "BRANCH-NETS"
        set dstaddr "HQ-NETS"
        set action accept
        set schedule "always"
        set service "ALL"
        set comments "Branch VPN mesh"
    next`);
  }
  if (o.backupVlanPolicy) {
    s.push(`    edit 5
        set name "BKUP-VLAN-REPO"
        set srcintf "port2"
        set dstintf "port2"
        set srcaddr "BKUP-VLAN-30"
        set dstaddr "REPO-SERVERS"
        set action accept
        set schedule "always"
        set service "SSH HTTPS"
        set comments "Backup repo access — CHG-2026-00388"
    next`);
  }
  s.push(`end
config router static
    edit 1
        set gateway ${o.wanIp.split(" ")[0].replace(/\.\d+$/, ".1")}
        set device "port1"
    next
end
config system snmp community
    edit 1
        set name "FayaRO"
        set status enable
        set hosts 10.20.10.5 10.30.10.5
    next
end
config log syslogd setting
    set status enable
    set server "10.20.10.6"
    set format cef
end`);
  return s.join("\n") + "\n";
}

interface SophosOpts {
  hostname: string;
  model: string;
  firmware: string;
  location: string;
  wanIp: string;
  lanIp: string;
  dmzIp?: string;
  haPriority: number;
  dmzRule: boolean;
  postEvent: boolean;
}

function sophosConfig(o: SophosOpts): string {
  const s: string[] = [];
  s.push(`!
! Sophos Firewall CLI configuration
! Device: ${o.hostname} (${o.model}, ${o.firmware})
!${o.postEvent ? "\n! Captured by FayaNMS after HA failover event (secondary is ACTIVE)" : ""}
!
hostname ${o.hostname}
!
timezone 39
!
interface
  port1
    name WAN
    zone WAN
    ip ${o.wanIp}
    status enable
  exit
  port2
    name LAN-DC
    zone LAN
    ip ${o.lanIp}
    status enable
  exit`);
  if (o.dmzIp) {
    s.push(`  port3
    name DMZ
    zone DMZ
    ip ${o.dmzIp}
    status enable
  exit`);
  }
  s.push(`exit
!
router
  static
    route 0.0.0.0 0 gateway ${o.wanIp.split(" ")[0].replace(/\.\d+$/, ".1")}
    route 10.0.0.0 8 gateway ${o.lanIp.split(" ")[0].replace(/\.\d+$/, ".254")}
  exit
exit
!
firewall
  add rule LAN_to_WAN
    set source_zone LAN
    set destination_zone WAN
    set action accept
    set log_traffic enable
  exit`);
  if (o.dmzRule) {
    s.push(`  add rule DMZ_to_WAN_443
    set source_zone DMZ
    set destination_zone WAN
    set service HTTPS
    set action accept
    set log_traffic enable
    set description "DMZ outbound HTTPS only"
  exit`);
  }
  s.push(`exit
!
ha
  set mode active-passive
  set devicepriority ${o.haPriority}
  set monitoring enable
exit
!
snmp
  add community FayaRO
  set location "${o.location}"
  set contact "NOC <noc@faya.local>"
  status enable
exit
!
syslog
  add syslog_server 10.20.10.6
  set facility local7
  status enable
exit
!
end`);
  return s.join("\n") + "\n";
}

interface AosCxOpts {
  hostname: string;
  model: string;
  firmware: string;
  location: string;
  mgmtIp: string;
  cameraVlan: boolean;
  guest55: boolean;
  descChanged: boolean;
}

function aosCxConfig(o: AosCxOpts): string {
  const s: string[] = [];
  s.push(`!
! AOS-CX running configuration — collected by FayaNMS
! Device: ${o.hostname} (${o.model}, ${o.firmware})
!
hostname ${o.hostname}
!
vlan 1
    no shutdown
vlan 10
    name USERS
    no shutdown
vlan 20
    name VOICE
    no shutdown
vlan 99
    name MGMT
    no shutdown`);
  if (o.cameraVlan) s.push(`vlan 30\n    name CAMERA\n    no shutdown`);
  if (o.guest55) s.push(`vlan 55\n    name GUEST-TEMP\n    no shutdown`);
  s.push(`!
interface lag 1
    description UPLINK-CORE
    no shutdown
    vlan trunk allowed 10,20,99${o.cameraVlan ? ",30" : ""}
    lacp mode active
!
interface 1/1/1
    description AP-FLOOR-A
    no shutdown
    vlan access 20
    vlan trunk allowed 10,20
    poe enable
!
interface 1/1/2
    description ACCESS-VLAN10
    no shutdown
    vlan access 10
    spanning-tree admin-edge-port
!
interface 1/1/3
    description ACCESS-VLAN20
    no shutdown
    vlan access 20
    poe enable
!
interface 1/1/7
    ${o.guest55 ? "description GUEST-TEMP-PORT\n    no shutdown\n    vlan access 55" : "description SPARE\n    shutdown"}`);
  s.push(`!
interface 1/1/24
    description ${o.descChanged ? "UPLINK-CORE-02" : "UPLINK-CORE-01"}
    no shutdown
    mtu 9198
    lacp mode active
!
snmp-server community FayaRO read
snmp-server location "${o.location}"
snmp-server contact "NOC <noc@faya.local>"
!
logging 10.20.10.6 udp 514
ntp server 10.20.10.10 iburst prefer
!
password manager plaintext-hash $2y$05$FayaNMSDemoHashOnlyNotReal$
!
end`);
  return s.join("\n") + "\n";
}

/* ────────────────────────────── snapshot plans ────────────────────────────── */

interface SnapPlan {
  version: number;
  source: string; // SCHEDULED | MANUAL | PRE_CHANGE | POST_CHANGE | EVENT
  configType: string; // RUNNING | STARTUP
  status: string; // CURRENT | HISTORICAL | BASELINE
  minAgo: number;
  userId?: string;
  changeId?: string;
  jobId?: string;
  text: string;
}

function buildSnapshotPlans(): Map<string, SnapPlan[]> {
  const plans = new Map<string, SnapPlan[]>();
  const plan = (deviceId: string, rows: SnapPlan[]) => plans.set(deviceId, rows);

  // HQ-Core-RTR-01 — QoS deployment story (CHG-2026-00407) + baseline on post-change state
  {
    const base = {
      hostname: "HQ-Core-RTR-01", model: "ISR4451-X", firmware: "IOS XE 17.06.04", routerId: "10.255.0.1",
      location: "HQ-Sanaa-MDF", uplinkIp: "203.0.113.2 255.255.255.252", uplinkDesc: "UPLINK-ISP-A",
      uplinkPeer: "203.0.113.1", peerAs: "64500",
      lanLinks: [
        { ip: "10.20.254.1 255.255.255.252", desc: "LINK-TO-HQ-Core-SW-01" },
        { ip: "10.20.254.5 255.255.255.252", desc: "LINK-TO-HQ-Core-SW-02" },
      ],
      dcLink: { ip: "10.20.254.9 255.255.255.252", desc: "DC-INTERCONNECT-Aden" },
      sdwanTunnel: true,
    };
    const mk = (o: Partial<IosRouterOpts>) => iosRouterConfig({ ...base, prefixList: false, qos: false, snmpAcl: false, archive: false, ...o } as IosRouterOpts);
    plan("dev-hq-core-rtr-01", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 43200, userId: "usr-engineer1", text: mk({}) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 30240, text: mk({ archive: true }) },
      { version: 3, source: "PRE_CHANGE", configType: "RUNNING", status: "HISTORICAL", minAgo: 12960, userId: "usr-engineer1", changeId: "chg-2026-00407", text: mk({ archive: true }) },
      { version: 4, source: "POST_CHANGE", configType: "RUNNING", status: "BASELINE", minAgo: 12950, userId: "usr-engineer1", changeId: "chg-2026-00407", text: mk({ archive: true, qos: true, snmpAcl: true }) },
      { version: 5, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 2880, text: mk({ archive: true, qos: true, snmpAcl: true }) },
    ]);
  }

  // HQ-Core-SW-01 — guest VLAN 60 introduced, then SNMP hardened to v3
  {
    const mk = (o: Partial<IosCatOpts>) =>
      iosCatSwitchConfig({
        hostname: "HQ-Core-SW-01", model: "C9500-48Y4C", firmware: "17.09.03a", location: "HQ-Sanaa-MDF",
        mgmtIp: "10.20.255.3 255.255.255.0", hsrpIp: "10.20.10.2 255.255.255.0", hsrpPriority: 110,
        vlan60: false, snmpV3: false, ...o,
      });
    plan("dev-hq-core-sw-01", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 36000, userId: "usr-engineer1", text: mk({}) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 21600, text: mk({ vlan60: true }) },
      { version: 3, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 10080, text: mk({ vlan60: true }) },
      { version: 4, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 4320, text: mk({ vlan60: true, snmpV3: true }) },
    ]);
  }

  // HQ-Core-SW-02 — steady state
  {
    const mk = (o: Partial<IosCatOpts>) =>
      iosCatSwitchConfig({
        hostname: "HQ-Core-SW-02", model: "C9500-48Y4C", firmware: "17.09.03a", location: "HQ-Sanaa-MDF",
        mgmtIp: "10.20.255.4 255.255.255.0", hsrpIp: "10.20.10.3 255.255.255.0", hsrpPriority: 100,
        vlan60: true, snmpV3: false, ...o,
      });
    plan("dev-hq-core-sw-02", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 28800, userId: "usr-engineer1", text: mk({ vlan60: false }) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 14400, text: mk({}) },
      { version: 3, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 2880, text: mk({}) },
    ]);
  }

  // HQ-WAN-FW-01 — guest policy added, then branch IPsec policy; baseline v3
  {
    const base = {
      hostname: "HQ-WAN-FW-01", model: "FortiGate 600F", firmware: "7.4.3", location: "HQ-Sanaa-MDF",
      wanIp: "203.0.113.10 255.255.255.252", lanIp: "10.20.1.1 255.255.255.0", haPriority: 200,
      guestPolicy: false, ipsecPolicy: false, backupVlanPolicy: false,
    };
    const mk = (o: Partial<FortiOpts>) => fortigateConfig({ ...base, ...o });
    plan("dev-hq-wan-fw-01", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 43200, userId: "usr-engineer1", text: mk({}) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 28800, text: mk({ guestPolicy: true }) },
      { version: 3, source: "SCHEDULED", configType: "RUNNING", status: "BASELINE", minAgo: 17280, text: mk({ guestPolicy: true }) },
      { version: 4, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 4320, text: mk({ guestPolicy: true, ipsecPolicy: true }) },
    ]);
  }

  // DC-Core-RTR-01 — transit prefix-list hardening
  {
    const base = {
      hostname: "DC-Core-RTR-01", model: "ASR1001-X", firmware: "IOS XE 17.06.05", routerId: "10.255.0.5",
      location: "DC-Aden-CR", uplinkIp: "198.51.100.2 255.255.255.252", uplinkDesc: "UPLINK-ISP-B",
      uplinkPeer: "198.51.100.1", peerAs: "64510",
      lanLinks: [{ ip: "10.30.254.1 255.255.255.252", desc: "LINK-TO-DC-Core-SW-01" }],
      dcLink: { ip: "10.20.254.10 255.255.255.252", desc: "DC-INTERCONNECT-HQ" },
      sdwanTunnel: false,
    };
    const mk = (o: Partial<IosRouterOpts>) => iosRouterConfig({ ...base, prefixList: false, qos: false, snmpAcl: false, archive: false, ...o } as IosRouterOpts);
    plan("dev-dc-core-rtr-01", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 36000, userId: "usr-engineer1", text: mk({}) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 21600, text: mk({ archive: true }) },
      { version: 3, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 10080, text: mk({ archive: true, prefixList: true }) },
      { version: 4, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 5760, text: mk({ archive: true, prefixList: true, snmpAcl: true }) },
    ]);
  }

  // DC-FW-01 — backup VLAN policy added
  {
    const base = {
      hostname: "DC-FW-01", model: "FortiGate 601E", firmware: "7.2.7", location: "DC-Aden-CR",
      wanIp: "198.51.100.6 255.255.255.252", lanIp: "10.30.1.1 255.255.255.0", dmzIp: "172.16.30.1 255.255.255.0",
      haPriority: 150, guestPolicy: false, ipsecPolicy: false, backupVlanPolicy: false,
    };
    const mk = (o: Partial<FortiOpts>) => fortigateConfig({ ...base, ...o });
    plan("dev-dc-fw-01", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 28800, userId: "usr-engineer1", text: mk({}) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 14400, text: mk({ backupVlanPolicy: true }) },
      { version: 3, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 4320, text: mk({ backupVlanPolicy: true }) },
    ]);
  }

  // DC-DMZ-FW-01 (Sophos) — DMZ rule added; latest captured after HA failover event
  {
    const base = {
      hostname: "DC-DMZ-FW-01", model: "XGS 3300", firmware: "SFOS 19.5 MR1", location: "DC-Aden-DMZ",
      wanIp: "198.51.100.10 255.255.255.240", lanIp: "10.30.2.1 255.255.255.0", dmzIp: "172.16.30.33 255.255.255.0",
      haPriority: 80, dmzRule: false, postEvent: false,
    };
    const mk = (o: Partial<SophosOpts>) => sophosConfig({ ...base, ...o });
    plan("dev-dc-dmz-fw-01", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 28800, userId: "usr-engineer1", text: mk({}) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 11520, text: mk({ dmzRule: true }) },
      { version: 3, source: "EVENT", configType: "RUNNING", status: "CURRENT", minAgo: 2880, text: mk({ dmzRule: true, postEvent: true }) },
    ]);
  }

  // BR1-Edge-RTR-01 — second SD-WAN overlay; v1 from NVRAM (STARTUP)
  {
    const base = {
      hostname: "BR1-Edge-RTR-01", model: "ISR4331", firmware: "IOS XE 17.09.04a", routerId: "10.255.0.11",
      location: "BR1-Hodeidah", uplinkIp: "203.0.113.30 255.255.255.252", uplinkDesc: "UPLINK-ISP-A-BR1",
      uplinkPeer: "203.0.113.29", peerAs: "64500",
      lanLinks: [{ ip: "10.40.1.1 255.255.255.0", desc: "BR1-LAN" }],
      sdwanTunnel: true,
    };
    const mk = (o: Partial<IosRouterOpts>) => iosRouterConfig({ ...base, prefixList: false, qos: false, snmpAcl: false, archive: false, ...o } as IosRouterOpts);
    plan("dev-br1-edge-rtr-01", [
      { version: 1, source: "MANUAL", configType: "STARTUP", status: "HISTORICAL", minAgo: 43200, userId: "usr-engineer1", text: mk({ startup: true }) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 17280, text: mk({ archive: true }) },
      { version: 3, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 4320, text: mk({ archive: true, snmpAcl: true }) },
    ]);
  }

  // HQ-Access-SW-01 — DRIFT DEVICE: unauthorized VLAN 55 + interface description change after baseline v3
  {
    const mk = (o: Partial<AosCxOpts>) =>
      aosCxConfig({
        hostname: "HQ-Access-SW-01", model: "6300M 48G (JL658A)", firmware: "AOS-CX 10.10.1070",
        location: "HQ-Sanaa-Floor1", mgmtIp: "10.20.255.9", cameraVlan: false, guest55: false, descChanged: false, ...o,
      });
    plan("dev-hq-access-sw-01", [
      { version: 1, source: "MANUAL", configType: "RUNNING", status: "HISTORICAL", minAgo: 64800, userId: "usr-engineer1", text: mk({}) },
      { version: 2, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 43200, text: mk({ cameraVlan: true }) },
      { version: 3, source: "SCHEDULED", configType: "RUNNING", status: "BASELINE", minAgo: 25920, text: mk({ cameraVlan: true }) },
      { version: 4, source: "SCHEDULED", configType: "RUNNING", status: "HISTORICAL", minAgo: 4320, text: mk({ cameraVlan: true, guest55: true }) },
      { version: 5, source: "SCHEDULED", configType: "RUNNING", status: "CURRENT", minAgo: 1440, text: mk({ cameraVlan: true, guest55: true, descChanged: true }) },
    ]);
  }

  return plans;
}

/* ────────────────────────────── metrics ────────────────────────────── */

const METRIC_KEYS = ["CPU", "MEMORY", "UTILIZATION_IN", "UTILIZATION_OUT"] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

function sampleTimestamps(): Date[] {
  const out: Date[] = [];
  for (let m = 1440; m > 240; m -= 15) out.push(ago(m)); // older tier: 15-min resolution
  for (let m = 240; m >= 0; m -= 5) out.push(ago(m)); // recent tier: 5-min resolution
  return out;
}

/** Diurnal busy factor peaking ~13:00 local (AST, UTC+3). */
function diurnal(ts: Date): number {
  const localH = (ts.getUTCHours() + 3) % 24;
  return Math.exp(-((localH - 13) ** 2) / 50);
}

function metricValue(d: DeviceSpec, metric: MetricKey, ts: Date): number {
  const busy = diurnal(ts);
  const noise = () => rnd() * 2 - 1;
  switch (metric) {
    case "CPU": {
      let v = d.cpuBase + busy * d.cpuAmp + noise() * 5;
      if (d.status === "DEGRADED" && rnd() < 0.06) v = ri(96, 99); // spike on degraded firewall
      if (d.cpuBase > 55 && rnd() < 0.04) v = ri(90, 98); // aging switch spikes
      return round1(clamp(v, 2, 99.5));
    }
    case "MEMORY": {
      const memBase = 34 + (100 - d.healthScore) / 3;
      return round1(clamp(memBase + busy * 12 + noise() * 3, 5, 97));
    }
    case "UTILIZATION_IN":
      return round1(clamp(d.utilBase + busy * 24 + noise() * 6, 1, 98.5));
    case "UTILIZATION_OUT":
      return round1(clamp(d.utilBase * 0.72 + busy * 19 + noise() * 5, 1, 98.5));
  }
}

/* ────────────────────────────── main ────────────────────────────── */

async function wipe() {
  // FK-safe order: children (or SetNull referencers) before parents.
  await db.auditEvent.deleteMany();
  await db.notification.deleteMany();
  await db.alert.deleteMany();
  await db.alertRule.deleteMany();
  await db.incidentEvent.deleteMany();
  await db.incidentDevice.deleteMany();
  await db.incident.deleteMany();
  await db.changeStep.deleteMany();
  await db.changeApproval.deleteMany();
  await db.changeDevice.deleteMany();
  await db.changeRequest.deleteMany();
  await db.maintenanceWindow.deleteMany();
  await db.metricSample.deleteMany();
  await db.metricRollup.deleteMany();
  await db.driftRecord.deleteMany();
  await db.configBaseline.deleteMany();
  await db.configSnapshot.deleteMany();
  await db.deviceInterface.deleteMany();
  await db.device.deleteMany();
  await db.backupPolicy.deleteMany();
  await db.credentialProfile.deleteMany();
  await db.vendor.deleteMany();
  await db.site.deleteMany();
  await db.organization.deleteMany();
  await db.jobExecution.deleteMany();
  await db.reportSchedule.deleteMany();
  await db.setting.deleteMany();
  await db.user.deleteMany();
  await db.role.deleteMany();
}

async function seedReference() {
  await db.organization.create({ data: ORG });
  await db.site.createMany({ data: SITES.map((s) => ({ ...s, organizationId: ORG.id })) });
  await db.vendor.createMany({ data: VENDORS });
  await db.role.createMany({ data: ROLES });
  await db.user.createMany({
    data: USERS.map((u) => ({ ...u, isActive: true, passwordHash: null })),
  });
  await db.credentialProfile.createMany({
    data: CREDENTIALS.map((c) => ({ ...c, lastRotatedAt: ago(ri(2880, 20000)) })),
  });
  await db.backupPolicy.createMany({ data: BACKUP_POLICIES });
  await db.reportSchedule.createMany({ data: REPORT_SCHEDULES });
  await db.setting.createMany({ data: SETTINGS });
}

async function seedDevices() {
  await db.device.createMany({
    data: D.map((d) => ({
      id: d.id,
      hostname: d.hostname,
      displayName: d.hostname.replace(/-/g, " "),
      mgmtIp: d.mgmtIp,
      vendorId: d.vendorId,
      platform: d.platform,
      model: d.model,
      serialNumber: d.serial,
      firmware: d.firmware,
      role: d.role,
      siteId: d.siteId,
      status: d.status,
      criticality: d.criticality,
      healthScore: d.healthScore,
      uptimeSeconds: d.uptimeHours === null ? null : BigInt(d.uptimeHours * 3600),
      lastSeen: ago(d.lastSeenMin),
      lastBackupAt: d.lastBackupMin === null ? null : ago(d.lastBackupMin),
      lastConfigChangeAt: d.lastConfigChangeMin === null ? null : ago(d.lastConfigChangeMin),
      backupCompliance: d.backupCompliance,
      tagsJson: JSON.stringify(d.tags),
      notes: d.notes ?? null,
    })),
  });

  // Interfaces (4-6 per device, mixed states)
  const ifaceRows: Prisma.DeviceInterfaceCreateManyInput[] = [];
  const uplinkByDevice = new Map<string, string>();
  for (const d of D) {
    for (const f of ifacesFor(d)) {
      const id = `if-${d.hostname.toLowerCase()}-${f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      if (f.operStatus === "UP" && !uplinkByDevice.has(d.id)) uplinkByDevice.set(d.id, id);
      ifaceRows.push({
        id,
        deviceId: d.id,
        name: f.name,
        adminStatus: f.adminStatus,
        operStatus: f.operStatus,
        speedMbps: f.speedMbps,
        macAddress: f.hasMac ? macFor(d.hostname + f.name, ifaceRows.length) : null,
        description: f.description,
        vlan: f.vlan,
        mtu: f.mtu,
        countersInBps: f.inBps === null ? null : BigInt(f.inBps),
        countersOutBps: f.outBps === null ? null : BigInt(f.outBps),
        lastFlapAt: f.lastFlapMinAgo ? ago(f.lastFlapMinAgo) : null,
      });
    }
  }
  for (let i = 0; i < ifaceRows.length; i += 500) {
    await db.deviceInterface.createMany({ data: ifaceRows.slice(i, i + 500) });
  }
  return uplinkByDevice;
}

async function seedSnapshots() {
  const plans = buildSnapshotPlans();
  const rows: Prisma.ConfigSnapshotCreateManyInput[] = [];
  for (const [deviceId, snaps] of plans) {
    for (const sp of snaps) {
      const id = `snap-${deviceId.replace("dev-", "")}-v${sp.version}`;
      rows.push({
        id,
        deviceId,
        version: sp.version,
        source: sp.source,
        configType: sp.configType,
        rawText: sp.text,
        normalizedText: normalizeConfig(sp.text),
        sha256: sha256(sp.text),
        sizeBytes: sizeOf(sp.text),
        userId: sp.userId ?? null,
        changeId: sp.changeId ?? null,
        jobId: sp.jobId ?? null,
        status: sp.status,
        createdAt: ago(sp.minAgo),
      });
    }
  }
  await db.configSnapshot.createMany({ data: rows });
}

async function seedBaselinesAndDrift() {
  await db.configBaseline.createMany({
    data: [
      { deviceId: "dev-hq-core-rtr-01", snapshotId: "snap-hq-core-rtr-01-v4", approvedById: "usr-admin", approvedAt: ago(11520), note: "Approved post-change state of CHG-2026-00407 (WAN QoS deployment)." },
      { deviceId: "dev-hq-wan-fw-01", snapshotId: "snap-hq-wan-fw-01-v3", approvedById: "usr-admin", approvedAt: ago(14400), note: "Stable HA-primary state approved ahead of firmware refresh." },
      { deviceId: "dev-hq-access-sw-01", snapshotId: "snap-hq-access-sw-01-v3", approvedById: "usr-admin", approvedAt: ago(24480), note: "Access-layer gold config (camera VLAN 30 included)." },
    ],
  });

  await db.driftRecord.createMany({
    data: [
      {
        id: "drift-hq-access-sw-01-1",
        deviceId: "dev-hq-access-sw-01",
        baselineSnapshotId: "snap-hq-access-sw-01-v3",
        currentSnapshotId: "snap-hq-access-sw-01-v4",
        detectedAt: ago(4100),
        diffSummary: "Unauthorized change: VLAN 55 'GUEST-TEMP' added and assigned to interface 1/1/7; no change ticket found.",
        status: "OPEN",
      },
      {
        id: "drift-hq-access-sw-01-2",
        deviceId: "dev-hq-access-sw-01",
        baselineSnapshotId: "snap-hq-access-sw-01-v3",
        currentSnapshotId: "snap-hq-access-sw-01-v5",
        detectedAt: ago(1380),
        diffSummary: "Interface 1/1/24 description changed: 'UPLINK-CORE-01' → 'UPLINK-CORE-02'; unauthorized VLAN 55 still present.",
        status: "OPEN",
      },
    ],
  });
}

async function seedMetrics(uplinkByDevice: Map<string, string>) {
  const metricDevices = D.filter((d) => d.status !== "OFFLINE" && d.status !== "UNMANAGED");
  const timestamps = sampleTimestamps();

  const sampleRows: Prisma.MetricSampleCreateManyInput[] = [];
  for (const d of metricDevices) {
    const uplinkId = uplinkByDevice.get(d.id) ?? null;
    for (const metric of METRIC_KEYS) {
      for (const ts of timestamps) {
        sampleRows.push({
          id: `ms-${d.id}-${metric}-${ts.getTime()}`,
          deviceId: d.id,
          interfaceId: metric === "UTILIZATION_IN" || metric === "UTILIZATION_OUT" ? uplinkId : null,
          metric,
          value: metricValue(d, metric, ts),
          ts,
        });
      }
    }
  }
  for (let i = 0; i < sampleRows.length; i += 1000) {
    await db.metricSample.createMany({ data: sampleRows.slice(i, i + 1000) });
  }

  // 1H rollups from the raw samples
  const rollupRows: Prisma.MetricRollupCreateManyInput[] = [];
  for (const d of metricDevices) {
    for (const metric of METRIC_KEYS) {
      const buckets = new Map<number, number[]>();
      for (const ts of timestamps) {
        const bucket = Math.floor(ts.getTime() / 3_600_000) * 3_600_000;
        const arr = buckets.get(bucket) ?? [];
        arr.push(metricValue(d, metric, ts));
        buckets.set(bucket, arr);
      }
      for (const [bucket, values] of buckets) {
        rollupRows.push({
          id: `mr-${d.id}-${metric}-1H-${bucket}`,
          deviceId: d.id,
          metric,
          granularity: "1H",
          periodStart: new Date(bucket),
          avg: round1(values.reduce((a, b) => a + b, 0) / values.length),
          max: round1(Math.max(...values)),
          min: round1(Math.min(...values)),
          p95: round1(p95(values)),
        });
      }
    }
  }
  for (let i = 0; i < rollupRows.length; i += 1000) {
    await db.metricRollup.createMany({ data: rollupRows.slice(i, i + 1000) });
  }
  return { samples: sampleRows.length, rollups: rollupRows.length };
}

function changeStepsFor(
  changeId: string,
  mode: "full" | "running" | "rollback" | "scheduled",
  t0Minutes = 13000,
): Prisma.ChangeStepCreateManyInput[] {
  const passedAt = (order: number, startMin: number) => ({
    startedAt: ago(startMin),
    finishedAt: ago(startMin - 1),
  });
  if (mode === "full") {
    const t0 = t0Minutes;
    return [
      { changeId, order: 1, name: "Pre-flight checks", type: "CHECK", status: "PASSED", output: "Config unchanged since approval; device reachable (RTT 4 ms); no active incidents on target.", ...passedAt(1, t0) },
      { changeId, order: 2, name: "Pre-change backup", type: "BACKUP", status: "PASSED", output: "PRE_CHANGE snapshot stored (version N-1) with SHA-256 integrity verified.", ...passedAt(2, t0 - 2) },
      { changeId, order: 3, name: "Apply configuration", type: "APPLY", status: "PASSED", output: "Config pushed via SSH; commit confirmed; device converged in 12 s.", ...passedAt(3, t0 - 4) },
      { changeId, order: 4, name: "Post-change validation", type: "VALIDATE", status: "PASSED", output: "BGP neighbors up, service-policy counters incrementing, post-change backup captured.", ...passedAt(4, t0 - 6) },
      { changeId, order: 5, name: "Auto-rollback (on failure)", type: "ROLLBACK", status: "SKIPPED", output: "Not needed — validation passed; rollback plan on standby." },
    ];
  }
  if (mode === "rollback") {
    return [
      { changeId, order: 1, name: "Pre-flight checks", type: "CHECK", status: "PASSED", output: "PoE budget 640 W; image checksum verified; maintenance window open.", ...passedAt(1, 415) },
      { changeId, order: 2, name: "Pre-change backup", type: "BACKUP", status: "PASSED", output: "Running config (15.2(7)E3) backed up; SHA-256 recorded.", ...passedAt(2, 413) },
      { changeId, order: 3, name: "Install IOS 15.2(7)E4", type: "APPLY", status: "PASSED", output: "Image staged, boot variable set, switch reloaded.", ...passedAt(3, 410) },
      { changeId, order: 4, name: "Post-upgrade validation", type: "VALIDATE", status: "FAILED", error: "Device stopped responding after image boot; PoE members down; ICMP unreachable for 300 s.", startedAt: ago(395), finishedAt: ago(393) },
      { changeId, order: 5, name: "Auto-rollback to 15.2(7)E3", type: "ROLLBACK", status: "PASSED", output: "Rolled back via boot system override; device stable; uplink restored.", startedAt: ago(392), finishedAt: ago(388) },
    ];
  }
  if (mode === "running") {
    return [
      { changeId, order: 1, name: "Pre-flight checks", type: "CHECK", status: "PASSED", output: "HA secondary healthy; download mirror reachable; disk space OK.", ...passedAt(1, 45) },
      { changeId, order: 2, name: "Pre-change backup", type: "BACKUP", status: "PASSED", output: "SFOS config exported and encrypted at rest; SHA-256 verified.", ...passedAt(2, 43) },
      { changeId, order: 3, name: "Install SFOS 19.5 MR2 (primary)", type: "APPLY", status: "RUNNING", output: "Firmware staged (68%); HA traffic passing through secondary.", startedAt: ago(20) },
      { changeId, order: 4, name: "Post-upgrade validation", type: "VALIDATE", status: "PENDING" },
      { changeId, order: 5, name: "Auto-rollback to MR1 (on failure)", type: "ROLLBACK", status: "PENDING" },
    ];
  }
  return [
    { changeId, order: 1, name: "Pre-flight checks", type: "CHECK", status: "PENDING" },
    { changeId, order: 2, name: "Pre-change backup", type: "BACKUP", status: "PENDING" },
    { changeId, order: 3, name: "Apply configuration", type: "APPLY", status: "PENDING" },
    { changeId, order: 4, name: "Post-change validation", type: "VALIDATE", status: "PENDING" },
    { changeId, order: 5, name: "Auto-rollback (on failure)", type: "ROLLBACK", status: "PENDING" },
  ];
}

async function seedChanges() {
  const checksPassed = JSON.stringify([
    { name: "Config unchanged since approval", status: "PASSED" },
    { name: "Device reachable via mgmt VRF", status: "PASSED" },
    { name: "No active SEV1/SEV2 incident on target", status: "PASSED" },
  ]);
  const checksPending = JSON.stringify([
    { name: "Config unchanged since approval", status: "PENDING" },
    { name: "Device reachable via mgmt VRF", status: "PENDING" },
    { name: "No active SEV1/SEV2 incident on target", status: "PENDING" },
  ]);

  const changes = [
    {
      id: "chg-2026-00401", number: "CHG-2026-00401", title: "Upgrade HQ-Access-SW-02 firmware to AOS-CX 10.13.0008",
      description: "Rolling firmware upgrade for HQ access switches; first target is HQ-Access-SW-02 (maintenance window required).",
      type: "NORMAL", status: "DRAFT", riskScore: 28, riskLevel: "MEDIUM",
      requesterId: "usr-engineer1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-hq-san",
      scheduledStart: null, scheduledEnd: null,
      implementationPlan: "Download image to USB, stage via OOBM, reboot standby management module first.",
      validationPlan: "Post-upgrade: verify PoE budget, LAG membership, DHCP relay.",
      rollbackPlan: "Boot from secondary partition (10.10.1070) and re-apply baseline.",
      preChecksJson: checksPending, createdAtMin: 1440,
    },
    {
      id: "chg-2026-00402", number: "CHG-2026-00402", title: "Add VLAN 70 (VOIP-DC) to DC-SRV-TOR uplinks",
      description: "Provision VLAN 70 for the new DC telephony cluster across both ToR switches.",
      type: "STANDARD", status: "DRAFT", riskScore: 18, riskLevel: "LOW",
      requesterId: "usr-engineer1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-dc-adn",
      scheduledStart: null, scheduledEnd: null,
      implementationPlan: "Add vlan 70, name VOIP-DC, extend trunk allowed list on lag1 and 1/1/49.",
      validationPlan: "Ping SVI from ToR pair; verify trunk allowed list via show vlan.",
      rollbackPlan: "Remove vlan 70 from trunk allowed list and delete VLAN definition.",
      preChecksJson: checksPending, createdAtMin: 2880,
    },
    {
      id: "chg-2026-00403", number: "CHG-2026-00403", title: "Planned HA failover — HQ-WAN-FW-01 to secondary",
      description: "Replace HA primary FortiGate 600F (fan tray RMA). Planned failover to HQ-WAN-FW-02 before shutdown.",
      type: "NORMAL", status: "AWAITING_APPROVAL", riskScore: 65, riskLevel: "HIGH",
      requesterId: "usr-engineer1", ownerId: "usr-admin", technicalOwnerId: "usr-engineer1", siteId: "site-hq-san",
      scheduledStart: ahead(4320), scheduledEnd: ahead(5760),
      implementationPlan: "1) Verify HA sync healthy. 2) set ha priority secondary higher. 3) Graceful failover. 4) Shutdown primary, replace fan tray, reboot, restore priority.",
      validationPlan: "Session count parity check; UTM throughput baseline; no dropped conversations > 0.1%.",
      rollbackPlan: "Revert priority and fail back; if sync broken, force secondary offline and run standalone on primary.",
      preChecksJson: checksPending, createdAtMin: 240,
    },
    {
      id: "chg-2026-00404", number: "CHG-2026-00404", title: "Enable NetFlow egress sampling on DC-Core-SW-01",
      description: "Configure flow exporter to FayaNMS collector (10.30.10.9:2055) with 1:1024 sampling on uplink interfaces.",
      type: "STANDARD", status: "AWAITING_APPROVAL", riskScore: 30, riskLevel: "MEDIUM",
      requesterId: "usr-engineer1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-dc-adn",
      scheduledStart: ahead(2880), scheduledEnd: ahead(3600),
      implementationPlan: "feature netflow; flow exporter FAYA-NMS; apply egress sampler to Eth1/1-1/3.",
      validationPlan: "Collector receives flows (>100 records/s); control-plane CPU delta < 3%.",
      rollbackPlan: "Remove sampler from interfaces and delete exporter definition.",
      preChecksJson: checksPending, createdAtMin: 1500,
    },
    {
      id: "chg-2026-00405", number: "CHG-2026-00405", title: "Quarterly DR failover exercise — DC-Aden core",
      description: "Simulated WAN failure at DC-Aden: verify BGP convergence and SD-WAN overlay failover per DR runbook v2.3.",
      type: "NORMAL", status: "SCHEDULED", riskScore: 55, riskLevel: "HIGH",
      requesterId: "usr-engineer1", ownerId: "usr-admin", technicalOwnerId: "usr-engineer1", siteId: "site-dc-adn",
      scheduledStart: ahead(8640), scheduledEnd: ahead(9720),
      implementationPlan: "Inject BGP shutdown on DC-Core-RTR-01 transit, observe convergence, restore after 15 min.",
      validationPlan: "Convergence < 60 s; VoIP MOS > 4.0 during test; logging capture for post-review.",
      rollbackPlan: "no shutdown on transit peer; verify full mesh re-convergence.",
      preChecksJson: checksPending, createdAtMin: 7200,
    },
    {
      id: "chg-2026-00406", number: "CHG-2026-00406", title: "Patch BR2-FW-01 to SFOS 19.5 MR2",
      description: "Security patch install on BR2-FW-01 with HA-style staged upgrade; traffic via tunnel during reboot.",
      type: "STANDARD", status: "EXECUTING", riskScore: 48, riskLevel: "MEDIUM",
      requesterId: "usr-engineer1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-br2-muk",
      scheduledStart: ago(50), scheduledEnd: ahead(70),
      implementationPlan: "Stage firmware, reboot into MR2, monitor WAN tunnel and policy counters.",
      validationPlan: "Tunnel10 up; NAT pools active; throughput within 10% of baseline.",
      rollbackPlan: "Boot previous partition (19.5 MR1) and restore last encrypted config backup.",
      preChecksJson: checksPassed, createdAtMin: 2880,
    },
    {
      id: "chg-2026-00407", number: "CHG-2026-00407", title: "Deploy WAN QoS policy on HQ-Core-RTR-01",
      description: "Deploy 5-class egress QoS (voice priority 30%, critical 50% remaining) on ISP-A transit.",
      type: "STANDARD", status: "CLOSED", riskScore: 35, riskLevel: "MEDIUM",
      requesterId: "usr-engineer1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-hq-san",
      scheduledStart: ago(13000), scheduledEnd: ago(12700),
      implementationPlan: "Apply WAN-QOS-PARENT to Gi0/0/0; verify class maps match DSCP EF/CS3.",
      validationPlan: "show policy-map interface counters; VoIP MOS probe > 4.2 under load.",
      rollbackPlan: "no service-policy output WAN-QOS-PARENT on Gi0/0/0.",
      preChecksJson: checksPassed, createdAtMin: 15120,
    },
    {
      id: "chg-2026-00408", number: "CHG-2026-00408", title: "Add camera VLAN 30 on HQ-Access-SW-01",
      description: "Provision VLAN 30 (CAMERA) and enable PoE on camera ports per security rollout phase 2.",
      type: "STANDARD", status: "CLOSED", riskScore: 22, riskLevel: "MEDIUM",
      requesterId: "usr-noc1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-hq-san",
      scheduledStart: ago(42500), scheduledEnd: ago(42400),
      implementationPlan: "Add vlan 30 CAMERA, extend lag1 trunk allowed list, enable PoE on 1/1/5.",
      validationPlan: "Camera stream visible from VMS; PoE draw < budget.",
      rollbackPlan: "Remove VLAN 30 from trunk and delete definition.",
      preChecksJson: checksPassed, createdAtMin: 43200,
    },
    {
      id: "chg-2026-00409", number: "CHG-2026-00409", title: "Tune BGP timers on DC-Edge-RTR-01",
      description: "Apply BFD-enabled timers (3x9) to transit peers for faster failover detection.",
      type: "STANDARD", status: "CLOSED", riskScore: 40, riskLevel: "MEDIUM",
      requesterId: "usr-engineer1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-dc-adn",
      scheduledStart: ago(20000), scheduledEnd: ago(19900),
      implementationPlan: "neighbor X timers 3 9 + bfd on both transit peers.",
      validationPlan: "BFD session up; failover drill < 9 s; no route churn in core.",
      rollbackPlan: "Restore default timers and remove BFD.",
      preChecksJson: checksPassed, createdAtMin: 20500,
    },
    {
      id: "chg-2026-00410", number: "CHG-2026-00410", title: "Upgrade BR1-Access-SW-01 IOS to 15.2(7)E4",
      description: "Deferred-maintenance upgrade for aging 2960X stack; rolled back after post-upgrade validation failure.",
      type: "NORMAL", status: "ROLLBACK", riskScore: 52, riskLevel: "HIGH",
      requesterId: "usr-engineer1", ownerId: "usr-engineer1", technicalOwnerId: "usr-engineer1", siteId: "site-br1-hod",
      scheduledStart: ago(420), scheduledEnd: ago(360),
      implementationPlan: "Stage E4 image, verify checksum, reload, monitor PoE members.",
      validationPlan: "All 48 ports up, PoE draw nominal, uplink Trk1 stable for 10 min.",
      rollbackPlan: "Boot system flash:2960x-universalk9-mz.152-7.E3.bin; restore config.",
      preChecksJson: checksPassed, createdAtMin: 4400,
    },
  ];

  for (const c of changes) {
    await db.changeRequest.create({
      data: {
        id: c.id,
        number: c.number,
        title: c.title,
        description: c.description,
        type: c.type,
        status: c.status,
        riskScore: c.riskScore,
        riskLevel: c.riskLevel,
        requesterId: c.requesterId,
        ownerId: c.ownerId,
        technicalOwnerId: c.technicalOwnerId,
        siteId: c.siteId,
        scheduledStart: c.scheduledStart,
        scheduledEnd: c.scheduledEnd,
        implementationPlan: c.implementationPlan,
        validationPlan: c.validationPlan,
        rollbackPlan: c.rollbackPlan,
        preChecksJson: c.preChecksJson,
        createdAt: ago(c.createdAtMin),
        updatedAt: ago(Math.min(c.createdAtMin, 60)),
      },
    });
  }

  // Target devices
  const changeDevices: Array<[string, string, string | null]> = [
    ["chg-2026-00401", "dev-hq-access-sw-02", "PENDING"],
    ["chg-2026-00402", "dev-dc-srv-tor-01", "PENDING"],
    ["chg-2026-00402", "dev-dc-srv-tor-02", "PENDING"],
    ["chg-2026-00403", "dev-hq-wan-fw-01", "PENDING"],
    ["chg-2026-00403", "dev-hq-wan-fw-02", "PENDING"],
    ["chg-2026-00404", "dev-dc-core-sw-01", "PENDING"],
    ["chg-2026-00405", "dev-dc-core-rtr-01", "PENDING"],
    ["chg-2026-00405", "dev-dc-core-sw-01", "PENDING"],
    ["chg-2026-00405", "dev-dc-fw-01", "PENDING"],
    ["chg-2026-00406", "dev-br2-fw-01", "PENDING"],
    ["chg-2026-00407", "dev-hq-core-rtr-01", "SUCCESS"],
    ["chg-2026-00408", "dev-hq-access-sw-01", "SUCCESS"],
    ["chg-2026-00409", "dev-dc-edge-rtr-01", "SUCCESS"],
    ["chg-2026-00410", "dev-br1-access-sw-01", "FAILED"],
  ];
  await db.changeDevice.createMany({
    data: changeDevices.map(([changeId, deviceId, result]) => ({ changeId, deviceId, result })),
  });

  // Steps
  await db.changeStep.createMany({ data: changeStepsFor("chg-2026-00406", "running", 45) });
  await db.changeStep.createMany({ data: changeStepsFor("chg-2026-00407", "full", 13000) });
  await db.changeStep.createMany({ data: changeStepsFor("chg-2026-00408", "full", 42500) });
  await db.changeStep.createMany({ data: changeStepsFor("chg-2026-00409", "full", 20000) });
  await db.changeStep.createMany({ data: changeStepsFor("chg-2026-00410", "rollback", 420) });
  await db.changeStep.createMany({ data: changeStepsFor("chg-2026-00405", "scheduled", 8640) });

  // Approvals (unique per change+level)
  const approvals: Array<{ changeId: string; level: string; status: string; approverId?: string; decidedAt?: Date; comment?: string }> = [
    { changeId: "chg-2026-00403", level: "TECHNICAL", status: "PENDING" },
    { changeId: "chg-2026-00403", level: "MANAGER", status: "PENDING" },
    { changeId: "chg-2026-00404", level: "TECHNICAL", status: "PENDING" },
    { changeId: "chg-2026-00405", level: "TECHNICAL", status: "APPROVED", approverId: "usr-admin", decidedAt: ago(5760), comment: "Exercise plan reviewed; rollback verified in last drill." },
    { changeId: "chg-2026-00405", level: "MANAGER", status: "APPROVED", approverId: "usr-manager1", decidedAt: ago(5500), comment: "Approved — DR drill per Q2 schedule." },
    { changeId: "chg-2026-00406", level: "TECHNICAL", status: "APPROVED", approverId: "usr-admin", decidedAt: ago(1500), comment: "Pre-checks attached; staged upgrade acceptable." },
    { changeId: "chg-2026-00406", level: "MANAGER", status: "APPROVED", approverId: "usr-manager1", decidedAt: ago(1440), comment: "Approved. Keep branch helpdesk informed." },
    { changeId: "chg-2026-00407", level: "TECHNICAL", status: "APPROVED", approverId: "usr-admin", decidedAt: ago(15120), comment: "QoS model validated in lab." },
    { changeId: "chg-2026-00407", level: "MANAGER", status: "APPROVED", approverId: "usr-manager1", decidedAt: ago(14880), comment: "Approved for Saturday window." },
    { changeId: "chg-2026-00408", level: "TECHNICAL", status: "APPROVED", approverId: "usr-admin", decidedAt: ago(43200) },
    { changeId: "chg-2026-00408", level: "MANAGER", status: "APPROVED", approverId: "usr-manager1", decidedAt: ago(43000), comment: "Security phase 2 rollout." },
    { changeId: "chg-2026-00409", level: "TECHNICAL", status: "APPROVED", approverId: "usr-admin", decidedAt: ago(20500) },
    { changeId: "chg-2026-00409", level: "MANAGER", status: "APPROVED", approverId: "usr-manager1", decidedAt: ago(20200) },
    { changeId: "chg-2026-00410", level: "TECHNICAL", status: "APPROVED", approverId: "usr-admin", decidedAt: ago(4400), comment: "PoE compatibility check attached." },
    { changeId: "chg-2026-00410", level: "MANAGER", status: "APPROVED", approverId: "usr-manager1", decidedAt: ago(4350), comment: "Approved with mandatory post-validation." },
  ];
  await db.changeApproval.createMany({ data: approvals });
}

async function seedIncidentsAndAlerts() {
  /* Incidents */
  await db.incident.createMany({
    data: [
      {
        id: "inc-2026-00101", number: "INC-2026-00101",
        title: "BGP peer 203.0.113.1 (ISP-A) down on HQ-Edge-RTR-01",
        description: "Transit session to ISP-A dropped at 09:20 AST. Traffic failing over via ISP-B SD-WAN overlay; capacity reduced.",
        severity: "SEV1", priority: "P1", status: "INVESTIGATING", source: "ALERT",
        siteId: "site-hq-san", ownerTeam: "NOC-Core", ownerId: "usr-noc1",
        slaDueAt: ahead(20), acknowledgedAt: ago(34), createdAt: ago(40), updatedAt: ago(12),
      },
      {
        id: "inc-2026-00102", number: "INC-2026-00102",
        title: "Sustained high CPU on DC-DMZ-FW-01 (HA secondary active)",
        description: "Sophos XGS 3300 pegged at 85-97% CPU since HA failover; UTM scanning without offload.",
        severity: "SEV2", priority: "P2", status: "ACKNOWLEDGED", source: "ALERT",
        siteId: "site-dc-adn", ownerTeam: "Network-Security", ownerId: "usr-engineer1",
        slaDueAt: ahead(290), acknowledgedAt: ago(120), createdAt: ago(190), updatedAt: ago(60),
      },
      {
        id: "inc-2026-00103", number: "INC-2026-00103",
        title: "Nightly config backup failing for HQ-IDF-SW-01",
        description: "Backup job dead after 3 attempts (SSH timeout). Device offline since IDF power maintenance.",
        severity: "SEV3", priority: "P3", status: "ASSIGNED", source: "FAILED_BACKUP",
        siteId: "site-hq-san", ownerTeam: "NOC-Core", ownerId: "usr-noc1",
        slaDueAt: ahead(840), createdAt: ago(600), updatedAt: ago(240),
      },
      {
        id: "inc-2026-00104", number: "INC-2026-00104",
        title: "Configuration drift detected on HQ-Access-SW-01",
        description: "Two open drift records vs approved baseline v3: unauthorized VLAN 55 and changed uplink description on 1/1/24.",
        severity: "SEV3", priority: "P3", status: "NEW", source: "DRIFT",
        siteId: "site-hq-san", ownerTeam: "NetEng",
        slaDueAt: ahead(770), createdAt: ago(70), updatedAt: ago(70),
      },
      {
        id: "inc-2026-00105", number: "INC-2026-00105",
        title: "BR1-Access-SW-01 unreachable after IOS upgrade (CHG-2026-00410)",
        description: "Validation failed post-boot; auto-rollback executed by change engine. Device restored to 15.2(7)E3.",
        severity: "SEV3", priority: "P3", status: "RESOLVED", source: "FAILED_CHANGE",
        siteId: "site-br1-hod", ownerTeam: "NetEng", ownerId: "usr-engineer1", changeId: "chg-2026-00410",
        slaDueAt: ago(240), acknowledgedAt: ago(395), resolvedAt: ago(370),
        rootCause: "New image booted with incompatible PoE controller microcode; switch hung during post-init and stopped responding to SSH/ICMP.",
        correctiveAction: "Auto-rollback to 15.2(7)E3 executed by the change engine; device stabilized and uplink restored.",
        preventiveAction: "Added pre-check to validate PoE microcode compatibility matrix before any image push to 2960X platforms.",
        createdAt: ago(400), updatedAt: ago(370),
      },
      {
        id: "inc-2026-00106", number: "INC-2026-00106",
        title: "FortiGate HA sync degraded between HQ-WAN-FW-01/02",
        description: "HA sync sequence gaps and CRC errors on heartbeat port3; config sync lagging > 5 min.",
        severity: "SEV2", priority: "P2", status: "CLOSED", source: "SNMP_TRAP",
        siteId: "site-hq-san", ownerTeam: "Network-Security", ownerId: "usr-engineer1",
        slaDueAt: ago(5700), acknowledgedAt: ago(5990), resolvedAt: ago(5800), closedAt: ago(5600),
        rootCause: "Dirty fiber patch lead on HA heartbeat port3; CRC error rate > 1e-4 caused repeated heartbeat misses.",
        correctiveAction: "Cleaned and re-seated SFP on port3 on both members; HA sync instant and session counts normalized.",
        preventiveAction: "Added weekly optical-level check to preventive maintenance schedule; new alert rule for HA sync failures.",
        createdAt: ago(6000), updatedAt: ago(5600),
      },
    ],
  });

  await db.incidentDevice.createMany({
    data: [
      { incidentId: "inc-2026-00101", deviceId: "dev-hq-edge-rtr-01" },
      { incidentId: "inc-2026-00102", deviceId: "dev-dc-dmz-fw-01" },
      { incidentId: "inc-2026-00103", deviceId: "dev-hq-idf-sw-01" },
      { incidentId: "inc-2026-00104", deviceId: "dev-hq-access-sw-01" },
      { incidentId: "inc-2026-00105", deviceId: "dev-br1-access-sw-01" },
      { incidentId: "inc-2026-00106", deviceId: "dev-hq-wan-fw-01" },
      { incidentId: "inc-2026-00106", deviceId: "dev-hq-wan-fw-02" },
    ],
  });

  await db.incidentEvent.createMany({
    data: [
      { incidentId: "inc-2026-00101", kind: "SYSTEM", message: "Alert 'BGP neighbor 203.0.113.9 DOWN' matched correlation policy — incident auto-created (SEV1, SLA 4h).", createdAt: ago(40) },
      { incidentId: "inc-2026-00101", kind: "USER", actorId: "usr-noc1", message: "Acknowledged. NOC engaging ISP-A; verifying overlay failover capacity.", createdAt: ago(34) },
      { incidentId: "inc-2026-00101", kind: "SYSTEM", message: "3 recurring alert events correlated into this incident.", createdAt: ago(30) },
      { incidentId: "inc-2026-00101", kind: "USER", actorId: "usr-noc1", message: "ISP-A reporting fiber maintenance extension; failover holding, latency +12 ms. Investigating permanent reroute.", createdAt: ago(12) },
      { incidentId: "inc-2026-00102", kind: "SYSTEM", message: "Alert 'CPU ≥ 95% for 5m' crossed escalation threshold — SEV2 incident created.", createdAt: ago(190) },
      { incidentId: "inc-2026-00102", kind: "USER", actorId: "usr-engineer1", message: "Acknowledged. HA secondary active since fiber work; scheduling traffic shift back to primary.", createdAt: ago(120) },
      { incidentId: "inc-2026-00103", kind: "SYSTEM", message: "Backup job JOB-A22E41 failed after 3 attempts (SSH connect timeout).", createdAt: ago(610) },
      { incidentId: "inc-2026-00103", kind: "USER", actorId: "usr-noc1", message: "Assigned to NOC; facility ticket opened for IDF closet power.", createdAt: ago(240) },
      { incidentId: "inc-2026-00104", kind: "SYSTEM", message: "Drift engine found 2 open records vs baseline v3 (VLAN 55; interface 1/1/24 description).", createdAt: ago(70) },
      { incidentId: "inc-2026-00105", kind: "SYSTEM", message: "Change CHG-2026-00410 step 4 (validation) FAILED — auto-rollback triggered.", createdAt: ago(393) },
      { incidentId: "inc-2026-00105", kind: "SYSTEM", message: "Rollback PASSED — device back on 15.2(7)E3, uplink restored.", createdAt: ago(388) },
      { incidentId: "inc-2026-00105", kind: "USER", actorId: "usr-engineer1", message: "Root cause identified: PoE microcode incompatibility on E4 image. RCA attached.", createdAt: ago(372) },
      { incidentId: "inc-2026-00105", kind: "INTEGRATION", message: "Webhook delivered to #netops Slack channel (delivery OK).", createdAt: ago(371) },
      { incidentId: "inc-2026-00106", kind: "SYSTEM", message: "SNMP trap fgVpnHaSequenceGap received from HQ-WAN-FW-01.", createdAt: ago(6000) },
      { incidentId: "inc-2026-00106", kind: "USER", actorId: "usr-engineer1", message: "Acknowledged; field team dispatched to MDF for fiber inspection.", createdAt: ago(5990) },
      { incidentId: "inc-2026-00106", kind: "USER", actorId: "usr-engineer1", message: "SFPs cleaned/re-seated; CRC rate back to baseline. Resolved.", createdAt: ago(5800) },
      { incidentId: "inc-2026-00106", kind: "USER", actorId: "usr-manager1", message: "PIR approved and closed. Preventive check added to PM schedule.", createdAt: ago(5600) },
    ],
  });

  /* Alert rules */
  await db.alertRule.createMany({
    data: [
      { id: "rule-cpu-critical", name: "CPU Critical", metric: "CPU", operator: "GT", threshold: 95, durationMinutes: 5, severity: "CRITICAL", scopeJson: JSON.stringify({ excludeStatuses: ["OFFLINE", "UNMANAGED"] }), isActive: true },
      { id: "rule-util-high", name: "Link Utilization High", metric: "UTILIZATION_IN", operator: "GTE", threshold: 90, durationMinutes: 15, severity: "HIGH", scopeJson: JSON.stringify({}), isActive: true },
      { id: "rule-device-down", name: "Device Unreachable", metric: "AVAILABILITY", operator: "LT", threshold: 1, durationMinutes: 3, severity: "HIGH", scopeJson: JSON.stringify({ criticality: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] }), isActive: true },
    ],
  });

  /* Alerts */
  await db.alert.createMany({
    data: [
      { id: "alert-01", deviceId: "dev-hq-edge-rtr-01", severity: "CRITICAL", message: "BGP neighbor 203.0.113.1 (ISP-A) state changed to DOWN", status: "ACTIVE", firstSeen: ago(41), lastSeen: ago(11), count: 3, incidentId: "inc-2026-00101" },
      { id: "alert-02", deviceId: "dev-dc-dmz-fw-01", ruleId: "rule-cpu-critical", severity: "HIGH", message: "CPU utilization 97% (≥95% for 5m) — HA secondary active, UTM without offload", status: "ACTIVE", firstSeen: ago(200), lastSeen: ago(5), count: 14, incidentId: "inc-2026-00102" },
      { id: "alert-03", deviceId: "dev-hq-idf-sw-01", ruleId: "rule-device-down", severity: "HIGH", message: "Device unreachable — 9 consecutive failed polls (ICMP + SNMP)", status: "ACTIVE", firstSeen: ago(620), lastSeen: ago(20), count: 9, dedupKey: "dev-hq-idf-sw-01:AVAILABILITY:rule-device-down" },
      { id: "alert-04", deviceId: "dev-hq-core-sw-01", ruleId: "rule-util-high", severity: "HIGH", message: "Utilization_in 94.2% on Te1/1/1 (≥90% for 15m)", status: "ACTIVE", firstSeen: ago(90), lastSeen: ago(10), count: 4 },
      { id: "alert-05", deviceId: "dev-br1-edge-rtr-01", severity: "MEDIUM", message: "Latency 128 ms to probe target (threshold 100 ms)", status: "ACTIVE", firstSeen: ago(240), lastSeen: ago(15), count: 6 },
      { id: "alert-06", deviceId: "dev-br2-edge-rtr-01", severity: "MEDIUM", message: "Packet loss 3.8% on WAN uplink Gi0/0/0", status: "ACTIVE", firstSeen: ago(300), lastSeen: ago(25), count: 5 },
      { id: "alert-07", deviceId: "dev-hq-idf-sw-01", severity: "MEDIUM", message: "Config backup failed after 3 attempts (SSH timeout)", status: "ACTIVE", firstSeen: ago(610), lastSeen: ago(10), count: 3, incidentId: "inc-2026-00103" },
      { id: "alert-08", deviceId: "dev-dc-srv-tor-01", severity: "LOW", message: "Chassis temperature 58 °C (warning threshold 55 °C)", status: "ACTIVE", firstSeen: ago(150), lastSeen: ago(30), count: 2 },
      { id: "alert-09", deviceId: "dev-br1-access-sw-01", ruleId: "rule-cpu-critical", severity: "HIGH", message: "CPU utilization 96% on aging Catalyst 2960X (IP processes)", status: "ACKNOWLEDGED", firstSeen: ago(400), lastSeen: ago(60), count: 8, acknowledgedById: "usr-noc1", acknowledgedAt: ago(100) },
      { id: "alert-10", deviceId: "dev-dc-fw-01", severity: "MEDIUM", message: "Session count 1.42M approaching license ceiling (1.5M)", status: "ACKNOWLEDGED", firstSeen: ago(500), lastSeen: ago(35), count: 7, acknowledgedById: "usr-noc1", acknowledgedAt: ago(30) },
      { id: "alert-11", deviceId: "dev-br2-access-sw-01", severity: "LOW", message: "Link flap on 1/1/6 — suppressed by maintenance window MW-2026-011", status: "SUPPRESSED", firstSeen: ago(80), lastSeen: ago(20), count: 4, suppressReason: "Maintenance window: BR2-Access-SW-01 firmware prep (MW-2026-011)" },
      // Task 5-a grouping demo: dependent alert suppressed by the device-down root (alert-03).
      { id: "alert-13", deviceId: "dev-hq-idf-sw-01", ruleId: "rule-util-high", severity: "HIGH", message: "Utilization_in 100% on uplink Te1/1/1 (device unreachable — likely root cause: device down)", status: "SUPPRESSED", firstSeen: ago(615), lastSeen: ago(20), count: 6, dedupKey: "dev-hq-idf-sw-01:UTILIZATION_IN:rule-util-high", parentAlertId: "alert-03", suppressReason: "Suppressed by root alert: alert-03 (Device unreachable)" },
      { id: "alert-12", deviceId: "dev-hq-wan-fw-01", severity: "MEDIUM", message: "HA sync sequence gaps detected on heartbeat port3", status: "RESOLVED", firstSeen: ago(5900), lastSeen: ago(5810), count: 11, incidentId: "inc-2026-00106" },
    ],
  });
}

async function seedNotifications() {
  await db.notification.createMany({
    data: [
      { kind: "INCIDENT", severity: "SEV1", title: "SEV1 incident — BGP peer down (HQ-Edge-RTR-01)", body: "INC-2026-00101 auto-created from a CRITICAL alert. SLA due in ~1 h — needs an owner.", link: "ops.incidents", createdAt: ago(40) },
      { kind: "ALERT", severity: "CRITICAL", title: "CRITICAL alert — BGP neighbor 203.0.113.1 DOWN", body: "Fired on HQ-Edge-RTR-01 by rule “Device unreachable”. Root alert — dependent alerts suppressed.", link: "ops.alerts", createdAt: ago(41) },
      { kind: "CHANGE", title: "Approval requested — CHG-2026-00403", body: "Technical approval requested by Layla Hassan (network engineer). Risk score 18 — low.", link: "changes.approvals", readAt: ago(20), createdAt: ago(48) },
      { kind: "ALERT", severity: "HIGH", title: "Device unreachable — HQ-IDF-SW-01", body: "9 consecutive failed polls. Root alert grouping is active — dependent alerts are suppressed while the device is down.", link: "ops.alerts", createdAt: ago(600) },
      { kind: "JOB", title: "Nightly backup failed — HQ-IDF-SW-01", body: "CONFIG_BACKUP failed after 3 attempts (SSH timeout). Retry is queued; incident INC-2026-00103 tracks the impact.", link: "ops.jobs", readAt: ago(30), createdAt: ago(300) },
      { kind: "SYSTEM", title: "Weekly availability report ready", body: "The Availability & Capacity weekly report finished generating and is ready to download.", link: "reports.reports", readAt: ago(10), createdAt: ago(12) },
    ],
  });
}

async function seedMaintenance() {
  await db.maintenanceWindow.createMany({
    data: [
      { id: "mw-2026-011", name: "BR2-Access-SW-01 firmware prep (MW-2026-011)", siteId: "site-br2-muk", deviceId: "dev-br2-access-sw-01", startsAt: ago(120), endsAt: ahead(360), reason: "AOS-CX 10.10 → 10.13 upgrade prep; alert suppression active.", isActive: true },
      { id: "mw-2026-009", name: "HQ-Core-SW-01 linecard microcode check (MW-2026-009)", siteId: "site-hq-san", deviceId: "dev-hq-core-sw-01", startsAt: ago(28800), endsAt: ago(27600), reason: "Preventive microcode verification during low-traffic window.", isActive: false },
    ],
  });
}

async function seedJobs() {
  const jobs = [
    { id: "job-001", type: "METRIC_POLL", status: "RUNNING", progress: 60, priority: 5, targetType: "SYSTEM", payloadJson: JSON.stringify({ window: "5m", devices: 24 }), startedAt: ago(2), createdAt: ago(2), attempts: 1 },
    { id: "job-002", type: "CONFIG_BACKUP", status: "SUCCEEDED", progress: 100, priority: 5, targetType: "DEVICE", targetId: "dev-br2-fw-01", payloadJson: JSON.stringify({ changeNumber: "CHG-2026-00406", phase: "PRE_CHANGE" }), resultJson: JSON.stringify({ sizeBytes: 142190, sha256Ok: true }), startedAt: ago(44), finishedAt: ago(43), createdAt: ago(44), attempts: 1 },
    { id: "job-003", type: "CONFIG_APPLY", status: "RUNNING", progress: 68, priority: 3, targetType: "DEVICE", targetId: "dev-br2-fw-01", payloadJson: JSON.stringify({ changeNumber: "CHG-2026-00406", step: 3, action: "INSTALL_SFOS_19_5_MR2" }), startedAt: ago(20), createdAt: ago(50), attempts: 1 },
    { id: "job-004", type: "DISCOVERY", status: "SUCCEEDED", progress: 100, priority: 5, targetType: "SYSTEM", payloadJson: JSON.stringify({ subnets: ["10.50.0.0/24"], methods: ["SNMP", "CDP"] }), resultJson: JSON.stringify({ candidatesFound: 3, imported: 0 }), startedAt: ago(480), finishedAt: ago(462), createdAt: ago(480), attempts: 1 },
    { id: "job-005", type: "INVENTORY_POLL", status: "SUCCEEDED", progress: 100, priority: 7, targetType: "SYSTEM", resultJson: JSON.stringify({ devicesPolled: 26, stateChanges: 1 }), startedAt: ago(90), finishedAt: ago(84), createdAt: ago(90), attempts: 1 },
    { id: "job-006", type: "CONFIG_BACKUP", status: "FAILED", progress: 30, priority: 5, targetType: "DEVICE", targetId: "dev-hq-idf-sw-01", error: "SSH connection timed out after 30 s (device state: OFFLINE)", startedAt: ago(615), finishedAt: ago(605), createdAt: ago(615), attempts: 3, maxAttempts: 3 },
    { id: "job-007", type: "CONFIG_BACKUP", status: "SUCCEEDED", progress: 100, priority: 5, targetType: "DEVICE", targetId: "dev-hq-access-sw-01", payloadJson: JSON.stringify({ policy: "Daily Full Fleet 02:00" }), resultJson: JSON.stringify({ snapshotId: "snap-hq-access-sw-01-v5", version: 5 }), startedAt: ago(1445), finishedAt: ago(1440), createdAt: ago(1445), attempts: 1 },
    { id: "job-008", type: "CONFIG_BACKUP", status: "SUCCEEDED", progress: 100, priority: 5, targetType: "DEVICE", targetId: "dev-hq-wlc-01", payloadJson: JSON.stringify({ policy: "Daily Full Fleet 02:00" }), resultJson: JSON.stringify({ note: "succeeded before device entered backup-overdue state" }), startedAt: ago(1460), finishedAt: ago(1454), createdAt: ago(1460), attempts: 1 },
    { id: "job-009", type: "METRIC_POLL", status: "SUCCEEDED", progress: 100, priority: 7, targetType: "SYSTEM", resultJson: JSON.stringify({ samplesWritten: 96, devicesPolled: 24 }), startedAt: ago(62), finishedAt: ago(58), createdAt: ago(62), attempts: 1 },
    { id: "job-010", type: "VALIDATION", status: "QUEUED", progress: 0, priority: 3, targetType: "DEVICE", targetId: "dev-br2-fw-01", payloadJson: JSON.stringify({ changeNumber: "CHG-2026-00406", step: 4 }), scheduledAt: ahead(10), createdAt: ago(50), attempts: 0 },
    { id: "job-011", type: "REPORT_GENERATION", status: "SUCCEEDED", progress: 100, priority: 8, targetType: "SYSTEM", payloadJson: JSON.stringify({ reportType: "BACKUP_COMPLIANCE" }), resultJson: JSON.stringify({ rows: 26, format: "XLSX" }), startedAt: ago(700), finishedAt: ago(697), createdAt: ago(700), attempts: 1 },
    { id: "job-012", type: "CONFIG_BACKUP", status: "QUEUED", progress: 0, priority: 5, targetType: "SYSTEM", payloadJson: JSON.stringify({ policy: "Daily Full Fleet 02:00" }), scheduledAt: ahead(120), createdAt: ago(30), attempts: 0 },
    { id: "job-013", type: "NOTIFICATION", status: "SUCCEEDED", progress: 100, priority: 6, targetType: "SYSTEM", payloadJson: JSON.stringify({ channel: "email", event: "alert.high_cpu", recipients: 3 }), resultJson: JSON.stringify({ delivered: 3 }), startedAt: ago(200), finishedAt: ago(199), createdAt: ago(200), attempts: 1 },
    { id: "job-014", type: "DISCOVERY", status: "RUNNING", progress: 30, priority: 5, targetType: "SYSTEM", payloadJson: JSON.stringify({ subnets: ["10.40.0.0/24", "10.50.0.0/24"] }), startedAt: ago(35), createdAt: ago(35), attempts: 1 },
    { id: "job-015", type: "INVENTORY_POLL", status: "SUCCEEDED", progress: 100, priority: 7, targetType: "SYSTEM", resultJson: JSON.stringify({ devicesPolled: 26, stateChanges: 0 }), startedAt: ago(1000), finishedAt: ago(994), createdAt: ago(1000), attempts: 1 },
  ];
  await db.jobExecution.createMany({
    data: jobs.map((j, i) => ({ ...j, correlationId: jobCorr(i + 1) })),
  });
}

async function seedAudit() {
  const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) FayaNMS/1.0";
  type AuditRow = {
    actorId?: string; actorName: string; action: string; resourceType: string;
    resourceId?: string; resourceLabel?: string; result: string; ip?: string; userAgent?: string;
    correlationId?: string; beforeJson?: string; afterJson?: string; createdAt: Date;
  };
  const rows: AuditRow[] = [];
  const add = (r: AuditRow) => rows.push(r);

  add({ actorId: "usr-admin", actorName: "Amal Al-Sabri", action: "DEVICE_CREATED", resourceType: "Device", resourceId: "dev-hq-core-rtr-01", resourceLabel: "HQ-Core-RTR-01", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, afterJson: JSON.stringify({ hostname: "HQ-Core-RTR-01", mgmtIp: "10.20.255.1", vendor: "cisco" }), createdAt: ago(43200) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "DEVICE_CREATED", resourceType: "Device", resourceId: "dev-hq-core-sw-01", resourceLabel: "HQ-Core-SW-01", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, afterJson: JSON.stringify({ hostname: "HQ-Core-SW-01", mgmtIp: "10.20.255.3", vendor: "cisco" }), createdAt: ago(36100) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "DEVICE_CREATED", resourceType: "Device", resourceId: "dev-dc-core-rtr-01", resourceLabel: "DC-Core-RTR-01", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, afterJson: JSON.stringify({ hostname: "DC-Core-RTR-01", mgmtIp: "10.30.255.1", vendor: "cisco" }), createdAt: ago(36200) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "DEVICE_CREATED", resourceType: "Device", resourceId: "dev-dc-dmz-fw-01", resourceLabel: "DC-DMZ-FW-01", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, afterJson: JSON.stringify({ hostname: "DC-DMZ-FW-01", mgmtIp: "10.30.255.7", vendor: "sophos" }), createdAt: ago(28900) });
  add({ actorId: "usr-noc1", actorName: "Yousef Ghalib", action: "DEVICE_CREATED", resourceType: "Device", resourceId: "dev-br2-wan-edge-01", resourceLabel: "BR2-WAN-EDGE-01", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, afterJson: JSON.stringify({ hostname: "BR2-WAN-EDGE-01", status: "UNMANAGED" }), createdAt: ago(2900) });

  add({ actorId: "usr-admin", actorName: "Amal Al-Sabri", action: "DEVICE_UPDATED", resourceType: "Device", resourceId: "dev-dc-dmz-fw-01", resourceLabel: "DC-DMZ-FW-01", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, beforeJson: JSON.stringify({ status: "ONLINE", healthScore: 88 }), afterJson: JSON.stringify({ status: "DEGRADED", healthScore: 61 }), createdAt: ago(460) });

  for (const [i, [host, devId, label]] of [
    ["HQ-Core-RTR-01", "dev-hq-core-rtr-01", "HQ Core Router 01"],
    ["HQ-Core-SW-01", "dev-hq-core-sw-01", "HQ Core SW 01"],
    ["DC-Core-RTR-01", "dev-dc-core-rtr-01", "DC Core Router 01"],
    ["DC-FW-01", "dev-dc-fw-01", "DC Firewall 01"],
    ["BR1-Edge-RTR-01", "dev-br1-edge-rtr-01", "BR1 Edge Router 01"],
    ["HQ-Access-SW-01", "dev-hq-access-sw-01", "HQ Access SW 01"],
  ].entries()) {
    add({ actorName: "system:backup-worker", action: "CONFIG_BACKUP", resourceType: "ConfigSnapshot", resourceId: devId, resourceLabel: host, result: "SUCCESS", correlationId: jobCorr(i + 2), afterJson: JSON.stringify({ policy: "Daily Full Fleet 02:00", sizeBytes: sizeOf(buildSnapshotPlans().get(devId)![0].text) }), createdAt: ago(310 + i * 7) });
  }
  add({ actorName: "system:backup-worker", action: "CONFIG_BACKUP", resourceType: "ConfigSnapshot", resourceId: "dev-hq-idf-sw-01", resourceLabel: "HQ-IDF-SW-01", result: "FAILURE", correlationId: jobCorr(6), afterJson: JSON.stringify({ error: "SSH connection timed out after 30 s" }), createdAt: ago(605) });

  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "CONFIG_DOWNLOAD", resourceType: "ConfigSnapshot", resourceId: "snap-hq-core-rtr-01-v5", resourceLabel: "HQ-Core-RTR-01 v5 (RUNNING)", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, createdAt: ago(2000) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "CONFIG_DOWNLOAD", resourceType: "ConfigSnapshot", resourceId: "snap-hq-wan-fw-01-v4", resourceLabel: "HQ-WAN-FW-01 v4 (RUNNING)", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, createdAt: ago(1500) });
  add({ actorId: "usr-auditor1", actorName: "Tariq Bashiri", action: "CONFIG_DOWNLOAD", resourceType: "ConfigSnapshot", resourceId: "snap-hq-access-sw-01-v5", resourceLabel: "HQ-Access-SW-01 v5 (RUNNING)", result: "SUCCESS", ip: "10.20.10.55", userAgent: UA, createdAt: ago(600) });

  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "CHANGE_CREATED", resourceType: "ChangeRequest", resourceId: "chg-2026-00407", resourceLabel: "CHG-2026-00407", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, afterJson: JSON.stringify({ status: "DRAFT", riskScore: 35 }), createdAt: ago(15120) });
  add({ actorId: "usr-noc1", actorName: "Yousef Ghalib", action: "CHANGE_CREATED", resourceType: "ChangeRequest", resourceId: "chg-2026-00408", resourceLabel: "CHG-2026-00408", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, afterJson: JSON.stringify({ status: "DRAFT", riskScore: 22 }), createdAt: ago(43200) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "CHANGE_CREATED", resourceType: "ChangeRequest", resourceId: "chg-2026-00410", resourceLabel: "CHG-2026-00410", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, afterJson: JSON.stringify({ status: "DRAFT", riskScore: 52 }), createdAt: ago(4400) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "CHANGE_CREATED", resourceType: "ChangeRequest", resourceId: "chg-2026-00403", resourceLabel: "CHG-2026-00403", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, afterJson: JSON.stringify({ status: "DRAFT", riskScore: 65 }), createdAt: ago(260) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "CHANGE_CREATED", resourceType: "ChangeRequest", resourceId: "chg-2026-00404", resourceLabel: "CHG-2026-00404", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, afterJson: JSON.stringify({ status: "DRAFT", riskScore: 30 }), createdAt: ago(1500) });

  add({ actorId: "usr-admin", actorName: "Amal Al-Sabri", action: "CHANGE_APPROVED", resourceType: "ChangeApproval", resourceId: "chg-2026-00407:TECHNICAL", resourceLabel: "CHG-2026-00407 — Technical", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, afterJson: JSON.stringify({ status: "APPROVED" }), correlationId: "CHG-2026-00407", createdAt: ago(15120) });
  add({ actorId: "usr-manager1", actorName: "Salma Al-Attar", action: "CHANGE_APPROVED", resourceType: "ChangeApproval", resourceId: "chg-2026-00407:MANAGER", resourceLabel: "CHG-2026-00407 — Manager", result: "SUCCESS", ip: "10.20.10.60", userAgent: UA, afterJson: JSON.stringify({ status: "APPROVED" }), correlationId: "CHG-2026-00407", createdAt: ago(14880) });
  add({ actorId: "usr-manager1", actorName: "Salma Al-Attar", action: "CHANGE_APPROVED", resourceType: "ChangeApproval", resourceId: "chg-2026-00406:MANAGER", resourceLabel: "CHG-2026-00406 — Manager", result: "SUCCESS", ip: "10.20.10.60", userAgent: UA, afterJson: JSON.stringify({ status: "APPROVED" }), correlationId: "CHG-2026-00406", createdAt: ago(1440) });

  add({ actorName: "system:change-engine", action: "CHANGE_EXECUTED", resourceType: "ChangeRequest", resourceId: "chg-2026-00407", resourceLabel: "CHG-2026-00407 — WAN QoS", result: "SUCCESS", correlationId: "CHG-2026-00407", afterJson: JSON.stringify({ status: "CLOSED", steps: "5/5 ok" }), createdAt: ago(12700) });
  add({ actorName: "system:change-engine", action: "CHANGE_EXECUTED", resourceType: "ChangeRequest", resourceId: "chg-2026-00410", resourceLabel: "CHG-2026-00410 — IOS upgrade", result: "FAILURE", correlationId: "CHG-2026-00410", afterJson: JSON.stringify({ status: "ROLLBACK", failedStep: "VALIDATE", rollback: "PASSED" }), createdAt: ago(388) });

  add({ actorId: "usr-admin", actorName: "Amal Al-Sabri", action: "BASELINE_APPROVED", resourceType: "ConfigBaseline", resourceId: "snap-hq-access-sw-01-v3", resourceLabel: "HQ-Access-SW-01 v3", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, afterJson: JSON.stringify({ deviceId: "dev-hq-access-sw-01", note: "Access-layer gold config" }), createdAt: ago(24480) });

  add({ actorName: "system:drift-engine", action: "DRIFT_DETECTED", resourceType: "DriftRecord", resourceId: "drift-hq-access-sw-01-1", resourceLabel: "HQ-Access-SW-01 — VLAN 55", result: "SUCCESS", afterJson: JSON.stringify({ baseline: "v3", current: "v4", status: "OPEN" }), createdAt: ago(4100) });
  add({ actorName: "system:drift-engine", action: "DRIFT_DETECTED", resourceType: "DriftRecord", resourceId: "drift-hq-access-sw-01-2", resourceLabel: "HQ-Access-SW-01 — 1/1/24 description", result: "SUCCESS", afterJson: JSON.stringify({ baseline: "v3", current: "v5", status: "OPEN" }), createdAt: ago(1380) });

  add({ actorName: "system:incident-engine", action: "INCIDENT_CREATED", resourceType: "Incident", resourceId: "inc-2026-00101", resourceLabel: "INC-2026-00101 — BGP peer down", result: "SUCCESS", afterJson: JSON.stringify({ severity: "SEV1", source: "ALERT" }), createdAt: ago(40) });
  add({ actorName: "system:change-engine", action: "INCIDENT_CREATED", resourceType: "Incident", resourceId: "inc-2026-00105", resourceLabel: "INC-2026-00105 — failed change", result: "SUCCESS", afterJson: JSON.stringify({ severity: "SEV3", source: "FAILED_CHANGE" }), correlationId: "CHG-2026-00410", createdAt: ago(393) });

  add({ actorId: "usr-noc1", actorName: "Yousef Ghalib", action: "ALERT_ACKNOWLEDGED", resourceType: "Alert", resourceId: "alert-09", resourceLabel: "CPU 96% — BR1-Access-SW-01", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, afterJson: JSON.stringify({ status: "ACKNOWLEDGED" }), createdAt: ago(100) });

  add({ actorId: "usr-admin", actorName: "Amal Al-Sabri", action: "USER_LOGIN", resourceType: "Session", resourceId: "usr-admin", resourceLabel: "admin@faya.local", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, createdAt: ago(45) });
  add({ actorId: "usr-noc1", actorName: "Yousef Ghalib", action: "USER_LOGIN", resourceType: "Session", resourceId: "usr-noc1", resourceLabel: "noc1@faya.local", result: "SUCCESS", ip: "10.20.10.31", userAgent: UA, createdAt: ago(120) });
  add({ actorId: "usr-engineer1", actorName: "Mariam Al-Hakimi", action: "USER_LOGIN", resourceType: "Session", resourceId: "usr-engineer1", resourceLabel: "engineer1@faya.local", result: "SUCCESS", ip: "10.20.10.42", userAgent: UA, createdAt: ago(90) });
  add({ actorName: "unknown", action: "LOGIN_FAILED", resourceType: "Session", resourceLabel: "svc_scan@faya.local", result: "FAILURE", ip: "10.20.10.99", userAgent: "curl/8.4.0", createdAt: ago(75) });
  add({ actorId: "usr-manager1", actorName: "Salma Al-Attar", action: "USER_LOGIN", resourceType: "Session", resourceId: "usr-manager1", resourceLabel: "manager1@faya.local", result: "SUCCESS", ip: "10.20.10.60", userAgent: UA, createdAt: ago(1400) });

  await db.auditEvent.createMany({ data: rows });
}

/* ────────────────────────────── summary ────────────────────────────── */

async function printSummary(extra: { samples: number; rollups: number }) {
  const counts: Array<[string, number]> = [
    ["Role", await db.role.count()],
    ["User", await db.user.count()],
    ["Organization", await db.organization.count()],
    ["Site", await db.site.count()],
    ["Vendor", await db.vendor.count()],
    ["Device", await db.device.count()],
    ["DeviceInterface", await db.deviceInterface.count()],
    ["CredentialProfile", await db.credentialProfile.count()],
    ["BackupPolicy", await db.backupPolicy.count()],
    ["ConfigSnapshot", await db.configSnapshot.count()],
    ["ConfigBaseline", await db.configBaseline.count()],
    ["DriftRecord", await db.driftRecord.count()],
    ["ChangeRequest", await db.changeRequest.count()],
    ["ChangeDevice", await db.changeDevice.count()],
    ["ChangeStep", await db.changeStep.count()],
    ["ChangeApproval", await db.changeApproval.count()],
    ["Incident", await db.incident.count()],
    ["IncidentDevice", await db.incidentDevice.count()],
    ["IncidentEvent", await db.incidentEvent.count()],
    ["Alert", await db.alert.count()],
    ["AlertRule", await db.alertRule.count()],
    ["MaintenanceWindow", await db.maintenanceWindow.count()],
    ["Notification", await db.notification.count()],
    ["MetricSample", extra.samples],
    ["MetricRollup", extra.rollups],
    ["JobExecution", await db.jobExecution.count()],
    ["AuditEvent", await db.auditEvent.count()],
    ["ReportSchedule", await db.reportSchedule.count()],
    ["Setting", await db.setting.count()],
  ];
  const w = Math.max(...counts.map(([n]) => n.length));
  console.log("\n── FayaNMS seed summary ──────────────────");
  for (const [name, count] of counts) {
    console.log(`  ${name.padEnd(w)}  ${String(count).padStart(7)}`);
  }
  const total = counts.reduce((a, [, c]) => a + c, 0);
  console.log("  " + "-".repeat(w + 9));
  console.log(`  ${"TOTAL".padEnd(w)}  ${String(total).padStart(7)}`);
  console.log("──────────────────────────────────────────\n");
}

async function main() {
  console.log("Seeding FayaNMS demo data…");
  await wipe();
  await seedReference();
  const uplinkByDevice = await seedDevices();
  await seedChanges(); // snapshots reference change IDs (PRE/POST_CHANGE)
  await seedSnapshots();
  await seedBaselinesAndDrift();
  await seedIncidentsAndAlerts();
  await seedMaintenance();
  await seedJobs();
  await seedAudit();
  await seedNotifications();
  const metrics = await seedMetrics(uplinkByDevice);
  await printSummary(metrics);
  await db.$disconnect();
  console.log("Seed complete.");
}

main().catch(async (e) => {
  console.error("Seed failed:", e);
  await db.$disconnect();
  process.exit(1);
});
