# OCI and lab network policy

This document is a repository-side policy template. The actual NSG, host firewall, VPN, and exporter CIDRs must be applied and read back by the operator.

## Public ingress

| Port | Protocol | Source | Purpose | Status |
|---:|---|---|---|---|
| 80 | TCP | approved certificate/redirect sources | HTTP to HTTPS redirect and ACME flow | allowed only on Caddy |
| 443 | TCP | approved user ranges | FayaNMS HTTPS | required |
| 22 | TCP | administrator IP/range only | SSH administration | restricted |
| 5432 | TCP | none | PostgreSQL | denied |
| 3000 | TCP | none | app internal port | denied |
| 3030 | TCP | none | worker internal port | denied |
| 9090 | TCP | none | Prometheus internal port | denied |
| 3001 | TCP | none | Grafana/internal UI | denied |

## Conditional lab ingress

Do not open these until the corresponding receiver exists and is tested:

| Port | Protocol | Source restriction |
|---:|---|---|
| 162 | UDP | lab/VPN SNMP exporter CIDRs only |
| 514 | UDP/TCP | lab/VPN syslog sender CIDRs only |
| 2055 | UDP | approved NetFlow exporter CIDRs only |
| 4739 | UDP | approved IPFIX exporter CIDRs only |
| 6343 | UDP | approved sFlow exporter CIDRs only |

Never use 0.0.0.0/0 for telemetry listeners. Keep the OCI host out of production management routes until the isolated lab certification gate passes.
