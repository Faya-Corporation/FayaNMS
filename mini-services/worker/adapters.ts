/**
 * FayaNMS worker — device adapter contract + simulator adapters.
 *
 * Contract (roadmap 2-b): every adapter exposes `connect` and `fetchConfig`.
 * This module is the SIMULATOR plane — vendor-flavored in-memory adapters.
 * The LIVE plane (real SSH, read-only) lives in live-ssh.ts + ssh-transport.ts
 * and is routed by adapter-router.ts (Phase 22 slice 1); both planes
 * implement the identical DeviceAdapter contract, so the runner, snapshot
 * storage and the diff engine treat them uniformly. Simulator templates are
 * parameterized by device hostname/model/firmware/mgmt-ip so different
 * devices produce different configs, and successive backups of the SAME
 * device differ slightly via collector-comment lines only (uptime counter,
 * last-reload stamp, config-revision counter). Normalization strips comment
 * lines, so cosmetic churn normalizes equal and the Phase 3 diff engine
 * only sees real config changes.
 *
 * Adapter keys (capability manifests): cisco-ios (covers IOS/IOS-XE and,
 * folded in, NX-OS via a platform branch), fortinet-fortios, sophos-sfos,
 * hpe-aos-cx, juniper-junos (SRX security flavor + EX switching branch),
 * palo-panos, generic (also the fallback for unknown vendor codes).
 * Phase 12-b: the JunOS body is hierarchical curly-brace (show-configuration
 * style); the PAN-OS body is `show config running` set-style. Both are
 * normalized by the same comment/blank-strip contract as every other flavor.
 * Phase 22: the live manifest key is cisco-ios-live (vendor: cisco).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ ⚠ DEMO DATA — SIMULATED VENDOR CONFIG PERSONAS                          │
 * │ The template bodies below embed INVENTED demo SNMP communities           │
 * │ (FayaRO / FayaR0c) and a demo password hash. They are persona content   │
 * │ for the SIMULATOR plane — not real device secrets — and are pinned by   │
 * │ tests/audit/open-findings-batch-19.test.ts (F-045 grep-guard).          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/* ───────────────────────────── contract ───────────────────────────── */

export interface DeviceTarget {
  deviceId: string;
  hostname: string;
  name?: string;
  /** vendor code as stored on Device.vendor.key: cisco|fortinet|sophos|hpe|juniper|palo|generic */
  vendor: string;
  model?: string | null;
  platform?: string | null;
  firmware?: string | null;
  managementIp?: string | null;
  /** device status at claim time — the runner checks OFFLINE before connect */
  status?: string | null;
  /**
   * Device data plane (Phase 22 slice 1): "SIMULATOR" (default) uses the
   * in-memory adapters; "LIVE_SSH" routes through the real-transport
   * read-only adapter (adapter-router.ts + live-ssh.ts). Arrives via the
   * claim enrichment / probe body; absent = SIMULATOR.
   */
  dataSource?: string | null;
}

export interface ConnResult {
  latencyMs: number;
  banner: string;
  negotiated: string;
}

export interface ConfigResult {
  rawText: string;
  normalizedText: string;
}

export interface DeviceAdapter {
  /** manifest key, e.g. "cisco-ios" */
  adapter: string;
  /** canonical vendor code the adapter serves */
  vendor: string;
  capabilities: string[];
  configFlavor: string;
  notes: string;
  connect(target: DeviceTarget): Promise<ConnResult>;
  fetchConfig(target: DeviceTarget): Promise<ConfigResult>;
}

/* ───────────────────────────── helpers ───────────────────────────── */

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const randInt = (min: number, max: number): number =>
  min + Math.floor(Math.random() * (max - min + 1));

export { randInt };

/** FNV-1a — deterministic per-hostname jitter. */
function hash(input: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

const WORKER_LOAD_TS = Date.now();

/** Uptime grows with wall-clock time → successive backups always differ. */
function uptimeSeconds(hostname: string): number {
  const base = (hash(hostname) % (40 * 86_400)) + 3 * 86_400;
  return base + Math.floor((Date.now() - WORKER_LOAD_TS) / 1000);
}

function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3_600);
  const m = Math.floor((sec % 3_600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function fmtLastReload(sec: number): string {
  return `${new Date(Date.now() - sec * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19)} UTC`;
}

/** Rotating minor counter (increments once per minute of worker uptime). */
function revisionCounter(): number {
  return 400 + Math.floor((Date.now() - WORKER_LOAD_TS) / 60_000);
}

/**
 * Normalization contract for the Phase 3 diff engine:
 * drop comment lines (`!`/`#`), drop blank lines, trim trailing whitespace.
 * Pure + deterministic: equal configs normalize equal.
 */
export function normalizeConfig(raw: string): string {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+$/, "");
    const core = trimmed.trim();
    if (core.length === 0) continue;
    if (core.startsWith("!") || core.startsWith("#")) continue;
    out.push(trimmed);
  }
  return out.join("\n");
}

