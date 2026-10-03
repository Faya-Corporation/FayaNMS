# Network protocol lab runbook

## Safety boundary

The OCI staging host must connect only to a dedicated lab VLAN or VPN. Do not route this lab into production management networks. The worker UDP collector is disabled by default and binds to loopback by default; enable a listener only behind an isolated network and explicit exporter/firewall allowlists.

## Current repository evidence

The worker has protocol certification harnesses for selected SSH flows. The repository also contains dependency-free packet fixtures under scripts/protocol-lab for RFC3164/RFC5424 syslog, SNMPv1/v2c traps, NetFlow v5/v9, IPFIX, and sFlow, with loopback UDP coverage, plus a disposable SNMPv3 authPriv loopback agent. The opt-in worker receiver now decodes NetFlow v5 into a bounded durable flow queue; this does not certify physical exporters, collector HA, production operation, or continuous discovery. The simulated `/api/v1/flows` endpoint remains simulated. Dashboards must not be described as live network truth.

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

The worker contains an opt-in UDP receiver and authenticated relay. It is disabled unless FAYANMS_PROTOCOL_COLLECTOR_ENABLED=true, binds to 127.0.0.1 by default, uses non-privileged ports, bounds packets and relay concurrency, and sends normalized events to POST /api/v1/ingest/protocol with the worker service identity's telemetry scope. Relay retries re-send the same normalized event and carry no client idempotency key; NetFlow v5 batches are deduped server-side on the derived (collector, exporter peer, flowSequence, export timestamp) key within the queue-retention window, while other protocols keep at-least-once semantics (see the NetFlow v5 runbook, "Idempotency (F-048)").

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

The ingestion boundary is fail-closed for SNMP traps: the generic worker BER-framing path marks securityLevel=unknown and is rejected. Accepted SNMP traps must carry a server-side verified authPriv result, an explicit credentialProfileId, an exact associated device, and a CredentialProfile of type SNMPV3 bound to that device. The profile contains only the vault secret reference; the passphrase is never sent in the event or stored in audit JSON. The disposable scripts/protocol-lab/snmpv3.ts harness now proves authPriv trap verification and tamper rejection, but it does not constitute device or staging evidence.

SNMPv3 vault resolution is cached per credential profile (F-037): the worker resolves a profile's `secretRef` once and reuses the resolved secret for that profile for a short TTL (default 30 seconds; `FAYANMS_SNMPV3_SECRET_CACHE_TTL_MS`, clamped 250ms–600s), so a packet storm for one persona costs one vault round-trip per TTL window instead of one per datagram. Concurrent packets for the same profile share a single in-flight resolution (single-flight). Rotation semantics: for at most one TTL window after a vault secret is rotated the worker may keep verifying with the previous secret — those traps fail USM authentication and are counted as rejected (fail-closed; a wrong secret can never produce a wrong-accept). The cache is keyed by credential profile id + secret reference, is bounded to 256 entries, is cleared when the collector stops, and resolved secret values are never logged. The worker's `fayanms_worker_protocol_collector_up` metric is 1 only when the collector is enabled and every configured UDP socket is bound with no bind failure; a bind failure (for example EADDRINUSE or EACCES) reports 0 and raises the `FayanmsWorkerProtocolCollectorDown` starter alert after 5 minutes.

### Durable handoff behavior

The authenticated ingest route writes a normalized ProtocolEventQueue row and its PROTOCOL_EVENT_QUEUED audit record in one database transaction. It stores bounded fields and serialized normalized attributes only; it never stores raw UDP bytes or secret material. Valid NetFlow v5 records are stored as a typed batch, then inserted atomically during drain with the queue delivery and audit update. The worker scheduler drains through the jobs-scoped endpoint. Each row uses a short claim lease, bounded exponential retry (5 seconds through a 15-minute cap), and a five-attempt dead-letter boundary. Successful delivery writes PROTOCOL_EVENT_RECEIVED; terminal failures write PROTOCOL_EVENT_DEAD_LETTERED with sanitized error text. The opt-in UDP collector also keeps a bounded in-memory relay retry queue for transient API failures before the durable database handoff. See the [NetFlow v5 runbook](netflow-v5.md) for listener and retention operations.

Queue delivery currently proves durable normalized event retention/audit delivery. It does not by itself prove live alert fan-out, continuous discovery, collector HA, OCI staging, physical-vendor interoperability, or production operation.

SNMPv3 engine IDs are operator-enrolled on the Device record through the authenticated device PATCH contract (snmpEngineIdHex). Enrollment resets boots/time state. The worker-side profile lookup refuses unenrolled devices; after authPriv verification, the acceptance route atomically advances the pinned engine boots/time and rejects older or equal observations. This is a replay/timeliness control, not physical-device or staging proof.

Continuous discovery, collector HA, staging scrape evidence, and physical-device proof remain open.
