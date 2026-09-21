# Bounded network discovery

FayaNMS discovery is an opt-in worker job. It scans only IPv4 /24-/32 ranges, at
most 256 targets per subnet and 1,024 targets per job. The worker probes the
approved TCP management ports 22, 80, 443, and 830 with short timeouts and
performs reverse DNS only for reachable targets.

A result is a wire-derived reachability candidate. It may include an open TCP
port and a reverse-DNS name, but it intentionally reports vendor generic and
does not claim SNMP identity, credentials, model, or operating system. Those
claims require a separate authenticated SNMPv3/polling workflow and isolated
lab evidence.

The discovery API rejects broad subnets. The listener set is outbound-only;
no telemetry port is opened by discovery. Operators must restrict ranges to
owned lab/VPN address space and retain the scan correlation ID. Empty results
are valid and are not replaced with simulated candidates.

Evidence state: implemented, unit tested, CI certified after the exact branch
head passes; staging, physical-hardware, and production proof remain open.