function finish(kind: string, target: DeviceTarget, body: string[]): ConfigResult {
  const up = uptimeSeconds(target.hostname);
  const header = [
    "!",
    `! ${kind} — collected by FayaNMS worker simulator. Do not edit.`,
    `! Device: ${target.hostname} (${target.model ?? "unknown model"}, ${
      target.firmware ?? "unknown firmware"
    })`,
    `! Management IP: ${target.managementIp ?? "unknown"}`,
    `! Uptime: ${fmtUptime(up)} (last reload ${fmtLastReload(up)})`,
    `! Worker config-revision counter: r${revisionCounter()}`,
    "!",
  ];
  const rawText = `${header.join("\n")}\n${body.join("\n")}\n`;
  return { rawText, normalizedText: normalizeConfig(rawText) };
}

async function connectBase(target: DeviceTarget, banner: string): Promise<ConnResult> {
  const latencyMs = randInt(300, 900);
  await sleep(latencyMs);
  return { latencyMs, banner, negotiated: "ssh2" };
}

function octets(ip: string | null | undefined, fallback = "10.20.255.1"): string[] {
  return (ip ?? fallback).split(".");
}

/** Deterministic-looking transit peer IP from the hostname hash. */
function peerIp(hostname: string): string {
  const h = hash(hostname);
  return `185.${h % 250}.${(h >> 3) % 250}.9`;
}

/* ───────────────────────── cisco IOS / IOS-XE / NX-OS ───────────────────────── */

