# FayaNMS Enterprise — Icon Catalog

**Total icons:** 216

This pack follows the FayaNMS design-system direction: Lucide-style 24×24 outline geometry, `currentColor` SVG masters, semantic status mapping, and an enterprise network-operations visual language.

## Usage rules

- **16px** — inline/table icons
- **18px** — buttons
- **20px** — navigation
- **24px** — prominent UI
- SVG masters use `currentColor` so Tailwind/design tokens control color.
- PNG exports use the FayaNMS semantic color associated with the icon.
- Vendor badges are **FayaNMS project glyphs, not official vendor trademarks/logos**.

## Brand

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `fayanms-mark` | Primary FayaNMS project mark: network nodes inside a protected operations ring. | `primary` | 24px prominent / 20px navigation |
| `fayanms-network-shield` | Network-management security symbol for product branding, secure operations, and protected infrastructure. | `primary` | 24px prominent / 20px navigation |
| `fayanms-noc-mark` | Compact NOC-focused brand mark for operations-center displays. | `primary` | 24px prominent / 20px navigation |

## Shell

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `dashboard` | Main FayaNMS dashboard. | `primary` | 20px navigation |
| `global-search` | Global entity and command search. | `neutral` | 18px header |
| `command-palette` | Keyboard command palette and quick actions. | `neutral` | 18px header |
| `notifications` | User notifications, distinct from operational alerts. | `neutral` | 18px header |
| `theme` | Light, dark, or system theme selector. | `neutral` | 18px header |
| `density` | Comfortable, compact, or dense display mode. | `neutral` | 18px header |
| `help` | Help and contextual assistance. | `neutral` | 18px header |
| `profile` | Current user profile and account menu. | `neutral` | 18px header |

## Network

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `network` | Network domain root. | `primary` | 24px prominent / 20px navigation |
| `devices` | Managed network devices inventory. | `primary` | 24px prominent / 20px navigation |
| `sites` | Physical or logical network sites. | `neutral` | 24px prominent / 20px navigation |
| `interfaces` | Physical and logical network interfaces. | `neutral` | 24px prominent / 20px navigation |
| `topology` | Network topology and dependency graph. | `neutral` | 24px prominent / 20px navigation |
| `discovery` | Network discovery and device onboarding. | `neutral` | 24px prominent / 20px navigation |
| `vendors` | Network vendors and supported platforms. | `neutral` | 24px prominent / 20px navigation |
| `collectors` | Distributed FayaNMS collector nodes. | `neutral` | 24px prominent / 20px navigation |
| `device-switch` | Switch device type. | `neutral` | 24px prominent / 20px navigation |
| `device-router` | Router device type. | `neutral` | 24px prominent / 20px navigation |
| `device-firewall` | Firewall device type. | `neutral` | 24px prominent / 20px navigation |
| `device-server` | Server or network appliance. | `neutral` | 24px prominent / 20px navigation |
| `device-cloud` | Cloud-managed or virtual network resource. | `neutral` | 24px prominent / 20px navigation |
| `device-generic` | Generic managed network device. | `neutral` | 24px prominent / 20px navigation |
| `site-building` | Building location. | `neutral` | 24px prominent / 20px navigation |
| `site-rack` | Network rack location. | `neutral` | 24px prominent / 20px navigation |
| `location` | Device or site location. | `neutral` | 24px prominent / 20px navigation |
| `management-ip` | Device management IP address. | `neutral` | 24px prominent / 20px navigation |
| `mac-address` | MAC address or MAC-table data. | `neutral` | 24px prominent / 20px navigation |
| `vlan` | VLAN configuration and inventory. | `neutral` | 24px prominent / 20px navigation |
| `routes` | Routing table and static/dynamic routes. | `neutral` | 24px prominent / 20px navigation |
| `arp-table` | ARP / neighbor resolution table. | `neutral` | 24px prominent / 20px navigation |
| `mac-table` | Layer-2 forwarding / MAC address table. | `neutral` | 24px prominent / 20px navigation |
| `neighbors` | LLDP/CDP device neighbors. | `neutral` | 24px prominent / 20px navigation |
| `vpn` | VPN tunnel or VPN health. | `neutral` | 24px prominent / 20px navigation |
| `high-availability` | HA pair / cluster health. | `neutral` | 24px prominent / 20px navigation |

