# Network protocol lab runbook

## Safety boundary

The OCI staging host must connect only to a dedicated lab VLAN or VPN. Do not route this lab into production management networks. Keep all telemetry listeners closed until an authenticated/restricted receiver exists.

## Current repository evidence

The worker has protocol certification harnesses for selected SSH flows. The repository now also contains dependency-free packet fixtures under scripts/protocol-lab for RFC3164/RFC5424 syslog, SNMPv1/v2c traps, NetFlow v5/v9, IPFIX, and sFlow, with loopback UDP coverage. The repository now also has a disposable SNMPv3 authPriv loopback agent with per-run random test secrets and an end-to-end encrypted/authenticated GET test. The production monitoring plane still does not implement real traps/syslog/flow receivers or continuous discovery. Dashboards must not be described as live network truth.

## Lab sequence

1. Create the isolated Docker internal network with deploy/lab/bootstrap.sh.
2. Add disposable protocol agents only after their image digest and source are reviewed.
3. Run bun test tests/protocol-lab.test.ts and use scripts/protocol-lab/generate.ts to send controlled, duplicate, burst, and malformed-payload cases to a disposable receiver.
4. Restrict any host/VPN listener to the lab CIDR and approved exporter addresses.
5. Capture packet-level, application, queue, and alert evidence.
6. Run the same test against each supported hardware model where product claims require it.
7. Tear down the disposable fixture and confirm no production route remains. The generator rejects non-loopback targets unless the isolated-lab override is explicitly set.

## External values

The lab CIDR, VPN peer, firewall rules, exporter addresses, hardware inventory, and credentials are external operator actions. Record them in the protected environment inventory, never this repository.

## Optional repository-side collector relay

The worker contains an opt-in UDP receiver and authenticated relay. It is disabled unless FAYANMS_PROTOCOL_COLLECTOR_ENABLED=true, binds to 127.0.0.1 by default, uses non-privileged ports, bounds packets and relay concurrency, and sends normalized events to POST /api/v1/ingest/protocol with the worker service identity's telemetry scope.

Set an explicit lab bind address and ports only on the operator host:

~~~bash
export FAYANMS_PROTOCOL_COLLECTOR_ENABLED=true
export FAYANMS_PROTOCOL_COLLECTOR_BIND=127.0.0.1
export FAYANMS_SYSLOG_PORT=5514
export FAYANMS_SNMP_TRAP_PORT=1162
export FAYANMS_NETFLOW_PORT=2055
export FAYANMS_IPFIX_PORT=4739
export FAYANMS_SFLOW_PORT=6343
~~~

Device association is advisory and ordered: exact hostname hint first, exact management IP second. UDP source identity is not trusted as proof of device identity. Unmatched events remain retained as unassociated ProtocolEvent audit history. Raw packets, communities, passphrases, and other secret material are never accepted by the ingestion contract.

SNMPv3 authentication/privacy verification remains a protocol-lab capability only; the production receiver still requires a separately certified SNMPv3 trap decoder and device credential/profile policy. Continuous discovery, collector HA, staging scrape evidence, and physical-device proof remain open.