function ciscoBody(t: DeviceTarget): string[] {
  const fw = t.firmware ?? "17.06.04";
  const mgmt = octets(t.managementIp);
  const supernet = `${mgmt[0]}.${mgmt[1]}.0.0`;
  const s: string[] = [];
  const platform = `${t.platform ?? ""} ${t.model ?? ""}`.toUpperCase();

  if (platform.includes("NX-OS") || platform.includes("N9K")) {
    // ── NX-OS flavor (folded into the cisco-ios adapter) ──
    s.push(`version 9.3(10) Bios:version 05.42`);
    s.push(`feature bgp
feature ospf
feature lacp
feature interface-vlan`);
    s.push(`hostname ${t.hostname}`);
    s.push(`vlan 10
  name USERS
vlan 20
  name VOICE
vlan 900
  name TRANSIT`);
    s.push(`vrf context management`);
    s.push(`interface Ethernet1/1
  description UPLINK-SPINE-01
  no switchport
  mtu 9216
  ip address 10.30.0.${mgmt[3]}/31
  no shutdown`);
    s.push(`interface mgmt0
  vrf member management
  ip address ${t.managementIp ?? "10.30.255.2"}/24`);
    s.push(`line vty
  exec-timeout 60`);
    s.push(`router bgp 65001
  router-id ${t.managementIp ?? "10.30.255.2"}
  address-family ipv4 unicast
    network ${supernet} mask 255.255.0.0
  neighbor ${peerIp(t.hostname)} remote-as 65010
    description DC-TRANSIT-PEER
    address-family ipv4 unicast`);
    s.push(`snmp-server community FayaR0c group network-operator
snmp-server location DC-Aden-Rack-B4
snmp-server contact NOC <noc@faya.local>
logging server 10.20.10.6 6 facility local7
ntp server 10.20.10.10 prefer
end`);
    return s;
  }

  const isSwitch = /C9\d{3}|C92\d\d|C93\d\d|C94\d\d|95\d\d|2960|CAT/i.test(
    `${t.model ?? ""}`
  );
  const majorMinor = fw.split(".").slice(0, 2).join(".");
  s.push(`version ${majorMinor.replace(/\.0([1-9])$/, ".$1")}
service timestamps debug datetime msec localtime show-timezone
service timestamps log datetime msec localtime show-timezone
service password-encryption`);
  s.push(`hostname ${t.hostname}`);
  s.push(`no ip domain-lookup
ip domain-name faya.local
ip name-server 10.20.10.10
ip name-server 10.20.10.11`);
  s.push(`aaa new-model
aaa authentication login default group TACACS+ local
aaa authorization exec default group TACACS+ local
aaa accounting exec default start-stop group TACACS+`);
  s.push(`ip ssh version 2
ip ssh time-out 60
ip ssh authentication-retries 3`);

  if (isSwitch) {
    s.push(`vlan 10
 name USERS
vlan 20
 name VOICE
vlan 30
 name CAMERA
vlan 99
 name MGMT`);
    s.push(`spanning-tree mode rapid-pvst
spanning-tree portfast default
errdisable recovery cause link-flap
errdisable recovery interval 300`);
    s.push(`interface GigabitEthernet1/0/1
 description AP-FLOOR-A
 switchport mode access
 switchport access vlan 10
 switchport voice vlan 20
 spanning-tree portfast
 power inline auto`);
    s.push(`interface GigabitEthernet1/0/24
 description UPLINK-CORE
 switchport mode trunk
 switchport trunk allowed vlan 10,20,30,99
 udld enable`);
    s.push(`interface Vlan99
 description MGMT-SVI
 ip address ${t.managementIp ?? "10.20.255.11"} 255.255.255.0
 no shutdown`);
    s.push(`interface Vlan10
 description USERS-SVI
 ip address 10.20.10.1 255.255.255.0
 standby 10 ip 10.20.10.254
 standby 10 priority ${110 + (hash(t.hostname) % 20)}
 standby 10 preempt`);
    s.push(`ip default-gateway 10.20.255.254`);
  } else {
    s.push(`interface Loopback0
 description ROUTER-ID
 ip address ${t.managementIp ?? "10.20.255.1"} 255.255.255.255`);
    s.push(`interface GigabitEthernet0/0/0
 description WAN-TRANSIT-ISP-A
 ip address ${mgmt[0]}.${mgmt[1]}.254.${mgmt[3]} 255.255.255.252
 no shutdown`);
    s.push(`interface GigabitEthernet0/0/1
 description LAN-CORE
 ip address ${mgmt[0]}.${mgmt[1]}.0.1 255.255.255.0
 no shutdown`);
    s.push(`router bgp 65001
 bgp router-id ${t.managementIp ?? "10.20.255.1"}
 bgp log-neighbor-changes
 neighbor ${peerIp(t.hostname)} remote-as 65010
 neighbor ${peerIp(t.hostname)} description TRANSIT-PEER
 !
 address-family ipv4 unicast
  network ${supernet} mask 255.255.0.0
  neighbor ${peerIp(t.hostname)} activate
 exit-address-family`);
    s.push(`ip prefix-list TRANSIT-OUT seq 10 permit ${supernet}/16
ip prefix-list TRANSIT-OUT seq 20 deny 0.0.0.0/0 le 32`);
    s.push(`ip route 0.0.0.0 0.0.0.0 ${peerIp(t.hostname)} name DEFAULT-TRANSIT`);
  }

  s.push(`class-map match-any QOS-VOICE
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
  fair-queue`);
  s.push(`snmp-server community FayaR0c RO 80
snmp-server location ${t.hostname.startsWith("HQ") ? "HQ-Sanaa-MDF" : "Branch-Closet"}
snmp-server contact NOC <noc@faya.local>
snmp-server host 10.20.10.5 version 2c FayaR0c
access-list 80 permit 10.20.10.0 0.0.0.31
access-list 80 deny   any log`);
  s.push(`logging buffered 64000 informational
logging host 10.20.10.6
ntp server 10.20.10.10 prefer
ntp server 10.20.10.11`);
  s.push(`line con 0
 exec-timeout 10 0
line vty 0 4
 exec-timeout 10 0
 transport input ssh
line vty 5 15
 exec-timeout 10 0
 transport input ssh
end`);
  return s;
}

/* ───────────────────────────── fortinet FortiOS ───────────────────────────── */

