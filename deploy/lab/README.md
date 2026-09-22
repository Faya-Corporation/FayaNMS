# Network protocol lab

This directory defines an isolated packet-level protocol fixture boundary. The fixtures emit real wire-format packets to a lab destination; they are not production collectors and are never enabled by the OCI app profile.

## Current implementation

- Internal-only Docker network bootstrap: repository automation present.
- Dependency-free packet fixtures: RFC3164/RFC5424 syslog, SNMPv1/v2c traps, NetFlow v5, NetFlow v9 templates, IPFIX templates, and sFlow counter samples.
- Loopback UDP integration test: CI sends and receives a real RFC5424 datagram.
- External destination safety: the generator rejects non-loopback targets unless FAYANMS_PROTOCOL_LAB_ALLOW_NON_LOOPBACK=true is set for an operator-approved isolated lab CIDR.
- Disposable SNMPv3 authPriv loopback agent: implemented and tested under scripts/protocol-lab/snmpv3.ts with per-run random test secrets; it is not a production collector and binds only to 127.0.0.1.
- Opt-in worker UDP relay: NetFlow v5 is decoded and persisted through the authenticated durable queue; it is disabled by default and does not prove physical exporter interoperability or production readiness.
- Continuous discovery and production collector HA: not implemented; no production readiness claim.
- Existing SSH vendor harnesses remain separate from this packet fixture set.

Run the protocol fixture tests:

~~~bash
bun test tests/protocol-lab.test.ts tests/snmpv3-lab.test.ts
~~~

Emit one packet to an isolated local receiver:

~~~bash
bun run scripts/protocol-lab/generate.ts --protocol=syslog5424 --host=127.0.0.1 --port=5514
~~~

Supported protocols are syslog3164, syslog5424, snmp-v1-trap, snmp-v2c-trap, netflow-v5, netflow-v9-template, ipfix-template, and sflow-counter. Use --count=N for a controlled burst. Do not set the external-target override outside the isolated lab.

## Promotion requirement

A protocol capability becomes DONE only with code, unit/contract tests, packet/protocol harness evidence, staging evidence, and—where the capability claims hardware support—physical-device evidence.