## Protocols

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `ssh` | SSH management transport. | `info` | 24px prominent / 20px navigation |
| `https` | HTTPS/API management transport. | `info` | 24px prominent / 20px navigation |
| `snmp` | SNMP polling or trap capability. | `info` | 24px prominent / 20px navigation |
| `syslog` | Syslog ingestion and device event logs. | `info` | 24px prominent / 20px navigation |
| `netconf` | NETCONF configuration transport. | `info` | 24px prominent / 20px navigation |
| `restconf` | RESTCONF configuration transport. | `info` | 24px prominent / 20px navigation |
| `gnmi` | gNMI / streaming telemetry capability. | `info` | 24px prominent / 20px navigation |
| `telemetry` | Streaming telemetry data. | `info` | 24px prominent / 20px navigation |
| `api` | Generic device or platform API. | `info` | 24px prominent / 20px navigation |
| `webhook` | Outbound or inbound webhook integration. | `info` | 24px prominent / 20px navigation |

## Vendors

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `vendor-cisco` | Cisco platform adapter badge (non-official project glyph). | `neutral` | 24px prominent / 20px navigation |
| `vendor-fortigate` | FortiGate platform adapter badge (non-official project glyph). | `neutral` | 24px prominent / 20px navigation |
| `vendor-sophos` | Sophos XGS platform adapter badge (non-official project glyph). | `neutral` | 24px prominent / 20px navigation |
| `vendor-hpe` | HPE/Aruba platform adapter badge (non-official project glyph). | `neutral` | 24px prominent / 20px navigation |
| `vendor-generic` | Generic adapter badge. | `neutral` | 24px prominent / 20px navigation |

## Configuration

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `configuration` | Configuration management root. | `primary` | 24px prominent / 20px navigation |
| `backups` | Configuration backup management. | `primary` | 24px prominent / 20px navigation |
| `snapshots` | Configuration snapshot history. | `neutral` | 24px prominent / 20px navigation |
| `baselines` | Approved configuration baseline. | `success` | 24px prominent / 20px navigation |
| `drift` | Configuration drift detection. | `warning` | 24px prominent / 20px navigation |
| `compliance` | Configuration compliance status. | `success` | 24px prominent / 20px navigation |
| `restore` | Configuration restore workflow. | `warning` | 24px prominent / 20px navigation |
| `backup-policy` | Scheduled backup policy. | `neutral` | 24px prominent / 20px navigation |
| `config-viewer` | Raw configuration viewer. | `neutral` | 24px prominent / 20px navigation |
| `config-diff` | Configuration comparison and diff. | `neutral` | 24px prominent / 20px navigation |
| `normalize` | Normalized configuration comparison. | `neutral` | 24px prominent / 20px navigation |
| `checksum` | Configuration checksum / integrity. | `success` | 24px prominent / 20px navigation |
| `secret-mask` | Masked configuration secrets. | `neutral` | 24px prominent / 20px navigation |
| `download-config` | Download configuration snapshot. | `neutral` | 24px prominent / 20px navigation |

## Change Management

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `changes` | Change Management root. | `primary` | 24px prominent / 20px navigation |
| `all-changes` | All change requests. | `neutral` | 24px prominent / 20px navigation |
| `my-changes` | Changes owned or requested by the current user. | `neutral` | 24px prominent / 20px navigation |
| `approvals` | Pending or completed change approvals. | `info` | 24px prominent / 20px navigation |
| `change-calendar` | Scheduled change calendar. | `neutral` | 24px prominent / 20px navigation |
| `change-templates` | Reusable approved change templates. | `neutral` | 24px prominent / 20px navigation |
| `emergency-change` | Emergency change workflow. | `danger` | 24px prominent / 20px navigation |
| `risk-assessment` | Change risk scoring. | `warning` | 24px prominent / 20px navigation |
| `implementation-plan` | Method of procedure / implementation plan. | `neutral` | 24px prominent / 20px navigation |
| `pre-check` | Automated pre-change checks. | `info` | 24px prominent / 20px navigation |
| `execute-change` | Execute an approved network change. | `info` | 24px prominent / 20px navigation |
| `validation` | Post-change validation. | `success` | 24px prominent / 20px navigation |
| `rollback` | Rollback a failed or rejected change. | `warning` | 24px prominent / 20px navigation |
| `maintenance-window` | Approved network maintenance window. | `warning` | 24px prominent / 20px navigation |
| `change-audit` | Change-specific audit trail. | `neutral` | 24px prominent / 20px navigation |
| `change-correlation` | Correlate changes to incidents or alerts. | `neutral` | 24px prominent / 20px navigation |