function fortiosBody(t: DeviceTarget): string[] {
  const modelCompact = (t.model ?? "FortiGate").replace(/\s/g, "");
  const fw = t.firmware ?? "7.4.3";
  const mgmt = octets(t.managementIp);
  const priority = 200 + (hash(t.hostname) % 50);
  const s: string[] = [];
  s.push(`#config-version=${modelCompact}-${fw}-FW-build1394-260214:opmode=0:vdom=root:user=cfgbackup
#conf_file_ver=2602140000
#buildno=1394
#global_vdom=1`);
  s.push(`config system global
    set hostname "${t.hostname}"
    set timezone 39
    set admin-sport 443
    set gui-theme "onnet-jade"
    set daily-restart disable
end`);
  s.push(`config system interface
    edit "port1"
        set vdom "root"
        set ip ${mgmt[0]}.${mgmt[1]}.254.${mgmt[3]} 255.255.255.252
        set allowaccess ping https ssh snmp
        set role wan
        set description "WAN-UPLINK"
    next
    edit "port2"
        set vdom "root"
        set ip ${mgmt[0]}.${mgmt[1]}.0.1 255.255.255.0
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
  s.push(`config system ha
    set group-id 11
    set group-name "FAYA-HA"
    set mode a-p
    set hbdev "port3" 100
    set session-pickup enable
    set override disable
    set priority ${priority}
end`);
  s.push(`config firewall policy
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
    next
    edit 3
        set name "IPSEC-BRANCH-TUNNELS"
        set srcintf "port1"
        set dstintf "port1"
        set srcaddr "BRANCH-NETS"
        set dstaddr "HQ-NETS"
        set action accept
        set schedule "always"
        set service "ALL"
        set comments "Branch VPN mesh"
    next
end`);
  s.push(`config router static
    edit 1
        set gateway ${mgmt[0]}.${mgmt[1]}.254.1
        set device "port1"
    next
end`);
  s.push(`config log syslogd setting
    set status enable
    set server "10.20.10.6"
    set facility local7
end
end`);
  return s;
}

/* ───────────────────────────── sophos SFOS ───────────────────────────── */

function sophosBody(t: DeviceTarget): string[] {
  const mgmt = octets(t.managementIp);
  const s: string[] = [];
  s.push(`hostname ${t.hostname}
timezone 39`);
  s.push(`interface
  port1
    name WAN
    zone WAN
    ip ${mgmt[0]}.${mgmt[1]}.254.${mgmt[3]}
    status enable
  exit
  port2
    name LAN
    zone LAN
    ip ${mgmt[0]}.${mgmt[1]}.0.1
    status enable
  exit
  port3
    name DMZ
    zone DMZ
    ip ${mgmt[0]}.${mgmt[1]}.100.1
    status enable
  exit
exit`);
  s.push(`router
  static
    route 0.0.0.0 0 gateway ${mgmt[0]}.${mgmt[1]}.254.1
    route 10.0.0.0 8 gateway ${mgmt[0]}.${mgmt[1]}.0.254
  exit
exit`);
  s.push(`firewall
  add rule LAN_to_WAN
    set source_zone LAN
    set destination_zone WAN
    set action accept
    set log_traffic enable
  exit
  add rule DMZ_to_WAN_443
    set source_zone DMZ
    set destination_zone WAN
    set service HTTPS
    set action accept
    set log_traffic enable
    set description "DMZ outbound HTTPS only"
  exit
exit`);
  s.push(`ha
  set mode active-passive
  set devicepriority ${100 + (hash(t.hostname) % 90)}
  set monitoring enable
exit`);
  s.push(`snmp
  add community FayaRO
  set location "${t.hostname.startsWith("HQ") ? "HQ-Sanaa" : "Branch site"}"
  set contact "NOC <noc@faya.local>"
  status enable
exit
syslog
  add syslog_server 10.20.10.6
  set facility local7
  status enable
exit
end`);
  return s;
}

/* ───────────────────────────── hpe AOS-CX ───────────────────────────── */

function aosCxBody(t: DeviceTarget): string[] {
  const mgmt = octets(t.managementIp);
  const s: string[] = [];
  s.push(`hostname ${t.hostname}`);
  s.push(`vlan 1
    no shutdown
vlan 10
    name USERS
    no shutdown
vlan 20
    name VOICE
    no shutdown
vlan 30
    name CAMERA
    no shutdown
vlan 99
    name MGMT
    no shutdown`);
  s.push(`interface lag 1
    description UPLINK-CORE
    no shutdown
    vlan trunk allowed 10,20,30,99
    lacp mode active`);
  s.push(`interface 1/1/1
    description AP-FLOOR-A
    no shutdown
    vlan access 20
    vlan trunk allowed 10,20
    poe enable`);
  s.push(`interface 1/1/2
    description ACCESS-VLAN10
    no shutdown
    vlan access 10
    spanning-tree admin-edge-port`);
  s.push(`interface 1/1/3
    description ACCESS-VLAN20
    no shutdown
    vlan access 20
    poe enable`);
  s.push(`interface 1/1/24
    description UPLINK-CORE-01
    no shutdown
    mtu 9198
    lacp mode active`);
  s.push(`interface vlan 99
    ip address ${t.managementIp ?? "10.20.255.9"}/24
    no shutdown`);
  s.push(`ip route 0.0.0.0/0 ${mgmt[0]}.${mgmt[1]}.255.254`);
  s.push(`snmp-server community FayaRO read
snmp-server location "${t.hostname.startsWith("HQ") ? "HQ-Sanaa-MDF" : "Branch-MDF"}"
snmp-server contact "NOC <noc@faya.local>"
logging 10.20.10.6 udp 514
ntp server 10.20.10.10 iburst prefer
ntp server 10.20.10.11 iburst`);
  s.push(`password manager plaintext-hash $2y$05$FayaNMSDemoHashOnlyNotReal$
end`);
  return s;
}

/* ───────────────────────────── juniper Junos OS ───────────────────────────── */

/**
 * Hierarchical curly-brace Junos OS body (what `show configuration` prints).
 * SRX models get security zones/policies; EX/QFX models get an
 * ethernet-switching flavor — mirroring the ciscoBody NX-OS platform branch.
 */
function junosBody(t: DeviceTarget): string[] {
  const fw = t.firmware ?? "21.4R3-S4.9";
  const mgmt = octets(t.managementIp);
  const isEx = /EX[0-9]|QFX/i.test(`${t.model ?? ""} ${t.platform ?? ""}`);
  const s: string[] = [];

  s.push(`version "${fw}";`);
  s.push(`system {
    host-name ${t.hostname};
    domain-name faya.local;
    time-zone Asia/Aden;
    name-server {
        10.20.10.10;
        10.20.10.11;
    }
    services {
        ssh {
            protocol-version v2;
            connection-limit 5 rate-limit 3;
        }
        web-management {
            https {
                system-generated-certificate;
            }
        }
    }
    syslog {
        host 10.20.10.6 {
            any any;
        }
        file messages {
            any notice;
            authorization info;
        }
    }
    ntp {
        server 10.20.10.10 prefer;
        server 10.20.10.11;
    }
}`);

  if (isEx) {
    // ── EX/QFX switching flavor ──
    s.push(`interfaces {
    ge-0/0/1 {
        description ACCESS-VLAN10;
        unit 0 {
            family ethernet-switching {
                vlan members USERS;
            }
        }
    }
    ge-0/0/2 {
        description ACCESS-VLAN20;
        unit 0 {
            family ethernet-switching {
                vlan members VOICE;
            }
        }
    }
    ge-0/0/47 {
        description UPLINK-CORE;
        unit 0 {
            family ethernet-switching {
                vlan members [ USERS VOICE MGMT ];
            }
        }
    }
    me0 {
        description OOB-MANAGEMENT;
        unit 0 {
            family inet {
                address ${t.managementIp ?? "10.20.255.14"}/24;
            }
        }
    }
    vlan {
        unit 99 {
            family inet {
                address ${mgmt[0]}.${mgmt[1]}.10.1/24;
            }
        }
    }
}`);
    s.push(`vlans {
    USERS {
        vlan-id 10;
    }
    VOICE {
        vlan-id 20;
    }
    CAMERA {
        vlan-id 30;
    }
    MGMT {
        vlan-id 99;
        l3-interface vlan.99;
    }
}`);
    s.push(`routing-options {
    static {
        route 0.0.0.0/0 next-hop ${mgmt[0]}.${mgmt[1]}.10.254;
    }
}`);
    s.push(`snmp {
    community FayaRO {
        authorization read-only;
    }
    location "${t.hostname.startsWith("HQ") ? "HQ-Sanaa-MDF" : "Branch-MDF"}";
    contact "NOC <noc@faya.local>";
}`);
    return s;
  }

  // ── SRX security-gateway flavor (default Junos branch) ──
  const wanAddr = `${mgmt[0]}.${mgmt[1]}.254.${mgmt[3]}/30`;
  const lanAddr = `${mgmt[0]}.${mgmt[1]}.0.1/24`;
  const dmzAddr = `${mgmt[0]}.${mgmt[1]}.100.1/24`;
  s.push(`interfaces {
    ge-0/0/0 {
        description WAN-UPLINK;
        unit 0 {
            family inet {
                address ${wanAddr};
            }
        }
    }
    ge-0/0/1 {
        description LAN-CORE;
        unit 0 {
            family inet {
                address ${lanAddr};
            }
        }
    }
    ge-0/0/2 {
        description DMZ-SEGMENT;
        unit 0 {
            family inet {
                address ${dmzAddr};
            }
        }
    }
    ge-0/0/3 {
        description RESERVED-SPARE;
        disable;
        unit 0 {
            family inet;
        }
    }
    fxp0 {
        description OOB-MANAGEMENT;
        unit 0 {
            family inet {
                address ${t.managementIp ?? "10.20.255.12"}/24;
            }
        }
    }
}`);
  s.push(`routing-options {
    static {
        route 0.0.0.0/0 next-hop ${mgmt[0]}.${mgmt[1]}.254.1;
    }
}`);
  s.push(`policy-options {
    policy-statement EXPORT-LOCAL {
        term 10 {
            from protocol static;
            then accept;
        }
    }
}`);
  s.push(`protocols {
    bgp {
        group TRANSIT {
            type external;
            description TRANSIT-PEER;
            export EXPORT-LOCAL;
            peer-as 65010;
            neighbor ${peerIp(t.hostname)};
        }
    }
}`);
  s.push(`security {
    zones {
        security-zone TRUST {
            interfaces {
                ge-0/0/1.0;
            }
        }
        security-zone DMZ {
            interfaces {
                ge-0/0/2.0;
            }
        }
        security-zone UNTRUST {
            host-inbound-traffic {
                system-services {
                    ike;
                    ping;
                }
            }
            interfaces {
                ge-0/0/0.0;
            }
        }
    }
    policies {
        from-zone TRUST to-zone UNTRUST {
            policy ALLOW-OUTBOUND {
                match {
                    source-address any;
                    destination-address any;
                    application any;
                }
                then {
                    permit;
                    log {
                        session-init;
                        session-close;
                    }
                }
            }
        }
        from-zone DMZ to-zone UNTRUST {
            policy DMZ-OUTBOUND-HTTPS {
                match {
                    source-address any;
                    destination-address any;
                    application junos-https;
                }
                then {
                    permit;
                }
            }
        }
    }
}`);
  s.push(`snmp {
    community FayaRO {
        authorization read-only;
    }
    location "${t.hostname.startsWith("HQ") ? "HQ-Sanaa-MDF" : "Branch-MDF"}";
    contact "NOC <noc@faya.local>";
}`);
  return s;
}

/* ───────────────────────────── paloalto PAN-OS ───────────────────────────── */

/**
 * Palo Alto PAN-OS body in `show config running` set-style. MGT-plane
 * addresses live under deviceconfig system; dataplane under network
 * interface/zone/virtual-router; policy under rulebase (security + nat).
 * Small PA-4xx units have no DMZ segment seeded — guarded by model regex.
 */
function paloBody(t: DeviceTarget): string[] {
  const mgmt = octets(t.managementIp);
  const hasDmz = !/PA-4[0-9]{2}/i.test(t.model ?? "");
  const s: string[] = [];

  s.push(`set deviceconfig system hostname ${t.hostname}`);
  s.push(`set deviceconfig system timezone Asia/Aden
set deviceconfig system domain faya.local
set deviceconfig system ip-address ${t.managementIp ?? "10.30.255.8"}
set deviceconfig system netmask 255.255.255.0
set deviceconfig system default-gateway ${mgmt[0]}.${mgmt[1]}.255.254
set deviceconfig system dns-setting servers primary 10.20.10.10
set deviceconfig system dns-setting servers secondary 10.20.10.11
set deviceconfig system ntp-servers primary-ntp-server ntp-server-address 10.20.10.10
set deviceconfig system ntp-servers secondary-ntp-server ntp-server-address 10.20.10.11
set deviceconfig system syslog server FayaNMS-SIEM server 10.20.10.6
set deviceconfig system syslog server FayaNMS-SIEM facility LOG_LOCAL7
set deviceconfig system snmp-setting location "${t.hostname.startsWith("DC") ? "DC-Aden-Rack-B2" : "HQ-Sanaa-MDF"}"
set deviceconfig system snmp-setting contact "NOC <noc@faya.local>"`);
  s.push(`set shared snmpserver profile FayaNMS version v2c community FayaRO`);
  s.push(`set network interface ethernet ethernet1/1 link-state auto
set network interface ethernet ethernet1/1 layer3 ip ${mgmt[0]}.${mgmt[1]}.254.${mgmt[3]}/30
set network interface ethernet ethernet1/1 comment "WAN-UPLINK"
set network interface ethernet ethernet1/2 layer3 ip ${mgmt[0]}.${mgmt[1]}.0.1/24
set network interface ethernet ethernet1/2 comment "LAN-CORE"`);
  if (hasDmz) {
    s.push(`set network interface ethernet ethernet1/3 layer3 ip ${mgmt[0]}.${mgmt[1]}.100.1/24
set network interface ethernet ethernet1/3 comment "DMZ-SEGMENT"`);
  }
  s.push(`set network interface ethernet ethernet1/8 comment "HA-LINK"`);
  s.push(`set network virtual-router default interface [ ethernet1/1 ethernet1/2${hasDmz ? " ethernet1/3" : ""} ]`);
  s.push(`set network virtual-router default static-route DEFAULT destination 0.0.0.0/0 nexthop ip-address ${mgmt[0]}.${mgmt[1]}.254.1`);
  s.push(
    [
      `set zone UNTRUST network layer3 ethernet1/1`,
      `set zone TRUST network layer3 ethernet1/2`,
      ...(hasDmz ? [`set zone DMZ network layer3 ethernet1/3`] : []),
    ].join("\n")
  );
  s.push(`set rulebase security rules LAN-to-WAN from TRUST
set rulebase security rules LAN-to-WAN to UNTRUST
set rulebase security rules LAN-to-WAN source any
set rulebase security rules LAN-to-WAN destination any
set rulebase security rules LAN-to-WAN source-user any
set rulebase security rules LAN-to-WAN category any
set rulebase security rules LAN-to-WAN application any
set rulebase security rules LAN-to-WAN service any
set rulebase security rules LAN-to-WAN action allow`);
  if (hasDmz) {
    s.push(`set rulebase security rules DMZ-to-WAN-HTTPS from DMZ
set rulebase security rules DMZ-to-WAN-HTTPS to UNTRUST
set rulebase security rules DMZ-to-WAN-HTTPS source any
set rulebase security rules DMZ-to-WAN-HTTPS destination any
set rulebase security rules DMZ-to-WAN-HTTPS application ssl
set rulebase security rules DMZ-to-WAN-HTTPS service service-https
set rulebase security rules DMZ-to-WAN-HTTPS action allow`);
  }
  s.push(`set rulebase nat rules OUTBOUND-NAT from TRUST
set rulebase nat rules OUTBOUND-NAT to UNTRUST
set rulebase nat rules OUTBOUND-NAT source any
set rulebase nat rules OUTBOUND-NAT destination any
set rulebase nat rules OUTBOUND-NAT to-interface ethernet1/1
set rulebase nat rules OUTBOUND-NAT source-translation dynamic-ip-and-port interface-address interface ethernet1/1`);
  return s;
}

/* ───────────────────────────── generic ───────────────────────────── */

function genericBody(t: DeviceTarget): string[] {
  const mgmt = octets(t.managementIp);
  const s: string[] = [];
  s.push(`set system host-name ${t.hostname}
set system ntp server 10.20.10.10
set system syslog host 10.20.10.6 facility local7`);
  s.push(`set interfaces mgmt address ${t.managementIp ?? "10.50.255.4"}/24
set interfaces wan address ${mgmt[0]}.${mgmt[1]}.254.${mgmt[3]}/30`);
  s.push(`set service snmp community FayaRO authorization read-only
set service ssh listen-address ${t.managementIp ?? "10.50.255.4"}`);
  s.push(`set protocols static route 0.0.0.0/0 next-hop ${mgmt[0]}.${mgmt[1]}.254.1`);
  return s;
}

/* ───────────────────────────── adapter registry ───────────────────────────── */

const CISCO_BANNER =
  "FAYA-NETWORK — Authorised access only. All connections are logged and monitored. (FayaNMS lab-sim)";
const FORTIOS_BANNER =
  "FortiGate — authorised administrators only. FayaNMS lab-sim unit.";
const SFOS_BANNER =
  "Sophos Firewall (SFOS) — restricted management access. FayaNMS lab-sim unit.";
const AOSCX_BANNER =
  "AOS-CX managed switch — NOC administrative access only. FayaNMS lab-sim unit.";
const JUNOS_BANNER =
  "Juniper Networks (Junos OS) — restricted system, authorised access only. FayaNMS lab-sim unit.";
const PANOS_BANNER =
  "Palo Alto Networks PAN-OS management console — restricted access. FayaNMS lab-sim unit.";
const GENERIC_BANNER =
  "Generic managed device console — FayaNMS simulated node.";

export const adapters: DeviceAdapter[] = [
  {
    adapter: "cisco-ios",
    vendor: "cisco",
    capabilities: ["connect", "backup_config"],
    configFlavor: "cisco-ios",
    notes:
      "IOS / IOS-XE simulator (show running-config style). NX-OS devices (N9K) are folded in here and emit NX-OS syntax via a platform branch.",
    connect: (t) => connectBase(t, CISCO_BANNER),
    fetchConfig: async (t) => finish("Cisco IOS running configuration", t, ciscoBody(t)),
  },
  {
    adapter: "fortinet-fortios",
    vendor: "fortinet",
    capabilities: ["connect", "backup_config"],
    configFlavor: "fortios",
    notes:
      "FortiGate FortiOS simulator (config system global / interface / ha / firewall policy blocks terminated with end).",
    connect: (t) => connectBase(t, FORTIOS_BANNER),
    fetchConfig: async (t) => finish("FortiGate full configuration", t, fortiosBody(t)),
  },
  {
    adapter: "sophos-sfos",
    vendor: "sophos",
    capabilities: ["connect", "backup_config"],
    configFlavor: "sfos",
    notes: "Sophos SFOS CLI simulator (interface zones / firewall rules / ha blocks).",
    connect: (t) => connectBase(t, SFOS_BANNER),
    fetchConfig: async (t) => finish("Sophos Firewall CLI configuration", t, sophosBody(t)),
  },
  {
    adapter: "hpe-aos-cx",
    vendor: "hpe",
    capabilities: ["connect", "backup_config"],
    configFlavor: "aos-cx",
    notes: "HPE AOS-CX simulator (vlan 10/20/30/99, interface lag, 1/1/x ports).",
    connect: (t) => connectBase(t, AOSCX_BANNER),
    fetchConfig: async (t) => finish("AOS-CX running configuration", t, aosCxBody(t)),
  },
  {
    adapter: "juniper-junos",
    vendor: "juniper",
    capabilities: ["connect", "backup_config"],
    configFlavor: "junos",
    notes:
      "Juniper Junos OS simulator (hierarchical show-configuration: version/system/interfaces/routing-options/policy-options/protocols/snmp; SRX security zones+policies branch, EX ethernet-switching branch).",
    connect: (t) => connectBase(t, JUNOS_BANNER),
    fetchConfig: async (t) => finish("Junos OS running configuration", t, junosBody(t)),
  },
  {
    adapter: "palo-panos",
    vendor: "palo",
    capabilities: ["connect", "backup_config"],
    configFlavor: "panos",
    notes:
      "Palo Alto PAN-OS simulator (show config running set-style: deviceconfig system MGT plane, network interface/zone/virtual-router, rulebase security + nat; small PA-4xx units omit the DMZ segment).",
    connect: (t) => connectBase(t, PANOS_BANNER),
    fetchConfig: async (t) => finish("PAN-OS running configuration (set style)", t, paloBody(t)),
  },
  {
    adapter: "generic",
    vendor: "generic",
    capabilities: ["connect", "backup_config"],
    configFlavor: "generic",
    notes: "Fallback simulator for unknown/unclassified vendors (SNMP-managed style).",
    connect: (t) => connectBase(t, GENERIC_BANNER),
    fetchConfig: async (t) => finish("Generic managed-node configuration", t, genericBody(t)),
  },
];

/** Pick an adapter by vendor code; unknown vendors degrade to `generic`. */
export function pickAdapter(vendorCode: string | null | undefined): DeviceAdapter {
  const v = (vendorCode ?? "").trim().toLowerCase();
  return (
    adapters.find((a) => a.vendor === v) ??
    adapters.find((a) => a.adapter === v) ??
    adapters[adapters.length - 1]
  );
}
