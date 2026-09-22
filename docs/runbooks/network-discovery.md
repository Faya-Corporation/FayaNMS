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

## Continuous policy scheduling

Continuous scans are disabled until an operator creates and enables a discovery policy through the authenticated discovery-policy API. A policy contains only:

- up to four IPv4 /24-/32 subnets (maximum 1,024 targets per job);
- the approved TCP management ports 22, 80, 443, and 830;
- an interval from 5 to 1,440 minutes.

The jobs scheduler deduplicates each policy with a database lease and queues a normal DISCOVERY job. The worker persists one bounded DiscoveryObservation per reachable candidate and exact management-IP matches update the known device lastSeen timestamp. Reverse DNS, TCP reachability, and the generic vendor marker remain evidence only; they never create a device, select a credential, infer an SNMP identity, or create a topology edge. Candidate import remains an explicit operator action.

The topology API exposes recent matched discovery evidence separately from its existing CMDB/HA graph. Existing simulated uplink edges remain visibly simulated until authenticated LLDP/CDP, ARP/FDB, or equivalent vendor-certified evidence exists. This repository slice therefore proves bounded continuous observation and reconciliation plumbing, not live topology truth.

Evidence state: implemented, unit tested, CI certified after the exact branch head passes; staging, SNMP identity, vendor, physical-hardware, and production proof remain open.