## Operations

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `operations` | Operations domain root. | `primary` | 24px prominent / 20px navigation |
| `noc` | Network Operations Center. | `primary` | 24px prominent / 20px navigation |
| `alerts` | Operational alerts. | `danger` | 24px prominent / 20px navigation |
| `incidents` | Incident management. | `danger` | 24px prominent / 20px navigation |
| `maintenance` | Maintenance windows and suppressed monitoring. | `warning` | 24px prominent / 20px navigation |
| `events` | Network and system event stream. | `info` | 24px prominent / 20px navigation |
| `jobs` | Asynchronous device and reporting jobs. | `info` | 24px prominent / 20px navigation |
| `logs` | Device and system log explorer. | `neutral` | 24px prominent / 20px navigation |
| `incident-timeline` | Chronological incident timeline. | `neutral` | 24px prominent / 20px navigation |
| `incident-assignment` | Incident ownership / assignment. | `neutral` | 24px prominent / 20px navigation |
| `sla` | Incident SLA state and countdown. | `warning` | 24px prominent / 20px navigation |
| `root-cause-analysis` | Root cause analysis. | `neutral` | 24px prominent / 20px navigation |
| `post-incident-review` | Post-incident review / PIR. | `neutral` | 24px prominent / 20px navigation |
| `acknowledge` | Acknowledge an alert or incident. | `success` | 24px prominent / 20px navigation |
| `suppress` | Suppress alert during maintenance or correlation. | `warning` | 24px prominent / 20px navigation |
| `correlate` | Correlate related alerts, changes, and incidents. | `neutral` | 24px prominent / 20px navigation |

## Performance

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `performance` | Performance monitoring root. | `primary` | 24px prominent / 20px navigation |
| `metrics` | Time-series network metrics. | `info` | 24px prominent / 20px navigation |
| `availability` | Network/device availability. | `success` | 24px prominent / 20px navigation |
| `capacity` | Capacity and utilization risk. | `warning` | 24px prominent / 20px navigation |
| `latency` | Network latency. | `info` | 24px prominent / 20px navigation |
| `packet-loss` | Packet loss metric. | `warning` | 24px prominent / 20px navigation |
| `bandwidth` | Interface bandwidth and utilization. | `info` | 24px prominent / 20px navigation |
| `cpu` | Device CPU utilization. | `neutral` | 24px prominent / 20px navigation |
| `memory` | Device memory utilization. | `neutral` | 24px prominent / 20px navigation |
| `temperature` | Device temperature / environmental health. | `warning` | 24px prominent / 20px navigation |
| `power` | Power supply or device power status. | `neutral` | 24px prominent / 20px navigation |
| `fan` | Fan status. | `neutral` | 24px prominent / 20px navigation |
| `interface-errors` | Interface errors and discards. | `warning` | 24px prominent / 20px navigation |
| `trends` | Historical performance trends. | `info` | 24px prominent / 20px navigation |
| `health-score` | Aggregated device/network health score. | `success` | 24px prominent / 20px navigation |

