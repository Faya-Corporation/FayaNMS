# Network protocol lab runbook

## Safety boundary

The OCI staging host must connect only to a dedicated lab VLAN or VPN. Do not route this lab into production management networks. Keep all telemetry listeners closed until an authenticated/restricted receiver exists.

## Current repository evidence

The worker has protocol certification harnesses for selected SSH flows. The production monitoring plane does not yet implement real SNMP/ICMP polling, traps, syslog, flow ingestion, or continuous discovery. Dashboards must not be described as live network truth.

## Lab sequence

1. Create the isolated Docker internal network with deploy/lab/bootstrap.sh.
2. Add disposable protocol agents only after their image digest and source are reviewed.
3. Test protocol parsing and deduplication with malformed, duplicate, and burst inputs.
4. Restrict any host/VPN listener to the lab CIDR and approved exporter addresses.
5. Capture packet-level, application, queue, and alert evidence.
6. Run the same test against each supported hardware model where product claims require it.
7. Tear down the disposable fixture and confirm no production route remains.

## External values

The lab CIDR, VPN peer, firewall rules, exporter addresses, hardware inventory, and credentials are external operator actions. Record them in the protected environment inventory, never this repository.