## Reports

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `reports` | Reports module root. | `neutral` | 24px prominent / 20px navigation |
| `report-availability` | Availability report. | `neutral` | 24px prominent / 20px navigation |
| `report-performance` | Performance report. | `neutral` | 24px prominent / 20px navigation |
| `report-capacity` | Capacity report. | `neutral` | 24px prominent / 20px navigation |
| `report-incidents` | Incident report. | `neutral` | 24px prominent / 20px navigation |
| `report-changes` | Change-management report. | `neutral` | 24px prominent / 20px navigation |
| `report-backup-compliance` | Configuration backup-compliance report. | `neutral` | 24px prominent / 20px navigation |
| `report-drift` | Configuration-drift report. | `neutral` | 24px prominent / 20px navigation |
| `report-audit` | Audit report. | `neutral` | 24px prominent / 20px navigation |
| `scheduled-reports` | Scheduled report jobs. | `neutral` | 24px prominent / 20px navigation |
| `report-builder` | Custom report builder. | `neutral` | 24px prominent / 20px navigation |
| `export-pdf` | Export report as PDF. | `neutral` | 24px prominent / 20px navigation |
| `export-xlsx` | Export report as Excel/XLSX. | `neutral` | 24px prominent / 20px navigation |
| `export-csv` | Export report as CSV. | `neutral` | 24px prominent / 20px navigation |
| `export-json` | Export report as JSON. | `neutral` | 24px prominent / 20px navigation |

## Administration

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `administration` | Administration module root. | `neutral` | 24px prominent / 20px navigation |
| `organizations` | Organizations and organizational hierarchy. | `neutral` | 24px prominent / 20px navigation |
| `users` | User management. | `neutral` | 24px prominent / 20px navigation |
| `roles` | Role management. | `neutral` | 24px prominent / 20px navigation |
| `permissions` | Fine-grained permissions. | `neutral` | 24px prominent / 20px navigation |
| `credentials` | Credential and secret-profile management. | `neutral` | 24px prominent / 20px navigation |
| `api-clients` | Northbound API clients. | `neutral` | 24px prominent / 20px navigation |
| `webhooks` | Webhook integrations. | `neutral` | 24px prominent / 20px navigation |
| `notification-channels` | Email/webhook/other notification channels. | `neutral` | 24px prominent / 20px navigation |
| `collectors-admin` | Collector-node administration. | `neutral` | 24px prominent / 20px navigation |
| `device-drivers` | Device driver / adapter management. | `neutral` | 24px prominent / 20px navigation |
| `backup-storage` | Configuration-backup storage settings. | `neutral` | 24px prominent / 20px navigation |
| `retention` | Retention-policy settings. | `neutral` | 24px prominent / 20px navigation |
| `integrations` | External integrations. | `neutral` | 24px prominent / 20px navigation |
| `system-settings` | Platform system settings. | `neutral` | 24px prominent / 20px navigation |
| `audit` | Global immutable audit events. | `neutral` | 24px prominent / 20px navigation |
| `licensing` | License / entitlement management. | `neutral` | 24px prominent / 20px navigation |

## Actions

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `action-add` | Create or add a new resource. | `primary` | 18px buttons / 16px inline |
| `action-edit` | Edit resource metadata or configuration. | `neutral` | 18px buttons / 16px inline |
| `action-delete` | Delete a resource. Use only behind appropriate high-risk confirmation. | `danger` | 18px buttons / 16px inline |
| `action-search` | Search within current data. | `neutral` | 18px buttons / 16px inline |
| `action-filter` | Filter a table or dashboard. | `neutral` | 18px buttons / 16px inline |
| `action-refresh` | Refresh current data. | `neutral` | 18px buttons / 16px inline |
| `action-sync` | Synchronize data or state. | `info` | 18px buttons / 16px inline |
| `action-download` | Download file or export. | `neutral` | 18px buttons / 16px inline |
| `action-upload` | Upload/import file. | `neutral` | 18px buttons / 16px inline |
| `action-import` | Import data. | `neutral` | 18px buttons / 16px inline |
| `action-export` | Export data. | `neutral` | 18px buttons / 16px inline |
| `action-copy` | Copy value or object. | `neutral` | 18px buttons / 16px inline |
| `action-open` | Open an external or detailed view. | `neutral` | 18px buttons / 16px inline |
| `action-view` | View detailed content. | `neutral` | 18px buttons / 16px inline |
| `action-hide` | Hide/mask sensitive content. | `neutral` | 18px buttons / 16px inline |
| `action-terminal` | Open CLI/terminal view. | `neutral` | 18px buttons / 16px inline |
| `action-backup-now` | Trigger an immediate configuration backup. | `primary` | 18px buttons / 16px inline |
| `action-restore` | Request configuration restore. | `warning` | 18px buttons / 16px inline |
| `action-compare` | Compare snapshots/configurations. | `neutral` | 18px buttons / 16px inline |
| `action-validate` | Validate configuration, change, or device state. | `success` | 18px buttons / 16px inline |
| `action-execute` | Execute an approved operation. | `info` | 18px buttons / 16px inline |
| `action-pause` | Pause or suppress a job/alert. | `warning` | 18px buttons / 16px inline |
| `action-resume` | Resume a paused operation. | `info` | 18px buttons / 16px inline |
| `action-cancel` | Cancel an operation. | `danger` | 18px buttons / 16px inline |
| `action-rollback` | Rollback an operation or change. | `warning` | 18px buttons / 16px inline |
| `action-test-connection` | Test device/API connectivity. | `info` | 18px buttons / 16px inline |
| `action-lock` | Lock or protect a resource. | `neutral` | 18px buttons / 16px inline |
| `action-rotate-secret` | Rotate a credential or API secret. | `warning` | 18px buttons / 16px inline |
| `action-revoke` | Revoke a credential, token, or access grant. | `danger` | 18px buttons / 16px inline |
| `action-schedule` | Schedule an operation. | `neutral` | 18px buttons / 16px inline |

## Statuses

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `status-online` | Device or collector is online. | `success` | 16px table / 20px status |
| `status-offline` | Device or collector is offline. | `danger` | 16px table / 20px status |
| `status-degraded` | Service or device is degraded. | `warning` | 16px table / 20px status |
| `status-maintenance` | Resource is in maintenance. | `warning` | 16px table / 20px status |
| `status-unknown` | Current status is unknown. | `neutral` | 16px table / 20px status |
| `status-unmanaged` | Resource is discovered but not actively managed. | `neutral` | 16px table / 20px status |
| `status-success` | Generic successful operation. | `success` | 16px table / 20px status |
| `status-warning` | Generic warning state. | `warning` | 16px table / 20px status |
| `status-danger` | Generic dangerous or failed state. | `danger` | 16px table / 20px status |
| `status-info` | Generic informational state. | `info` | 16px table / 20px status |
| `status-running` | Job/change is currently running. | `info` | 16px table / 20px status |
| `status-scheduled` | Operation is scheduled. | `info` | 16px table / 20px status |
| `status-pending` | Awaiting action or approval. | `warning` | 16px table / 20px status |
| `status-approved` | Change or request approved. | `success` | 16px table / 20px status |
| `status-rejected` | Change or request rejected. | `danger` | 16px table / 20px status |
| `status-completed` | Operation completed. | `success` | 16px table / 20px status |
| `status-failed` | Operation failed. | `danger` | 16px table / 20px status |
| `status-rollback-required` | Rollback is required. | `danger` | 16px table / 20px status |
| `status-drift-detected` | Configuration drift detected. | `warning` | 16px table / 20px status |
| `status-compliant` | Configuration/resource is compliant. | `success` | 16px table / 20px status |
| `status-noncompliant` | Configuration/resource is non-compliant. | `danger` | 16px table / 20px status |
| `severity-critical` | Critical incident/alert severity. | `danger` | 16px table / 20px status |
| `severity-high` | High incident/alert severity. | `danger` | 16px table / 20px status |
| `severity-medium` | Medium incident/alert severity. | `warning` | 16px table / 20px status |
| `severity-low` | Low incident/alert severity. | `info` | 16px table / 20px status |
| `severity-info` | Informational incident/alert severity. | `neutral` | 16px table / 20px status |

## Network Technologies

| Icon | Description | Semantic | Recommended |
|---|---|---|---|
| `bgp` | BGP routing protocol. | `neutral` | 24px prominent / 20px navigation |
| `ospf` | OSPF routing protocol. | `neutral` | 24px prominent / 20px navigation |
| `dhcp` | DHCP service/configuration. | `neutral` | 24px prominent / 20px navigation |
| `dns` | DNS service/configuration. | `neutral` | 24px prominent / 20px navigation |
| `nat` | NAT policy/configuration. | `neutral` | 24px prominent / 20px navigation |
| `acl` | Access control list. | `neutral` | 24px prominent / 20px navigation |
| `firewall-policy` | Firewall policy/rule. | `neutral` | 24px prominent / 20px navigation |
| `nat-policy` | Network address translation policy. | `neutral` | 24px prominent / 20px navigation |
| `static-route` | Static route. | `neutral` | 24px prominent / 20px navigation |
| `link-aggregation` | LAG/LACP bundle. | `neutral` | 24px prominent / 20px navigation |
| `stp` | Spanning-tree topology. | `neutral` | 24px prominent / 20px navigation |
| `lldp` | LLDP neighbor discovery. | `neutral` | 24px prominent / 20px navigation |
| `cdp` | Cisco Discovery Protocol neighbor data. | `neutral` | 24px prominent / 20px navigation |
| `ntp` | NTP time synchronization. | `neutral` | 24px prominent / 20px navigation |
| `dns-server` | DNS server configuration. | `neutral` | 24px prominent / 20px navigation |

---

## Kit v2 additions (12)

Phase B1 closed the gaps the 2026-09-10 brand audit found in the v1 kit: sidebar views, driver
registry entries and product surfaces that existed in the app but had no governed glyph. The
following 12 masters were added under the same geometry/color contract; each has a one-line
semantics below and a governed consumer (sidebar, registry or surface component).

| Icon | Semantics | Consumer |
|---|---|---|
| `firmware` | Firmware lifecycle management (EOS/EOL tracking, guarded upgrade execution). | `network.firmware` sidebar view |
| `zero-touch-provisioning` | Zero-touch provisioning (ZTP claims → worker → device registration). | `network.ztp` sidebar view |
| `cmdb` | Configuration management database (CI register, relations, impact analysis). | `config.cmdb` sidebar view |
| `flow-analytics` | NetFlow/IPFIX flow analytics (top talkers/protocols). | `perf.flows` sidebar view |
| `predictive-health` | ML-assisted health forecasting for managed devices. | `perf.predictive` sidebar view |
| `vendor-juniper` | Juniper Networks platform adapter badge — FayaNMS project adapter glyph, not the vendor logo. | `juniper` vendor key in `vendorIconFor()` |
| `vendor-palo-alto` | Palo Alto Networks platform adapter badge — FayaNMS project adapter glyph, not the vendor logo. | `palo` vendor key in `vendorIconFor()` |
| `ask-network` | "Ask the network" — AI natural-language query over grounded, read-only network data. | AI query dialog |
| `ai-rca` | AI root-cause-analysis drafting (suggested RCA text for incidents/changes, human-approved). | AI RCA drafting surface |
| `collector-rebalance` | Deterministic collector fleet redistribution (guarded rebalance plan/apply). | Collector admin action |
| `failover-test` | HA/DR staged failover testing (topology probe → staged execution → result). | `ops.ha` failover-test flow |
| `configuration-encrypted` | Encrypted/protected configuration artifact (AES-256-GCM at rest). | Encrypted snapshot surfaces |

**Final governed count: 228 icons** — 216 v1 masters + 12 v2 additions.

Notes:

- The "`Total icons:` 216" line at the top of this document reflects kit v1 at publication time and is preserved verbatim from the canonical kit catalog; the governed total since Phase B1 is 228.
- Governance for these additions (validation, registries, renderer) is specified in [ICONOGRAPHY.md](./ICONOGRAPHY.md) and [ASSET-MANIFEST.md](./ASSET-MANIFEST.md); the runtime name union (`FayanmsIconName`) is generated from the directory and must stay in sync via `bun run brand:validate-icons`.
